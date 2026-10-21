import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {access,lstat,readFile,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {runtimePaths} from '../core/runtime-paths.ts';
import {SessionError,type ProcessIdentity,type SessionInfo} from './contracts.ts';
import {readJson} from './journal.ts';

const execute=promisify(execFile);
type ProcessRow=ProcessIdentity&{ppid:number;uid:number;lastArgumentSha256:string;state:string};
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const sha256=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const qualified=(row:ProcessRow)=>row.pgid>=0&&!!row.startedAt&&sha256(row.commandSha256);
export async function verifyProcessReader(){
  const {runtimeRoot}=runtimePaths(),executable=join(runtimeRoot,'native/walkthrough-process-reader');
  try{
    const manifest=await readJson<{schemaVersion:number;platform:string;arch:string;sourceSha256:string;binarySha256:string}>(join(runtimeRoot,'native/process-reader.json'));
    const mode=await lstat(executable);
    if(manifest.schemaVersion!==1||manifest.platform!==process.platform||manifest.arch!==process.arch||!mode.isFile()||(mode.mode&0o7777)!==0o755||manifest.binarySha256!==hash(await readFile(executable))||manifest.sourceSha256!==hash(await readFile(join(runtimeRoot,'src/session/native/process-reader.c'))))throw new Error('identity-mismatch');
    return {executable,...manifest};
  }catch{throw new SessionError('SESSION_PROCESS_READER_NOT_PROVISIONED','The packaged non-privileged process reader is missing or changed. Restore the exact installed release, or explicitly run scripts/provision-session.mjs in a development checkout. No worker was started or signalled.');}
}
export async function processTable():Promise<ProcessRow[]>{
  const {executable}=await verifyProcessReader();
  const {stdout}=await execute(executable,[],{env:{PATH:'/usr/bin:/bin'},maxBuffer:16*1024*1024,timeout:10000});
  let value:unknown;try{value=JSON.parse(stdout);}catch{throw new SessionError('SESSION_PROCESS_SNAPSHOT_INVALID');}
  const rows=(value as {schemaVersion?:unknown;processes?:unknown})?.processes;
  if((value as {schemaVersion?:unknown})?.schemaVersion!==1||!Array.isArray(rows)||rows.length>262144)throw new SessionError('SESSION_PROCESS_SNAPSHOT_INVALID');
  const seen=new Set<number>();
  for(const row of rows){
    if(!row||!Number.isSafeInteger(row.pid)||row.pid<1||seen.has(row.pid)||!Number.isSafeInteger(row.ppid)||row.ppid<0||!Number.isSafeInteger(row.pgid)||row.pgid< -1||!Number.isSafeInteger(row.uid)||row.uid< -1||!['A','Z','?'].includes(row.state)||typeof row.startedAt!=='string'||!/^([0-9]+:[0-9]+)?$/.test(row.startedAt)||![row.commandSha256,row.lastArgumentSha256].every(value=>value===''||sha256(value)))throw new SessionError('SESSION_PROCESS_SNAPSHOT_INVALID');
    seen.add(row.pid);
  }
  if(rows.some(row=>row.pgid<0))throw new SessionError('SESSION_PROCESS_SNAPSHOT_INCOMPLETE','A surviving process has no readable group identity. No process was signalled; inspect this same session again after that identity becomes readable.');
  return rows as ProcessRow[];
}
const identity=(row:ProcessRow):ProcessIdentity=>({pid:row.pid,pgid:row.pgid,startedAt:row.startedAt,commandSha256:row.commandSha256});
const same=(a:ProcessIdentity,b:ProcessIdentity)=>!!a.startedAt&&sha256(a.commandSha256)&&a.pid===b.pid&&a.pgid===b.pgid&&a.startedAt===b.startedAt&&a.commandSha256===b.commandSha256;
const active=(row:ProcessRow)=>!row.state.startsWith('Z');

/** Reserve the launcher lifetime before any record can outlive its caller.
 * Unlike the worker it need not own a process group; this is absence evidence,
 * never permission to signal the coordinator or its group. */
export async function retainLaunchIdentity():Promise<ProcessIdentity>{
  const row=(await processTable()).find(row=>row.pid===process.pid);
  if(!row||!qualified(row)||!active(row))throw new SessionError('SESSION_LAUNCH_IDENTITY_UNAVAILABLE');
  return identity(row);
}

export async function retainWorkerIdentity(info:SessionInfo){
  const row=(await processTable()).find(row=>row.pid===process.pid);
  if(!row||!qualified(row)||row.pgid!==process.pid||!info.workerToken||row.lastArgumentSha256!==hash(info.workerToken))throw new SessionError('SESSION_PROCESS_IDENTITY_UNAVAILABLE');
  info.pid=process.pid;info.processIdentity=identity(row);info.processes=[identity(row)];
}
export async function retainProcessGroup(info:SessionInfo){
  if(!info.processIdentity)return;
  const table=await processTable(),worker=table.find(row=>row.pid===info.processIdentity!.pid);
  if(!worker||!same(worker,info.processIdentity))throw new SessionError('SESSION_PROCESS_IDENTITY_CHANGED');
  const known=new Map((info.processes??[]).map(row=>[row.pid,row]));
  for(const row of table.filter(row=>row.pgid===worker.pgid&&qualified(row)))known.set(row.pid,identity(row));
  info.processes=[...known.values()];
}

export async function inspectWorker(info:SessionInfo){
  let table=await processTable();const expected=info.processIdentity;
  if(!expected){
    const launch=info.launchIdentity;
    const launchKnown=!!launch&&Number.isSafeInteger(launch.pid)&&launch.pid>0&&Number.isSafeInteger(launch.pgid)&&launch.pgid>=0&&/^\d+:\d+$/.test(launch.startedAt)&&sha256(launch.commandSha256);
    const launcher=launchKnown?table.find(row=>row.pid===launch.pid):undefined;
    // A changed command/group is not process death: that same lifetime may
    // still spawn. Only absence, a zombie, or a known different PID occupant
    // establishes that the original coordinator cannot launch another worker.
    const launchStopped=launchKnown&&(!launcher||!active(launcher)||!!launcher.startedAt&&launcher.startedAt!==launch.startedAt);
    // A process-table enumeration is not atomic. First prove the launcher is
    // gone, then enumerate its possible worker: a child spawned after the first
    // enumeration began must not disappear between those two observations.
    if(launchStopped)table=await processTable();
    const starting=info.workerToken&&table.find(row=>active(row)&&row.lastArgumentSha256===hash(info.workerToken!));
    // The worker durably saves identity before entering SessionRuntime.open.
    // After the launcher's death, no token worker, no unreadable possible worker
    // and no runtime marker prove a pre-browser terminal launch. Historical
    // records without launcher identity cannot supply this missing proof.
    const marker=await access(join(runtimePaths().activeRoot,`${info.sessionId}.json`)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
    const unreadable=table.some(row=>active(row)&&(row.uid===process.getuid?.()||row.uid<0)&&!row.lastArgumentSha256);
    const stopped=!!info.workerToken&&launchStopped&&!starting&&!unreadable&&!marker;
    return {worker:starting?'running':stopped?'stopped':'unresolved',members:[] as ProcessRow[]};
  }
  const row=table.find(row=>row.pid===expected.pid),worker=row&&active(row)&&same(row,expected)?'running':'stopped';
  return {worker,members:table.filter(row=>row.pgid===expected.pgid&&active(row))};
}

/** Only the original identities and their current descendants may be stopped.
 * Never send a signal to a bare saved PID/process-group number. */
export async function settleStoppedWorker(info:SessionInfo){
  let state=await inspectWorker(info);
  if(state.worker==='running')throw new SessionError('SESSION_WORKER_UNREACHABLE','The original worker still exists but its socket is unavailable. Keep this session and inspect its worker log; no process was restarted or signalled.');
  if(state.worker==='unresolved'&&info.status!=='closed')throw new SessionError('SESSION_LAUNCH_UNRESOLVED','The original launch cannot yet be proved stopped. Inspect this same session and its worker log; no new worker was started or unknown process signalled.');
  const admitted=new Map((info.processes??[]).map(row=>[row.pid,row]));
  const qualify=(members:ProcessRow[])=>{
    const verified=new Set(members.filter(row=>admitted.has(row.pid)&&same(row,admitted.get(row.pid)!)).map(row=>row.pid));
    let changed=true;while(changed){changed=false;for(const row of members)if(qualified(row)&&!verified.has(row.pid)&&verified.has(row.ppid)){verified.add(row.pid);admitted.set(row.pid,identity(row));changed=true;}}
    if(members.some(row=>!verified.has(row.pid)))throw new SessionError('SESSION_PROCESS_CUSTODY_UNCERTAIN','The original process group contains an unrecognized process. Keep the session marker and inspect the retained process identities; no unknown process was signalled.');
  };
  qualify(state.members);
  for(const signal of ['SIGTERM','SIGKILL'] as const){
    for(const member of state.members){
      const current=(await processTable()).find(row=>row.pid===member.pid&&active(row));
      if(!current)continue;
      // Stopping a parent can put its children into an exiting state whose
      // command no longer matches. Never signal that changed identity; wait for
      // the group to drain and qualify every survivor before another signal.
      if(!same(member,current))continue;
      try{process.kill(current.pid,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
    }
    for(let attempt=0;attempt<30;attempt++){
      state=await inspectWorker(info);if(!state.members.length)return;
      await delay(50);
    }
    qualify(state.members);
  }
  throw new SessionError('SESSION_PROCESS_STOP_UNCERTAIN','The original browser processes have not stopped. Keep the marker and close this same session again after inspecting those processes.');
}

export async function removeSessionMarker(info:SessionInfo){
  const path=join(runtimePaths().activeRoot,`${info.sessionId}.json`);
  const marker=await readJson<{kind:string;sessionId:string;projectPath:string;workerToken?:string}>(path).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(!marker)return;
  if(marker.kind!=='session'||marker.sessionId!==info.sessionId||marker.projectPath!==info.projectPath||!info.workerToken||marker.workerToken!==info.workerToken)throw new SessionError('SESSION_MARKER_IDENTITY_CONFLICT');
  await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
}
