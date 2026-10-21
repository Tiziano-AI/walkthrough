import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter,once} from 'node:events';
import {createHash} from 'node:crypto';
import {access,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {closeSession,inspectSession,openSession} from '../src/session/index.ts';
import {processTable} from '../src/session/process.ts';
import {infoPath,writeJson} from '../src/session/journal.ts';
import type {SessionConfig,SessionInfo} from '../src/session/contracts.ts';
import {createProject} from '../src/project/store.ts';

const program=join(import.meta.dirname,'..');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

async function fixture(t:TestContext,mode:'before-spawn'|'before-worker-identity'){
  const root=await mkdtemp('/private/tmp/wt-launch-'),state=join(root,'state'),project=join(root,'project'),directory=join(project,'sessions','original');
  const {project:manifest}=await createProject(project,{title:'Interrupted launch',brief:'Recover the original launch occurrence.',audience:'Test author',mandate:{applicationUrl:'http://127.0.0.1:9/',navigationOrigins:['http://127.0.0.1:9'],network:'loopback-only',allowedEffects:'No application use; the test pauses before worker initialization.',dataDescription:'Synthetic fixture',inputRoots:[],mediaReview:'agent-reviewable-synthetic',delivery:'local'}});
  const config:SessionConfig={directory,projectId:manifest.id,projectPath:project,startUrl:'http://127.0.0.1:9/',allowedOrigins:['http://127.0.0.1:9'],uploadRoots:[],network:'loopback-only'};
  const gate=join(root,'worker-gate.mjs'),ready=join(root,'worker-ready');
  // Fault injection precedes the actual worker entrypoint. No browser or profile
  // can open while this real child is paused before retaining its identity.
  await writeFile(gate,`import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(ready)},'ready');\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);\n`);
  const launcher=join(root,'launcher.mjs');
  await writeFile(launcher,`import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {writeSync} from 'node:fs';
import {openSession} from ${JSON.stringify(pathToFileURL(join(program,'src/session/index.ts')).href)};
const original=childProcess.spawn;
childProcess.spawn=(executable,args,options)=>{
  writeSync(1,JSON.stringify({phase:'before-spawn'})+'\\n');
  if(${JSON.stringify(mode)}==='before-spawn')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  const child=original(executable,['--import',${JSON.stringify(gate)},...args],options);
  child.once('spawn',()=>writeSync(1,JSON.stringify({phase:'worker-spawned',pid:child.pid})+'\\n'));
  return child;
};
syncBuiltinESMExports();
try{await openSession(${JSON.stringify(config)});}catch(error){writeSync(1,JSON.stringify({phase:'failed',code:error.code,message:error.message})+'\\n');process.exitCode=1;}
`);
  const previous=process.env.WALKTHROUGH_STATE_ROOT;process.env.WALKTHROUGH_STATE_ROOT=state;
  const coordinator=spawn(process.execPath,[launcher],{env:{...process.env,WALKTHROUGH_STATE_ROOT:state},stdio:['ignore','pipe','pipe']});
  const coordinatorClosed=once(coordinator,'close'),records:Record<string,unknown>[]=[],notices=new EventEmitter();let buffer='',stderr='';
  coordinator.stderr!.on('data',chunk=>{stderr+=chunk;});
  coordinator.stdout!.on('data',chunk=>{
    buffer+=chunk;
    for(let end;(end=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);records.push(JSON.parse(line));notices.emit('record');}
  });
  const waitFor=async(phase:string)=>{
    for(;;){
      const record=records.find(record=>record.phase===phase);if(record)return record;
      assert.equal(records.some(record=>record.phase==='failed'),false,JSON.stringify({records,stderr}));
      await once(notices,'record',{signal:AbortSignal.timeout(10000)});
    }
  };
  let workerPid:number|undefined;
  const stopCoordinator=async()=>{if(coordinator.exitCode===null&&coordinator.signalCode===null)coordinator.kill('SIGKILL');await coordinatorClosed;};
  const stopWorker=async()=>{
    if(workerPid===undefined)return;
    const row=(await processTable()).find(row=>row.pid===workerPid);
    if(row){
      const info=JSON.parse(await readFile(infoPath(directory),'utf8')) as SessionInfo;
      assert.equal(row.lastArgumentSha256,hash(info.workerToken!),'only the original gated test worker may be killed');
      process.kill(workerPid,'SIGKILL');
      for(let attempt=0;attempt<100;attempt++){
        const current=(await processTable()).find(row=>row.pid===workerPid);
        if(!current||current.state==='Z'){workerPid=undefined;return;}
        await delay(10);
      }
      assert.fail('the original gated worker did not stop');
    }
    workerPid=undefined;
  };
  t.after(async()=>{
    await stopWorker();await stopCoordinator();
    if(previous===undefined)delete process.env.WALKTHROUGH_STATE_ROOT;else process.env.WALKTHROUGH_STATE_ROOT=previous;
    await rm(root,{recursive:true,force:true});
  });
  await waitFor('before-spawn');
  if(mode==='before-worker-identity'){
    workerPid=Number((await waitFor('worker-spawned')).pid);
    for(let attempt=0;attempt<100;attempt++){
      try{await access(ready);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      await delay(10);
    }
    await access(ready);
  }
  const saved=JSON.parse(await readFile(infoPath(directory),'utf8')) as SessionInfo;
  assert.equal(saved.status,'starting');assert.equal(saved.processIdentity,undefined);assert.equal(saved.launchIdentity?.pid,coordinator.pid);
  return {root,state,directory,config,saved,stopWorker,stopCoordinator};
}

async function assertRecovered(f:Awaited<ReturnType<typeof fixture>>){
  const inspected=await inspectSession(f.directory);
  assert.equal(inspected.worker,'stopped');assert.equal(inspected.session.status,'interrupted');
  assert.equal(inspected.session.workerToken,f.saved.workerToken);assert.deepEqual(inspected.session.launchIdentity,f.saved.launchIdentity);
  const closed=await closeSession(f.directory);assert.equal(closed.status,'closed');assert.equal(closed.processIdentity,undefined);
  const reopened=await openSession(f.config);assert.equal(reopened.status,'closed');assert.equal(reopened.workerToken,f.saved.workerToken);
  assert.deepEqual(JSON.parse(await readFile(join(f.directory,'config.json'),'utf8')),f.config);
  await assert.rejects(access(f.saved.profileDirectory!),{code:'ENOENT'},'recovery and same-ID open never open a profile');
  await assert.rejects(access(join(f.state,'active','original.json')),{code:'ENOENT'});
}

test('original reserved launch is recoverable after coordinator death before spawn without relaunch',async t=>{
  const f=await fixture(t,'before-spawn');
  assert.equal((await inspectSession(f.directory)).worker,'unresolved','a surviving coordinator may still spawn');
  await assert.rejects(closeSession(f.directory),{code:'SESSION_LAUNCH_UNRESOLVED'});
  await f.stopCoordinator();await assertRecovered(f);
});

test('worker death before identity stays unresolved until its original coordinator is gone',async t=>{
  const f=await fixture(t,'before-worker-identity');await f.stopWorker();
  assert.equal((await inspectSession(f.directory)).worker,'unresolved');
  await assert.rejects(closeSession(f.directory),{code:'SESSION_LAUNCH_UNRESOLVED'});
  await f.stopCoordinator();await assertRecovered(f);
});

test('surviving pre-identity worker is never retired or signalled after coordinator death',async t=>{
  const f=await fixture(t,'before-worker-identity');await f.stopCoordinator();
  assert.equal((await inspectSession(f.directory)).worker,'running');
  await assert.rejects(closeSession(f.directory),{code:'SESSION_WORKER_UNREACHABLE'});
  assert.equal((await inspectSession(f.directory)).worker,'running');
  await f.stopWorker();await assertRecovered(f);
});

test('pre-identity launch without retained coordinator proof stays unresolved even when marked interrupted',async t=>{
  const f=await fixture(t,'before-spawn');await f.stopCoordinator();
  const historical={...f.saved,status:'interrupted' as const};delete historical.launchIdentity;
  await writeJson(infoPath(f.directory),historical);
  assert.equal((await inspectSession(f.directory)).worker,'unresolved');
  await assert.rejects(closeSession(f.directory),{code:'SESSION_LAUNCH_UNRESOLVED'});
});
