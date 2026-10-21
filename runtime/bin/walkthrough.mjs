#!/usr/bin/env node
import {spawn,spawnSync} from 'node:child_process';
import {dirname,resolve,join,basename,isAbsolute} from 'node:path';
import {constants,readFileSync,realpathSync,openSync,fstatSync,closeSync,writeSync,mkdirSync,writeFileSync,existsSync,unlinkSync,renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {runtimePaths} from '../src/core/runtime-paths.ts';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
// Metadata calls have no operation to supervise. In particular, an unwritable
// state directory or pending install must not prevent reading help/version.
const metadata=args.length===0||args[0]==='help'||args[0]==='--help'||args[0]==='-h'||args[0]==='--version';
if(metadata){
  const read=spawnSync(process.execPath,[resolve(root,'src/cli.ts'),...args],{stdio:'inherit'});
  if(read.error){console.log(JSON.stringify({schemaVersion:1,status:'failed',error:{code:'METADATA_UNAVAILABLE',owner:'runtime',recovery:'Use a qualified Node runtime to read the installed help and version. No operational state was written.'}}));}
  process.exit(read.status??1);
}
let runtime;
try{runtime=runtimePaths();}catch{console.log(JSON.stringify({schemaVersion:1,status:'failed',error:{code:'RUNTIME_ABSOLUTE_STATE_PATH_REQUIRED',owner:'runtime',recovery:'Use absolute normalized Walkthrough state and settings directories.'}}));process.exit(1);}
const callerCwd=process.cwd();
for(const flag of ['--project','--path','--brief','--input','--edit','--candidate','--attempt','--out']){
  const index=args.indexOf(flag);
  if(index>=0&&args[index+1]&&!args[index+1].startsWith('--'))args[index+1]=resolve(args[index+1]);
}
// Operational commands retain process custody. Web means ordinary browser
// networking; document origins are checked by the session, not an API firewall.
let sandboxArgs=['-f',resolve(root,'scripts/loopback-only.sb')];
const projectIndex=args.indexOf('--project');
let projectRoot;
const activityPath=join(runtime.activeRoot,`command-${process.pid}-${randomUUID()}.json`);
const pendingInstallation=join(runtime.stateRoot,'installation-pending.json');
let coordinatorPid;
let activitySettled=false;
const activeGroupPids=new Set();
function retainActivity(status='running'){
  const temporary=activityPath+'.next';
  writeFileSync(temporary,JSON.stringify({schemaVersion:1,kind:'command',pid:process.pid,projectPath:projectRoot??null,status,...(coordinatorPid?{coordinatorPid}:{}),processGroupIds:[...activeGroupPids]}),{mode:0o600});
  renameSync(temporary,activityPath);
}
try{
  if(existsSync(pendingInstallation))throw Object.assign(new Error('install-pending'),{code:'INSTALL_RECOVERY_REQUIRED',owner:'installation',recovery:'Let the installer finish or recover its recorded transaction before starting Walkthrough.'});
  if(existsSync(join(runtime.stateRoot,'setup-pending.json'))&&!(args[0]==='setup'&&['inspect','apply'].includes(args[1])))throw Object.assign(new Error('setup-pending'),{code:'SETUP_RECOVERY_REQUIRED',owner:'setup',recovery:'Inspect setup and rejoin setup apply with its original candidate and digest before starting other work.'});
  if(projectIndex>=0&&args[projectIndex+1])projectRoot=realpathSync(args[projectIndex+1]);
  if(args[0]==='session'&&args[1]==='open'&&projectRoot){
    const project=JSON.parse(readFileSync(join(projectRoot,'project.json'),'utf8'));
    if(project.schemaVersion!==1||project.kind!=='walkthrough-project'||!['web','loopback-only'].includes(project.mandate?.network))throw new Error('project-mandate-invalid');
    if(project.mandate.network==='web')sandboxArgs=['-p','(version 1)(allow default)'];
  }
  try{
    mkdirSync(runtime.activeRoot,{recursive:true,mode:0o700});
    writeFileSync(activityPath,JSON.stringify({schemaVersion:1,kind:'command',pid:process.pid,projectPath:projectRoot??null}),{flag:'wx',mode:0o600});
  }catch(error){
    const denied=['EPERM','EACCES','EROFS'].includes(error?.code);
    throw Object.assign(new Error('runtime-state-unavailable'),{code:denied?'HOST_STATE_NOT_WRITABLE':'RUNTIME_STATE_UNAVAILABLE',owner:'runtime',recovery:`Walkthrough could not retain command state in ${JSON.stringify(runtime.activeRoot)}. ${denied?'Ask the host owner to provide an authorized execution context that permits this state directory. Do not redirect state to bypass a host restriction.':'Restore this local state directory before continuing.'} No application or composition was started by this command.`});
  }
  if(existsSync(pendingInstallation))throw Object.assign(new Error('install-pending'),{code:'INSTALL_RECOVERY_REQUIRED',owner:'installation',recovery:'The installer acquired custody before this command. Let it finish before retrying.'});
}catch(error){
  try{if(existsSync(activityPath))unlinkSync(activityPath);}catch{/* Retain an inaccessible marker; do not hide the original startup failure. */}
  const safe=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{2,80}$/.test(error.code)&&typeof error?.owner==='string'&&typeof error?.recovery==='string';
  console.log(JSON.stringify({schemaVersion:1,status:'failed',error:safe?{code:error.code,owner:error.owner,recovery:error.recovery}:{code:'PROJECT_AUTHORITY_UNAVAILABLE',owner:'project',recovery:'Restore the selected local project and its explicit network mandate. No browser was started.'}}));
  process.exit(1);
}
process.once('exit',()=>{try{if(activitySettled)unlinkSync(activityPath);else retainActivity('recovery-required');}catch(error){if(error.code!=='ENOENT')process.exitCode=1;}});
const child=spawn('/usr/bin/sandbox-exec',[...sandboxArgs,process.execPath,resolve(root,'src/cli.ts'),...args],{cwd:callerCwd,detached:true,stdio:['inherit','pipe','pipe','pipe'],env:{HOME:homedir(),PATH:`${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,LANG:'en_US.UTF-8',TZ:'UTC',DO_NOT_TRACK:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1',CI:'1',WALKTHROUGH_STAGE_CUSTODY:'fd3-v1',WALKTHROUGH_STATE_ROOT:runtime.stateRoot,WALKTHROUGH_CONFIG_ROOT:runtime.configRoot}});
coordinatorPid=child.pid;retainActivity();
let timer;
let coordinatorExited=false;
let channelEnded=false;
let custodyFailed=false;
let channelWriteFailed=false;
let output='';
let outputSeen=false;
let outputInvalid=false;
let outputEnded=false;
let custodyTrafficSeen=false;
let stderrEnded=false;
const sandboxDenial='sandbox-exec: sandbox_apply: Operation not permitted';
const sandboxDenialLines=[sandboxDenial,sandboxDenial+'\n',sandboxDenial+'\r\n'];
let sandboxStderr='';
let unrelatedStderr=false;
let firstRecordExamined=false;
let coordinatorIdentity={};
const argumentValue=flag=>{const index=args.indexOf(flag);return index>=0?args[index+1]:undefined;};
const validSessionId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(value);
function retainCoordinatorIdentity(record){
  // Retain bounded public locators, never arbitrary output or IDs found inside
  // malformed/truncated JSON. Session/action locators are not evidence of success.
  if(!record||typeof record!=='object'||Array.isArray(record)||record.schemaVersion!==1)return;
  const identity={};
  const filmKind=['composition','preview'].includes(record.kind)?record.kind:null;
  if(filmKind&&typeof record.id==='string'&&new RegExp(`^${filmKind}-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$`).test(record.id)){
    Object.assign(identity,{kind:filmKind,id:record.id});
    const statuses=filmKind==='preview'?['running','failed','ready']:['running','failed','awaiting-human-review'];
    if(record.statusBasis==='recorded-lifecycle'&&statuses.includes(record.status)){
      identity.coordinatorStatus=record.status;
      identity.coordinatorStatusBasis='recorded-lifecycle';
    }
  }else if(projectRoot&&['session','observe','act','action','capture','artifact'].includes(args[0])&&(!record.projectPath||record.projectPath===projectRoot)){
    const expectedSession=argumentValue('--session')??(args[0]==='session'&&args[1]==='open'?argumentValue('--id'):undefined);
    if(validSessionId(record.sessionId)&&(!expectedSession||record.sessionId===expectedSession))identity.sessionId=record.sessionId;
    for(const key of ['attemptId','actionId','operationId'])if(validSessionId(record[key])&&record[key]===argumentValue('--id'))identity[key]=record[key];
  }
  if(Object.keys(identity).length){
    if(projectRoot){
      identity.projectPath=projectRoot;
      if(typeof record.projectId==='string'&&/^project-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(record.projectId))identity.projectId=record.projectId;
    }
    coordinatorIdentity=identity;
  }
}
child.stdout.on('data',(chunk)=>{
  if(chunk.length)outputSeen=true;
  if(outputInvalid)return;
  output+=chunk.toString();
  if(!firstRecordExamined){
    const newline=output.indexOf('\n');
    if(newline>=0){
      firstRecordExamined=true;
      if(Buffer.byteLength(output.slice(0,newline))<=1_000_000){
        try{retainCoordinatorIdentity(JSON.parse(output.slice(0,newline)));}catch{/* no identity from invalid output */}
      }
    }
  }
  if(Buffer.byteLength(output)>1_000_000){output='';outputInvalid=true;stop();}
});
child.stdout.on('end',()=>{outputEnded=true;});
// Retain only an exact, bounded sandbox startup diagnostic. Stage logs have
// their own local files; unrelated stderr is neither retained nor published.
child.stderr.on('data',(chunk)=>{
  if(unrelatedStderr)return;
  if(sandboxStderr.length+chunk.length>sandboxDenial.length+2){unrelatedStderr=true;sandboxStderr='';return;}
  const candidate=sandboxStderr+chunk.toString();
  if(!sandboxDenialLines.some(line=>line.startsWith(candidate))){unrelatedStderr=true;sandboxStderr='';return;}
  sandboxStderr=candidate;
});
child.stderr.on('end',()=>{stderrEnded=true;});
const groups=activeGroupPids;
const settling=new Map();
const audioOperations=new Map();
const audioIds=new Set();
const delay=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const exists=(pid)=>{
  try {process.kill(-pid,0);return true;}
  catch(error){if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw error;}
};
const kill=(pid)=>{
  try{process.kill(-pid,'SIGKILL');}
  catch(error){
    // A denied signal does not establish whether the group still exists.
    // Keep custody after EPERM: settle() must still observe ESRCH before its
    // existing deadline. Persistent denial cannot become successful cleanup.
    if(error.code!=='ESRCH'&&error.code!=='EPERM')throw error;
  }
};
const settle=(pid)=>{
  if(settling.has(pid))return settling.get(pid);
  const pending=(async()=>{
    kill(pid);
    const deadline=Date.now()+5000;
    while(exists(pid)){
      if(Date.now()>=deadline)throw new Error('group-not-settled');
      await delay(20);
    }
    groups.delete(pid);
    retainActivity();
  })().catch(()=>{custodyFailed=true;}).finally(()=>settling.delete(pid));
  settling.set(pid,pending);
  return pending;
};
const channel=child.stdio[3];
const audioReply=(id,error)=>{if(!coordinatorExited&&!channel.destroyed)channel.write(JSON.stringify({type:'audio-settled',id,...(error?{error}:{})})+'\n');};
function startAudio(message){
  const id=message.id;
  if(typeof id!=='string'||!/^audio-[1-9][0-9]*$/.test(id)||audioIds.has(id))throw new Error('invalid-audio-id');
  audioIds.add(id);
  if(coordinatorExited)return;
  const logs=[];
  try{
    if(audioOperations.size)throw new Error('audio-already-active');
    if(!projectRoot)throw new Error('audio-project-required');
    const requestPath=realpathSync(message.requestPath);
    const directory=dirname(requestPath);
    const occurrence=dirname(directory),collection=dirname(occurrence);
    const compositionRoot=join(projectRoot,'compositions'),previewRoot=join(projectRoot,'previews');
    const admittedCollection=collection===compositionRoot||collection===previewRoot;
    const admittedPreview=collection!==previewRoot||/^preview-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(basename(occurrence));
    if(!admittedCollection||!admittedPreview||basename(directory)!=='audio'||basename(requestPath)!=='request.json')throw new Error('audio-path');
    const provisionManifestPath=runtime.audioProvisionPath;
    const request=JSON.parse(readFileSync(requestPath,'utf8'));
    if(request.provisionManifestPath!==provisionManifestPath)throw new Error('audio-provision-path');
    const manifest=JSON.parse(readFileSync(provisionManifestPath,'utf8'));
    if(typeof manifest.hubCacheDirectory!=='string'||!isAbsolute(manifest.hubCacheDirectory))throw new Error('audio-provision');
    for(const [key,name] of [['stdout','runtime.stdout.log'],['stderr','runtime.stderr.log']]){
      const expected=join(directory,name), supplied=message[key];
      if(realpathSync(supplied.path)!==expected)throw new Error('audio-log-path');
      const fd=openSync(expected,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW);logs.push(fd);
      const stat=fstatSync(fd);
      if(!stat.isFile()||stat.dev!==supplied.dev||stat.ino!==supplied.ino||stat.uid!==process.getuid()||(stat.mode&0o077))throw new Error('audio-log-identity');
    }
    const env={HOME:homedir(),PATH:`${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,LANG:'en_US.UTF-8',TMPDIR:directory,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',HF_HUB_DISABLE_PROGRESS_BARS:'1',HF_HUB_CACHE:manifest.hubCacheDirectory,HF_HOME:dirname(manifest.hubCacheDirectory),PYTHONDONTWRITEBYTECODE:'1',DO_NOT_TRACK:'1',TOKENIZERS_PARALLELISM:'false'};
    // Only this fixed, independently sandboxed audio command is launchable.
    // This supervisor is also the process-group owner: synchronous registration
    // happens before callbacks can observe coordinator death or report started.
    const audio=spawn('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)(deny network*)',process.execPath,join(root,'src/audio/worker.ts'),requestPath],{cwd:root,env,detached:true,stdio:['ignore',logs[0],logs[1]]});
    if(audio.pid){groups.add(audio.pid);retainActivity();}
    let aborted=false,startFailed=false,escalation;
    const stopAudio=()=>{
      if(aborted)return;aborted=true;
      if(audio.pid){
        try{process.kill(-audio.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')custodyFailed=true;}
        escalation=setTimeout(()=>{if(audio.pid)void settle(audio.pid);},3000);
      }
    };
    const ceiling=setTimeout(stopAudio,60*60*1000);
    audioOperations.set(id,{stop:stopAudio});
    audio.once('spawn',()=>writeSync(logs[1],JSON.stringify({lifecycle:'audio-process-started',processGroupId:audio.pid})+'\n'));
    audio.once('error',()=>{startFailed=true;});
    audio.once('close',async(code)=>{
      clearTimeout(ceiling);clearTimeout(escalation);
      let error;
      try{
        const descendants=audio.pid&&exists(audio.pid);
        if(audio.pid)await settle(audio.pid);
        if(audio.pid&&groups.has(audio.pid))throw new Error('unsettled');
        writeSync(logs[1],JSON.stringify({lifecycle:'audio-process-settled',processGroupId:audio.pid??null,aborted})+'\n');
        error=aborted?'AUDIO_ABORTED':startFailed?'AUDIO_PROCESS_START_FAILED':descendants?'AUDIO_UNEXPECTED_DESCENDANT_CLEANED_UP':code!==0?'AUDIO_RUNTIME_FAILED_LOCAL_LOGS_RETAINED':undefined;
      }catch{error='AUDIO_PROCESS_GROUP_NOT_SETTLED';custodyFailed=true;}
      finally{for(const fd of logs)closeSync(fd);audioOperations.delete(id);}
      audioReply(id,error);
    });
  }catch{
    for(const fd of logs)closeSync(fd);
    audioReply(id,'AUDIO_SUPERVISOR_REQUEST_REJECTED');
  }
}
let buffer='';
channel.on('data',(chunk)=>{
  if(chunk.length)custodyTrafficSeen=true;
  buffer+=chunk.toString();
  try{
    if(buffer.length>65536)throw new Error('invalid-custody-message');
    for(let index;(index=buffer.indexOf('\n'))>=0;){
      const message=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);
      if(message.type==='audio-start'){startAudio(message);continue;}
      if(message.type==='audio-stop'){audioOperations.get(message.id)?.stop();continue;}
      if(!Number.isSafeInteger(message.pid)||message.pid<=1)throw new Error('invalid-custody-pid');
      if(message.type==='register'){
        groups.add(message.pid);
        retainActivity();
        if(coordinatorExited)void settle(message.pid);
        else channel.write(JSON.stringify({type:'registered',pid:message.pid})+'\n');
      }else if(message.type==='settled'&&groups.has(message.pid)){
        if(exists(message.pid))throw new Error('group-still-present');
        groups.delete(message.pid);
        retainActivity();
      }else throw new Error('invalid-custody-operation');
    }
  }catch{custodyFailed=true;stop();}
});
channel.on('end',()=>{channelEnded=true;});
channel.on('error',(error)=>{
  // A queued registration can precede the coordinator's exit callback. Its ACK
  // then meets a closed reader: delivery failed, not necessarily group custody.
  // Still stop/reconcile and never publish success after losing this channel.
  if(error.code==='EPIPE'&&error.syscall==='write')channelWriteFailed=true;
  else custodyFailed=true;
  channelEnded=true;stop();
});
const stop=()=>{
  // Give the coordinator time to reconcile before stopping its fixture child.
  child.kill('SIGTERM');
  timer??=setTimeout(()=>{if(child.pid)void settle(child.pid);for(const pid of groups)void settle(pid);},30000);
};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
child.on('error',()=>{activitySettled=!child.pid;console.log(JSON.stringify({schemaVersion:1,status:'failed',error:{code:'SUPERVISOR_START_FAILED',owner:'runtime',recovery:'Restore the local macOS sandbox and Node runtime.'}}));process.exitCode=1;});
// 'exit', not 'close': a just-spawned unreleased gate may still own the pipe.
// Drain late registrations concurrently with cleanup, never wait for EOF first.
child.on('exit',async(code,signal)=>{
  coordinatorExited=true;clearTimeout(timer);
  if(child.pid)void settle(child.pid);
  for(const pid of groups)void settle(pid);
  const deadline=Date.now()+10000;
  while(!channelEnded||!outputEnded||!stderrEnded||settling.size||audioOperations.size){
    if(Date.now()>=deadline){custodyFailed=true;break;}
    await delay(20);
  }
  if(buffer.length||groups.size)custodyFailed=true;
  activitySettled=!custodyFailed;
  channel.destroy();
  let record;
  try{record=JSON.parse(output);if(!record||typeof record!=='object'||Array.isArray(record))outputInvalid=true;}catch{outputInvalid=true;}
  if(!outputInvalid)retainCoordinatorIdentity(record);
  const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
  const inspectRecovery=coordinatorIdentity.id&&projectRoot?`Run walkthrough inspect --project ${quote(projectRoot)} --${coordinatorIdentity.kind==='preview'?'preview':'composition'} ${coordinatorIdentity.id} --json. `:
    coordinatorIdentity.sessionId&&projectRoot?`Run walkthrough session inspect --project ${quote(projectRoot)} --session ${coordinatorIdentity.sessionId} --json. Preserve the original action or operation ID; do not replay uncertain input. `:'';
  const sandboxDenied=code!==null&&code!==0&&!signal&&!outputSeen&&!custodyTrafficSeen&&!channelWriteFailed&&!unrelatedStderr&&sandboxDenialLines.includes(sandboxStderr);
  if(custodyFailed)record={schemaVersion:1,status:'failed',...coordinatorIdentity,error:{code:'SUPERVISOR_CUSTODY_NOT_SETTLED',owner:'runtime',recovery:inspectRecovery+'Inspect exact local stage groups before another occurrence.'}};
  else if(sandboxDenied)record={schemaVersion:1,status:'failed',error:{code:'HOST_SANDBOX_UNAVAILABLE',owner:'runtime',recovery:'This execution host could not apply Walkthrough\'s required macOS sandbox. Ask the host owner to provide an authorized compatible execution context. Do not disable containment or redirect state to work around this failure.'}};
  else if(outputInvalid||channelWriteFailed)record={schemaVersion:1,status:'failed',...coordinatorIdentity,error:{code:signal?'COORDINATOR_TERMINATED':channelWriteFailed?'SUPERVISOR_CHANNEL_LOST':'SUPERVISOR_OUTPUT_INVALID',owner:'runtime',recovery:inspectRecovery+'Inspect local run state and reconciliation before continuing.'}};
  // Exactly one public record, after settlement; a coordinator's complete
  // record cannot escape before the outer process-custody result is known.
  console.log(JSON.stringify(record));
  process.exitCode=custodyFailed?1:(outputInvalid||channelWriteFailed)&&!signal?1:code??(signal?130:1);
});
