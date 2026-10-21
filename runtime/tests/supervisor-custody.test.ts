import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { verifyCaptureBrowserCustodyPatch, patchCaptureBrowserSource, CAPTURE_CUSTODY_PATCHED_SHA256 } from '../src/capture/browser-custody.ts';
import { qualifiedBrowserPath } from '../src/core/environment.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('capture custody verifies exact installed dependency bytes and rejects unknown source', async () => {
  assert.equal((await verifyCaptureBrowserCustodyPatch()).sha256, CAPTURE_CUSTODY_PATCHED_SHA256);
  assert.throws(() => patchCaptureBrowserSource('unknown source'), /upstream_hash_mismatch/);
});
async function readJSON(file: string): Promise<Record<string, number>> {
  for (let i = 0; i < 500; i++) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await delay(20);
  }
  throw new Error('test:receipt_timeout');
}
function absent(pid: number) {
  assert.throws(() => process.kill(pid, 0), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ESRCH', `PID/group ${pid} must be absent before test recovery`);
}
async function fixture(coordinator: string,options:{args?:string[];network?:string;supervisorPrelude?:string}={}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walkthrough-supervisor-')));
  for (const dir of ['bin', 'src', 'scripts']) await fs.mkdir(path.join(directory, dir));
  await fs.mkdir(path.join(directory, 'src/audio'));
  await fs.mkdir(path.join(directory, 'state/audio'), { recursive: true });
  await fs.mkdir(path.join(directory,'src/core'),{recursive:true});
  await fs.copyFile(path.join(root,'src/core/runtime-paths.ts'),path.join(directory,'src/core/runtime-paths.ts'));
  await fs.writeFile(path.join(directory,'project.json'),JSON.stringify({schemaVersion:1,kind:'walkthrough-project',mandate:{network:options.network??'loopback-only'}}));
  await fs.writeFile(path.join(directory, 'state/audio/provision.json'), JSON.stringify({ schemaVersion: 2, hubCacheDirectory: path.join(directory, 'state/audio/hub') }));
  await fs.writeFile(path.join(directory, 'src/audio/worker.ts'), `
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {dirname} from 'node:path';
import net from 'node:net';
const request=JSON.parse(readFileSync(process.argv[2],'utf8'));
process.on('SIGTERM',()=>{});
const receipt={stage:process.pid,credentialInherited:Number('WALKTHROUGH_CREDENTIAL_CANARY' in process.env)};
const hub=JSON.parse(readFileSync(request.provisionManifestPath,'utf8')).hubCacheDirectory;
receipt.environmentCorrect=Number(process.env.PATH===dirname(process.execPath)+':/usr/bin:/bin:/usr/sbin:/sbin' && process.env.TMPDIR===dirname(process.argv[2]) && process.env.HF_HUB_CACHE===hub && process.env.HF_HOME===dirname(hub) && process.env.HF_HUB_OFFLINE==='1' && process.env.TRANSFORMERS_OFFLINE==='1' && process.env.HF_HUB_DISABLE_TELEMETRY==='1' && process.env.HF_HUB_DISABLE_PROGRESS_BARS==='1' && process.env.PYTHONDONTWRITEBYTECODE==='1' && process.env.DO_NOT_TRACK==='1' && process.env.TOKENIZERS_PARALLELISM==='false');
for(const [name,host,port] of [['externalErrno','1.1.1.1',443],['loopbackErrno','127.0.0.1',request.port??1]]){
 receipt[name]=await new Promise(resolve=>{
  const socket=net.connect({host,port});
  socket.once('connect',()=>{socket.destroy();resolve(0);});
  socket.once('error',error=>resolve(Math.abs(error.errno)));
  socket.setTimeout(1000,()=>{socket.destroy();resolve(-999);});
 });
}
if(request.mode==='resistant'){
 const helper=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
 await new Promise(resolve=>helper.stdout.once('data',resolve));receipt.helper=helper.pid;
}
writeFileSync(request.receipt,JSON.stringify(receipt));
console.log('synthetic stdout retained');
console.error('synthetic stderr retained');
if(request.mode==='resistant')setInterval(()=>{},1000);
if(request.mode==='failed')process.exitCode=17;
`);
  // Exact public supervisor bytes, with only its coordinator replaced by a
  // synthetic fixture. No production CLI option or environment test bypass.
  await fs.copyFile(path.join(root, 'bin/walkthrough.mjs'), path.join(directory, 'bin/walkthrough.mjs'));
  await fs.copyFile(path.join(root, 'scripts/loopback-only.sb'), path.join(directory, 'scripts/loopback-only.sb'));
  await fs.writeFile(path.join(directory, 'src/cli.ts'), coordinator);
  const args=[...(options.args??['doctor','--json']),'--project',directory];
  const preloadArgs:string[]=[];
  if(options.supervisorPrelude){
    const preload=path.join(directory,'supervisor-prelude.mjs');
    await fs.writeFile(preload,options.supervisorPrelude);
    preloadArgs.push('--import',preload);
  }
  const child = spawn(process.execPath, [...preloadArgs,path.join(directory, 'bin/walkthrough.mjs'), ...args], { cwd:directory,stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WALKTHROUGH_STATE_ROOT:path.join(directory,'state'),WALKTHROUGH_CONFIG_ROOT:path.join(directory,'settings'),WALKTHROUGH_CREDENTIAL_CANARY: 'must-not-cross-audio-boundary',WALKTHROUGH_HOSTED_CAPTURE:'1' } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { directory, child, done, output: () => output };
}
const common = `
import {spawn} from 'node:child_process';
import {writeFileSync,openSync,mkdirSync,readFileSync} from 'node:fs';
import {executeLocal} from ${JSON.stringify(path.join(root, 'src/render/media.ts'))};
import {runOwnedAudioProcess} from ${JSON.stringify(path.join(root, 'src/audio/process.ts'))};
import {spawnOwnedStage} from ${JSON.stringify(path.join(root, 'src/core/stage-process.ts'))};
const stage = "const {spawn}=require('node:child_process');const fs=require('node:fs');const helper=spawn(process.execPath,['-e',\\\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\\\"],{stdio:'ignore'});process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],JSON.stringify({stage:process.pid,helper:helper.pid}));setInterval(()=>{},1000)";
function audioInput(mode='resistant',port=1,relative='compositions/synthetic/audio'){
 const directory=process.cwd()+'/'+relative;mkdirSync(directory,{recursive:true});
 const requestPath=directory+'/request.json';writeFileSync(requestPath,JSON.stringify({mode,port,receipt:process.cwd()+'/audio.json',provisionManifestPath:process.cwd()+'/state/audio/provision.json'}),{flag:'wx'});
 const stdoutPath=directory+'/runtime.stdout.log',stderrPath=directory+'/runtime.stderr.log';
 return {executable:'/usr/bin/sandbox-exec',args:['-p','(version 1)(allow default)(deny network*)',process.execPath,process.cwd()+'/src/audio/worker.ts',requestPath],cwd:process.cwd(),env:{PATH:'/usr/bin:/bin'},stdout:openSync(stdoutPath,'wx',0o600),stderr:openSync(stderrPath,'wx',0o600),stdoutPath,stderrPath};
}
`;

const retainedCompositionId = 'composition-12345678-1234-1234-1234-123456789abc';
const retainedPreviewId = 'preview-12345678-1234-1234-1234-123456789abc';
for(const status of ['running','failed','ready']){
  test(`supervisor preserves preview ${status} identity and exact recovery when custody fails`,async()=>{
    const record={schemaVersion:1,kind:'preview',id:retainedPreviewId,status,statusBasis:'recorded-lifecycle'};
    const f=await fixture(`import {writeSync} from 'node:fs';console.log(${JSON.stringify(JSON.stringify(record))});writeSync(3,'{');`);
    assert.equal(await f.done,1);
    const report=JSON.parse(f.output());
    assert.equal(report.coordinatorStatus,status);assert.equal(report.kind,'preview');assert.equal(report.id,retainedPreviewId);
    assert.match(report.error.recovery,new RegExp(`--preview ${retainedPreviewId} --json`));
    assert.doesNotMatch(report.error.recovery,/--composition/);
  });
}
for(const status of ['running','awaiting-human-review']){
  test(`supervisor preserves composition ${status} identity when custody fails`,async()=>{
    const record={schemaVersion:1,kind:'composition',id:retainedCompositionId,status,statusBasis:'recorded-lifecycle'};
    const f=await fixture(`import {writeSync} from 'node:fs';console.log(${JSON.stringify(JSON.stringify(record))});writeSync(3,'{');`);
    assert.equal(await f.done,1);
    assert.equal(JSON.parse(f.output()).coordinatorStatus,status);
  });
}
test('web session opening admits ordinary networking on nonstandard ports without credentials',async()=>{
  const f=await fixture(`
import net from 'node:net';
const denied=await new Promise(resolve=>{const socket=net.connect({host:'192.0.2.1',port:8443});socket.once('connect',()=>{socket.destroy();resolve(false)});socket.once('error',error=>resolve(['EPERM','EACCES'].includes(error.code)));socket.setTimeout(1000,()=>{socket.destroy();resolve(false)});});
console.log(JSON.stringify({schemaVersion:1,status:'complete',nonstandardPortDenied:denied,canaryAbsent:!Object.hasOwn(process.env,'WALKTHROUGH_CREDENTIAL_CANARY')}));
`,{args:['session','open','--json'],network:'web'});
  assert.equal(await f.done,0,f.output());
  assert.deepEqual(JSON.parse(f.output()),{schemaVersion:1,status:'complete',nonstandardPortDenied:false,canaryAbsent:true});
});
test('an invalid project network mandate never starts a session coordinator',async()=>{
  const f=await fixture(`console.log(JSON.stringify({schemaVersion:1,status:'complete',forbidden:true}));`,{args:['session','open','--json'],network:'unbounded'});
  assert.equal(await f.done,1,f.output());
  assert.equal(JSON.parse(f.output()).error.code,'PROJECT_AUTHORITY_UNAVAILABLE');
  assert.doesNotMatch(f.output(),/forbidden/);
});
for(const operation of ['mkdirSync','writeFileSync'])for(const code of ['EPERM','EACCES','EROFS']){
  test(`host state ${operation} ${code} is not a project mandate failure`,async()=>{
    const f=await fixture(`import {writeFileSync} from 'node:fs';writeFileSync('forbidden-start','started');`,{supervisorPrelude:`
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const original=fs.${operation};
fs.${operation}=(target,...args)=>{
  if(${operation==='mkdirSync'?"target===process.cwd()+'/state/active'":"typeof target==='string'&&target.startsWith(process.cwd()+'/state/active/command-')"})throw Object.assign(new Error('private synthetic state failure'),{code:${JSON.stringify(code)}});
  return original(target,...args);
};
syncBuiltinESMExports();
`});
    assert.equal(await f.done,1,f.output());
    const report=JSON.parse(f.output());
    assert.equal(report.error.code,'HOST_STATE_NOT_WRITABLE');assert.equal(report.error.owner,'runtime');
    assert.ok(report.error.recovery.includes(path.join(f.directory,'state/active')));
    assert.match(report.error.recovery,/host owner/);assert.match(report.error.recovery,/Do not redirect state/);
    assert.doesNotMatch(f.output(),/private synthetic|PROJECT_AUTHORITY/);
    assert.equal(f.output().trim().split('\n').length,1);
    await assert.rejects(fs.access(path.join(f.directory,'forbidden-start')),{code:'ENOENT'});
  });
}
test('host state failures outside permission denial remain runtime failures',async()=>{
  const f=await fixture(`throw new Error('forbidden coordinator');`,{supervisorPrelude:`
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const original=fs.mkdirSync;
fs.mkdirSync=(target,...args)=>{
  if(target===process.cwd()+'/state/active')throw Object.assign(new Error('private synthetic full disk'),{code:'ENOSPC'});
  return original(target,...args);
};
syncBuiltinESMExports();
`});
  assert.equal(await f.done,1,f.output());
  assert.equal(JSON.parse(f.output()).error.code,'RUNTIME_STATE_UNAVAILABLE');
  assert.doesNotMatch(f.output(),/private synthetic|PROJECT_AUTHORITY|forbidden coordinator/);
});
test('installation recovery still precedes host state initialization',async()=>{
  const f=await fixture(`throw new Error('forbidden coordinator');`,{supervisorPrelude:`
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
fs.writeFileSync(process.cwd()+'/state/installation-pending.json','{}');
const original=fs.mkdirSync;
fs.mkdirSync=(target,...args)=>{
  if(target===process.cwd()+'/state/active')throw Object.assign(new Error('private synthetic denial'),{code:'EPERM'});
  return original(target,...args);
};
syncBuiltinESMExports();
`});
  assert.equal(await f.done,1,f.output());
  assert.equal(JSON.parse(f.output()).error.code,'INSTALL_RECOVERY_REQUIRED');
  assert.doesNotMatch(f.output(),/private synthetic|forbidden coordinator/);
});
const sandboxStartupDenial='sandbox-exec: sandbox_apply: Operation not permitted';
for(const ending of ['','\n','\r\n']){
  test(`host sandbox startup denial is recognized with ${JSON.stringify(ending)} ending`,async()=>{
    const f=await fixture(`
process.stderr.write(${JSON.stringify(sandboxStartupDenial.slice(0,20))});
await new Promise(resolve=>setTimeout(resolve,25));
process.stderr.write(${JSON.stringify(sandboxStartupDenial.slice(20)+ending)});
process.exitCode=1;
`);
    assert.equal(await f.done,1,f.output());
    const report=JSON.parse(f.output());
    assert.equal(report.error.code,'HOST_SANDBOX_UNAVAILABLE');assert.equal(report.error.owner,'runtime');
    assert.match(report.error.recovery,/host owner/);assert.match(report.error.recovery,/Do not disable containment or redirect state/);
    assert.doesNotMatch(f.output(),/sandbox_apply|SUPERVISOR_OUTPUT_INVALID/);
    assert.equal(f.output().trim().split('\n').length,1);
    assert.deepEqual(await fs.readdir(path.join(f.directory,'state/active')),[]);
  });
}
for(const [name,coordinator,expected] of [
  ['unrelated stderr',`process.stderr.write('private unrelated error');process.exitCode=1;`,'SUPERVISOR_OUTPUT_INVALID'],
  ['no stderr',`process.exitCode=1;`,'SUPERVISOR_OUTPUT_INVALID'],
  ['private prefix',`process.stderr.write('private prefix '+${JSON.stringify(sandboxStartupDenial)});process.exitCode=1;`,'SUPERVISOR_OUTPUT_INVALID'],
  ['private suffix',`process.stderr.write(${JSON.stringify(sandboxStartupDenial)}+' private suffix');process.exitCode=1;`,'SUPERVISOR_OUTPUT_INVALID'],
  ['oversized stderr',`process.stderr.write('private'.repeat(100000));process.exitCode=1;`,'SUPERVISOR_OUTPUT_INVALID'],
  ['malformed stdout',`process.stderr.write(${JSON.stringify(sandboxStartupDenial)});console.log('private malformed output');process.exitCode=1;`,'SUPERVISOR_OUTPUT_INVALID'],
  ['successful exit',`process.stderr.write(${JSON.stringify(sandboxStartupDenial)});`,'SUPERVISOR_OUTPUT_INVALID'],
  ['termination signal',`process.stderr.write(${JSON.stringify(sandboxStartupDenial)});process.kill(process.pid,'SIGTERM');`,'COORDINATOR_TERMINATED'],
  ['custody traffic',`import {writeSync} from 'node:fs';writeSync(3,JSON.stringify({type:'audio-stop',id:'inactive'})+'\\n');process.stderr.write(${JSON.stringify(sandboxStartupDenial)});process.exitCode=1;`,'SUPERVISOR_OUTPUT_INVALID'],
  ['custody failure',`import {writeSync} from 'node:fs';writeSync(3,'{');process.stderr.write(${JSON.stringify(sandboxStartupDenial)});process.exitCode=1;`,'SUPERVISOR_CUSTODY_NOT_SETTLED'],
  ['valid coordinator error',`process.stderr.write(${JSON.stringify(sandboxStartupDenial)});console.log(JSON.stringify({schemaVersion:1,status:'failed',error:{code:'ORIGINAL_COORDINATOR_FAILURE',owner:'runtime',recovery:'Retain this result.'}}));process.exitCode=1;`,'ORIGINAL_COORDINATOR_FAILURE'],
] as const){
  test(`host sandbox diagnostic does not replace ${name}`,async()=>{
    const f=await fixture(coordinator);
    assert.equal(await f.done,name==='termination signal'?130:1,f.output());
    assert.equal(JSON.parse(f.output()).error.code,expected);
    assert.doesNotMatch(f.output(),/private|sandbox_apply|HOST_SANDBOX_UNAVAILABLE/);
    assert.equal(f.output().trim().split('\n').length,1);
  });
}
test('composition cannot select hosted network through inherited environment or project mandate',async()=>{
  const f=await fixture(`
import net from 'node:net';
const denied=await new Promise(resolve=>{const socket=net.connect({host:'1.1.1.1',port:443});socket.once('connect',()=>{socket.destroy();resolve(false)});socket.once('error',error=>resolve(['EPERM','EACCES'].includes(error.code)));socket.setTimeout(1000,()=>{socket.destroy();resolve(false)});});
console.log(JSON.stringify({schemaVersion:1,status:'complete',httpsDenied:denied}));
`,{args:['compose','--edit','synthetic.json','--json'],network:'web'});
  assert.equal(await f.done,0,f.output());
  assert.equal(JSON.parse(f.output()).httpsDenied,true);
});
for (const failure of ['custody', 'output', 'overflow']) {
  test(`supervisor retains only validated composition identity after ${failure} failure`, { timeout: 15000 }, async () => {
    const record = { schemaVersion: 1, kind:'composition',id: retainedCompositionId, status: 'awaiting-human-review', statusBasis: 'recorded-lifecycle', privateUnrelated: 'private-data-must-not-escape' };
    const f = await fixture(`
import {writeSync} from 'node:fs';
process.on('SIGTERM',()=>process.exit(0));
console.log(${JSON.stringify(JSON.stringify(record))});
${failure === 'custody' ? "writeSync(3,'{');" : failure === 'output' ? "console.log('private-invalid-tail');" : "process.stdout.write('x'.repeat(1_000_001));"}
`);
    try {
      const exitCode = await f.done;
      assert.ok(exitCode === 1 || (failure === 'overflow' && exitCode === 130), f.output());
      const report = JSON.parse(f.output());
      assert.equal(report.status, 'failed');
      assert.equal(report.id, retainedCompositionId);
      assert.equal(report.coordinatorStatus, 'awaiting-human-review');
      assert.equal(report.coordinatorStatusBasis, 'recorded-lifecycle');
      assert.ok((failure === 'custody' ? ['SUPERVISOR_CUSTODY_NOT_SETTLED'] : failure === 'overflow' ? ['SUPERVISOR_OUTPUT_INVALID', 'COORDINATOR_TERMINATED'] : ['SUPERVISOR_OUTPUT_INVALID']).includes(report.error.code));
      assert.ok(report.error.recovery.includes(`--composition ${retainedCompositionId} --json`));
      assert.doesNotMatch(f.output(), /private-data|Unrelated/);
      assert.equal(f.output().trim().split('\n').length, 1);
    } finally { f.child.kill('SIGKILL'); }
  });
}

test('supervisor never recovers identity from invalid IDs, fragments or unrelated schema', { timeout: 15000 }, async () => {
  for (const value of [
    JSON.stringify({ schemaVersion: 1,kind:'composition',id: '../private;unsafe', status: 'awaiting-human-review', statusBasis: 'recorded-lifecycle' }),
    JSON.stringify({ schemaVersion: 2,kind:'composition',id: retainedCompositionId, status: 'awaiting-human-review', statusBasis: 'recorded-lifecycle' }),
    `{"schemaVersion":1,"kind":"composition","id":"${retainedCompositionId}",`,
  ]) {
    const f = await fixture(`console.log(${JSON.stringify(value)});console.log('private-invalid-tail');`);
    try {
      assert.equal(await f.done, 1, f.output());
      const report = JSON.parse(f.output());
      assert.equal(report.id, undefined); assert.equal(report.coordinatorStatus, undefined);
      assert.doesNotMatch(f.output(), /private|unsafe|walkthrough inspect/);
    } finally { f.child.kill('SIGKILL'); }
  }
});

test('supervisor retains valid identity without promoting unvalidated coordinator status', { timeout: 15000 }, async () => {
  const f = await fixture(`console.log(${JSON.stringify(JSON.stringify({ schemaVersion: 1,kind:'composition',id: retainedCompositionId, status: 'private-unvalidated', statusBasis: 'recorded-lifecycle' }))});console.log('invalid-tail');`);
  try {
    assert.equal(await f.done, 1, f.output());
    const report = JSON.parse(f.output());
    assert.equal(report.id, retainedCompositionId); assert.equal(report.coordinatorStatus, undefined);
    assert.equal(report.status, 'failed'); assert.doesNotMatch(f.output(), /private-unvalidated/);
  } finally { f.child.kill('SIGKILL'); }
});

for(const key of ['attemptId','actionId','operationId']){
  test(`supervisor retains the selected session and ${key} without claiming the input succeeded`,async()=>{
    const f=await fixture(`
console.log(JSON.stringify({schemaVersion:1,status:'ok',sessionId:'session-retained',${key}:'input-retained',projectId:'project-12345678-1234-1234-1234-123456789abc',projectPath:process.cwd(),result:{status:'input-completed',privatePayload:'must-not-escape'}}));
console.log('invalid-tail');
`,{args:['act','--session','session-retained','--id','input-retained','--json']});
    try{
      assert.equal(await f.done,1,f.output());
      const report=JSON.parse(f.output());
      assert.equal(report.status,'failed');assert.equal(report.sessionId,'session-retained');assert.equal(report[key],'input-retained');
      assert.equal(report.projectPath,f.directory);assert.equal(report.projectId,'project-12345678-1234-1234-1234-123456789abc');
      assert.equal(report.coordinatorStatus,undefined);assert.match(report.error.recovery,/session inspect .*--session session-retained/);
      assert.doesNotMatch(f.output(),/privatePayload|must-not-escape|input-completed/);
    }finally{f.child.kill('SIGKILL');}
  });
}
test('supervisor refuses unrelated session paths, mismatched IDs and unsafe caller IDs',async()=>{
  for(const record of [
    {schemaVersion:1,sessionId:'another-session',attemptId:'another-attempt'},
    {schemaVersion:1,sessionId:'session-retained',attemptId:'input-retained',projectPath:'/unrelated/project'},
    {schemaVersion:1,sessionId:'../unsafe',attemptId:'../unsafe'},
    {schemaVersion:2,sessionId:'session-retained',attemptId:'input-retained'},
  ]){
    const f=await fixture(`console.log(${JSON.stringify(JSON.stringify(record))});console.log('invalid-tail');`,{args:['act','--session','session-retained','--id','input-retained','--json']});
    try{
      assert.equal(await f.done,1,f.output());const report=JSON.parse(f.output());
      assert.equal(report.sessionId,undefined);assert.equal(report.attemptId,undefined);assert.equal(report.projectPath,undefined);
      assert.doesNotMatch(f.output(),/unsafe|unrelated|another-session|another-attempt/);
    }finally{f.child.kill('SIGKILL');}
  }
});

for (const cooperative of [false, true]) {
  test(`public supervisor settles audio, render and fixture groups after coordinator ${cooperative ? 'reconciliation' : 'SIGKILL'}`, { timeout: 30000 }, async () => {
    const f = await fixture(common + `
const fixture=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
writeFileSync('coordinator.json',JSON.stringify({coordinator:process.pid,fixture:fixture.pid}));
process.on('SIGTERM',()=>{writeFileSync('reconciled.json',JSON.stringify({coordinator:process.pid}));setTimeout(()=>{console.log(JSON.stringify({schemaVersion:1,status:'failed',error:{code:'RUN_CANCELLED'}}));process.exit(0);},150);});
await Promise.all([
  executeLocal(process.execPath,['-e',stage,'render.json'],'render.log'),
  runOwnedAudioProcess(audioInput())
]);
`);
    let pids: number[] = [];
    try {
      const owner = await readJSON(path.join(f.directory, 'coordinator.json'));
      const audio = await readJSON(path.join(f.directory, 'audio.json'));
      const render = await readJSON(path.join(f.directory, 'render.json'));
      pids = [...Object.values(owner), audio.stage!, audio.helper!, ...Object.values(render)];
      assert.equal(audio.externalErrno, 1); assert.equal(audio.loopbackErrno, 1); assert.equal(audio.credentialInherited, 0); assert.equal(audio.environmentCorrect, 1);
      if (cooperative) f.child.kill('SIGTERM');
      else process.kill(owner.coordinator!, 'SIGKILL');
      assert.equal(await f.done, cooperative ? 0 : 130, f.output());
      assert.equal(f.output().trim().split('\n').length, 1);
      assert.equal(JSON.parse(f.output()).status, 'failed');
      if (cooperative) await fs.access(path.join(f.directory, 'reconciled.json'));
      for (const pid of pids) absent(pid);
      for (const pid of [owner.coordinator!, audio.stage!, render.stage!]) absent(-pid);
    } finally {
      // Recovery does not participate in the assertions above.
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      f.child.kill('SIGKILL');
    }
  });
}

for(const relative of ['compositions/synthetic/audio',`previews/${retainedPreviewId}/audio`])test(`public audio sibling ${relative} denies external and live loopback sockets and returns only after settlement`, { timeout: 20000 }, async () => {
  const server = net.createServer(socket => socket.destroy());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const f = await fixture(common + `
const input=audioInput('normal',${port},${JSON.stringify(relative)});
// The IPC protocol must not expose an arbitrary command/environment endpoint.
input.executable='/does/not/exist';input.args=['not-a-command',input.args.at(-1)];
input.env.WALKTHROUGH_CREDENTIAL_CANARY='must-not-cross-audio-boundary';
await runOwnedAudioProcess(input);
console.log(JSON.stringify({schemaVersion:1,status:'complete',syntheticAudio:true}));
`);
  try {
    assert.equal(await f.done, 0, f.output());
    assert.deepEqual(JSON.parse(f.output()), { schemaVersion: 1, status: 'complete', syntheticAudio: true });
    const receipt = await readJSON(path.join(f.directory, 'audio.json'));
    assert.equal(receipt.externalErrno, 1); assert.equal(receipt.loopbackErrno, 1); assert.equal(receipt.credentialInherited, 0); assert.equal(receipt.environmentCorrect, 1);
    absent(receipt.stage!); absent(-receipt.stage!);
    assert.match(await fs.readFile(path.join(f.directory, relative,'runtime.stdout.log'), 'utf8'), /synthetic stdout retained/);
    const stderr = await fs.readFile(path.join(f.directory, relative,'runtime.stderr.log'), 'utf8');
    assert.match(stderr, /synthetic stderr retained/); assert.match(stderr, /audio-process-started/); assert.match(stderr, /audio-process-settled/);
    assert.doesNotMatch(f.output(), /synthetic stdout retained|synthetic stderr retained/);
  } finally {
    f.child.kill('SIGKILL');
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('public supervisor owns gates even when coordinator dies before registration or release', { timeout: 20000 }, async () => {
  const f = await fixture(common + `
const log=openSync('gate.log','wx',0o600);
const children=Array.from({length:8},()=>spawnOwnedStage(process.execPath,['-e',"require('node:fs').writeFileSync('forbidden-start','started')"],{stdio:['ignore',log,log],env:{PATH:'/usr/bin:/bin'}}));
writeFileSync('coordinator.json',JSON.stringify(Object.fromEntries([['coordinator',process.pid],...children.map((child,i)=>['gate'+i,child.pid])])));
process.kill(process.pid,'SIGKILL');
`);
  const pids = await readJSON(path.join(f.directory, 'coordinator.json'));
  try {
    assert.equal(await f.done, 130, f.output());
    for (const pid of Object.values(pids)) { absent(pid); absent(-pid); }
    await assert.rejects(fs.access(path.join(f.directory, 'forbidden-start')), /ENOENT/);
  } finally {
    for (const pid of Object.values(pids)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    f.child.kill('SIGKILL');
  }
});

for(const persistent of [false,true])test(`public supervisor ${persistent?'retains custody on persistent':'waits for absence after transient'} signal EPERM`, { timeout: 15000 }, async () => {
  const f=await fixture(`
import {writeFileSync} from 'node:fs';
writeFileSync('coordinator.json',JSON.stringify({coordinator:process.pid}));
process.kill(process.pid,'SIGKILL');
`,{supervisorPrelude:`
import {readFileSync,writeFileSync} from 'node:fs';
const originalKill=process.kill.bind(process);
const observations={signals:0,denied:0,absent:0};
// Keep production supervisor bytes exact. Inject only the known owned group's
// post-exit kernel transition; no unrelated or still-live PID is intercepted.
process.kill=(pid,signal)=>{
  let coordinator;
  try{coordinator=JSON.parse(readFileSync(new URL('./coordinator.json',import.meta.url),'utf8')).coordinator;}catch{}
  if(pid===-coordinator){
    let absent=false;
    try{originalKill(pid,0);}catch(error){if(error.code==='ESRCH')absent=true;else throw error;}
    if(absent){
      if(signal==='SIGKILL'){
        observations.signals++;
        throw Object.assign(new Error('synthetic group teardown signal'),{code:'EPERM',syscall:'kill'});
      }
      if(signal===0){
        if(${persistent}||observations.denied<2){
          observations.denied++;
          throw Object.assign(new Error('synthetic unreaped group'),{code:'EPERM',syscall:'kill'});
        }
        observations.absent++;
      }
    }
  }
  return originalKill(pid,signal);
};
process.on('exit',()=>writeFileSync(new URL('./observations.json',import.meta.url),JSON.stringify(observations)));
`});
  const pids=await readJSON(path.join(f.directory,'coordinator.json'));
  try{
    assert.equal(await f.done,persistent?1:130,f.output());
    const report=JSON.parse(f.output());
    assert.equal(report.error.code,persistent?'SUPERVISOR_CUSTODY_NOT_SETTLED':'COORDINATOR_TERMINATED');
    const observations=await readJSON(path.join(f.directory,'observations.json'));
    assert.equal(observations.signals,1,'a denied signal is not retried');
    assert.ok(observations.denied!>=2,'EPERM must retain custody for further observations');
    assert.equal(observations.absent,persistent?0:1,'only observed ESRCH can release group custody');
    absent(pids.coordinator!);absent(-pids.coordinator!);
  }finally{
    try{process.kill(pids.coordinator!,'SIGKILL');}catch{}
    f.child.kill('SIGKILL');
  }
});

for(const coordinatorDies of [true,false])test(coordinatorDies
  ? 'public supervisor settles custody when coordinator death precedes queued registration'
  : 'public supervisor cannot report success after losing the live coordinator response channel', { timeout: 15000 }, async () => {
  const f = await fixture(`
import {existsSync,writeSync,writeFileSync,closeSync} from 'node:fs';
process.on('SIGTERM',()=>{console.log(JSON.stringify({schemaVersion:1,status:'complete',synthetic:true}));process.exit(0);});
writeFileSync('coordinator.json',JSON.stringify({coordinator:process.pid}));
const wait=new Int32Array(new SharedArrayBuffer(4));
const deadline=Date.now()+5000;
while(!existsSync('release-registration')){
  if(Date.now()>=deadline)throw new Error('test:registration_barrier_timeout');
  Atomics.wait(wait,0,0,1);
}
writeSync(3,JSON.stringify({type:'register',pid:process.pid})+'\\n');
${coordinatorDies?"process.kill(process.pid,'SIGKILL');":"closeSync(3);writeFileSync('channel-closed.json',JSON.stringify({coordinator:process.pid}));setInterval(()=>{},1000);"}
`);
  const receipt=await readJSON(path.join(f.directory,'coordinator.json'));
  try{
    // Make registration and peer-channel closure pending together without
    // depending on host load: the supervisor cannot consume either while stopped.
    f.child.kill('SIGSTOP');
    await fs.writeFile(path.join(f.directory,'release-registration'),'');
    if(coordinatorDies){
      let exited=false;
      for(let attempt=0;attempt<250;attempt++){
        try{exited=execFileSync('/bin/ps',['-p',String(receipt.coordinator),'-o','stat='],{encoding:'utf8'}).trim().startsWith('Z');}
        catch(error){if((error as {status?:number}).status===1)exited=true;else throw error;}
        if(exited)break;
        await delay(20);
      }
      assert.equal(exited,true,'the coordinator must exit before queued registration is consumed');
    }else{
      await readJSON(path.join(f.directory,'channel-closed.json'));
      process.kill(receipt.coordinator!,0);
    }
    f.child.kill('SIGCONT');
    const exitCode=await f.done;
    absent(receipt.coordinator!);absent(-receipt.coordinator!);
    assert.equal(exitCode,coordinatorDies?130:1,JSON.stringify({directory:f.directory,output:f.output()}));
    const report=JSON.parse(f.output());
    assert.equal(report.status,'failed');
    assert.equal(report.error.code,coordinatorDies?'COORDINATOR_TERMINATED':'SUPERVISOR_CHANNEL_LOST');
  }finally{
    f.child.kill('SIGCONT');
    try{process.kill(receipt.coordinator!,'SIGKILL');}catch{}
    f.child.kill('SIGKILL');
  }
});

for(const relative of ['compositions/synthetic/audio',`previews/${retainedPreviewId}/audio`])for (const rejection of ['provision-path', 'log-identity']) {
  test(`public audio supervisor rejects ${rejection} in ${relative} before starting its fixed worker`, { timeout: 20000 }, async () => {
    const f = await fixture(common + `
import {renameSync} from 'node:fs';
const input=audioInput('normal',1,${JSON.stringify(relative)});
${rejection === 'provision-path' ? `
const requestPath=input.args.at(-1);
const request=JSON.parse(readFileSync(requestPath,'utf8'));
request.provisionManifestPath=process.cwd()+'/alternate-provision.json';
writeFileSync(request.provisionManifestPath,readFileSync('state/audio/provision.json'));
writeFileSync(requestPath,JSON.stringify(request));
` : `
renameSync(input.stdoutPath,input.stdoutPath+'.original');
writeFileSync(input.stdoutPath,'',{mode:0o600});
`}
let code;
try{await runOwnedAudioProcess(input);}catch(error){code=error.message;}
console.log(JSON.stringify({schemaVersion:1,status:'failed',code}));
`);
    try {
      assert.equal(await f.done, 0, f.output());
      assert.deepEqual(JSON.parse(f.output()), { schemaVersion: 1, status: 'failed', code: 'AUDIO_SUPERVISOR_REQUEST_REJECTED' });
      await assert.rejects(fs.access(path.join(f.directory, 'audio.json')), /ENOENT/);
      assert.equal(await fs.readFile(path.join(f.directory,relative,'runtime.stderr.log'), 'utf8'), '');
    } finally { f.child.kill('SIGKILL'); }
  });
}

for(const relative of ['previews/not-a-preview/audio',`previews/${retainedPreviewId}/nested/audio`,'elsewhere/audio'])test(`public audio supervisor rejects unowned path ${relative}`,async()=>{
  const f=await fixture(common+`
const input=audioInput('normal',1,${JSON.stringify(relative)});
let code;try{await runOwnedAudioProcess(input);}catch(error){code=error.message;}
console.log(JSON.stringify({schemaVersion:1,status:'failed',code}));
`);
  assert.equal(await f.done,0,f.output());
  assert.equal(JSON.parse(f.output()).code,'AUDIO_SUPERVISOR_REQUEST_REJECTED');
  await assert.rejects(fs.access(path.join(f.directory,'audio.json')),/ENOENT/);
  assert.equal(await fs.readFile(path.join(f.directory,relative,'runtime.stderr.log'),'utf8'),'');
});

test('failed fixed audio worker closes and settles before reporting bounded failure', { timeout: 20000 }, async () => {
  const f = await fixture(common + `
let code;
try{await runOwnedAudioProcess(audioInput('failed'));}catch(error){code=error.message;}
console.log(JSON.stringify({schemaVersion:1,status:'failed',code}));
`);
  try {
    assert.equal(await f.done, 0, f.output());
    assert.deepEqual(JSON.parse(f.output()), { schemaVersion: 1, status: 'failed', code: 'AUDIO_RUNTIME_FAILED_LOCAL_LOGS_RETAINED' });
    const receipt = await readJSON(path.join(f.directory, 'audio.json'));
    absent(receipt.stage!); absent(-receipt.stage!);
    assert.match(await fs.readFile(path.join(f.directory, 'compositions/synthetic/audio/runtime.stderr.log'), 'utf8'), /audio-process-settled/);
    assert.doesNotMatch(f.output(), /synthetic stdout retained|synthetic stderr retained/);
  } finally { f.child.kill('SIGKILL'); }
});

test('coordinator success record is held until stage and helper settlement', { timeout: 20000 }, async () => {
  const f = await fixture(common + `
void executeLocal(process.execPath,['-e',stage,'render.json'],'render.log');
setTimeout(()=>{console.log(JSON.stringify({schemaVersion:1,status:'complete',synthetic:true}));writeFileSync('coordinator.json',JSON.stringify({coordinator:process.pid}));setTimeout(()=>process.exit(0),400);},250);
`);
  let pids: number[] = [];
  try {
    const owner = await readJSON(path.join(f.directory, 'coordinator.json'));
    const render = await readJSON(path.join(f.directory, 'render.json'));
    pids = [...Object.values(owner), ...Object.values(render)];
    assert.equal(f.output(), '', 'complete must not escape while coordinator/stages remain live');
    assert.equal(await f.done, 0, f.output());
    assert.deepEqual(JSON.parse(f.output()), { schemaVersion: 1, status: 'complete', synthetic: true });
    assert.equal(f.output().trim().split('\n').length, 1);
    for (const pid of pids) absent(pid);
    absent(-render.stage!);
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    f.child.kill('SIGKILL');
  }
});

test('custodied Playwright blank browser shares coordinator group and settles on hard death', { timeout: 30000 }, async () => {
  const browserPath = qualifiedBrowserPath();
  const f = await fixture(`
import {openSessionBrowser} from ${JSON.stringify(path.join(root, 'src/session/browser.ts'))};
import {writeFileSync} from 'node:fs';
const context=await openSessionBrowser({profileDirectory:process.cwd()+'/profile',executablePath:${JSON.stringify(browserPath)},headless:true,network:'loopback-only'});
await context.newPage();
writeFileSync('coordinator.json',JSON.stringify({coordinator:process.pid}));
setInterval(()=>{},1000);
`);
  let pids: number[] = [];
  let pgids: number[] = [];
  try {
    const { coordinator } = await readJSON(path.join(f.directory, 'coordinator.json'));
    const table = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8' }).trim().split('\n').map(line => {
      const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number); return { pid: pid!, ppid: ppid!, pgid: pgid! };
    });
    const owned = new Set([coordinator!]);
    for (let size = -1; size !== owned.size;) {
      size = owned.size;
      for (const row of table) if (owned.has(row.ppid)) owned.add(row.pid);
    }
    const descendants = table.filter(row => owned.has(row.pid));
    pids = [...owned]; pgids = [...new Set(descendants.map(row => row.pgid))];
    assert.ok(pids.length > 2, 'real blank browser and helpers must be observed');
    assert.deepEqual(pgids, [coordinator]);
    process.kill(coordinator!, 'SIGKILL');
    assert.equal(await f.done, 130, f.output());
    for (const pid of pids) absent(pid);
    for (const pgid of pgids) absent(-pgid);
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    f.child.kill('SIGKILL');
  }
});

test('custodied Playwright normal close and failed launch retain coordinator control', { timeout: 30000 }, async () => {
  const browserPath = qualifiedBrowserPath();
  const f = await fixture(`
import {openSessionBrowser} from ${JSON.stringify(path.join(root, 'src/session/browser.ts'))};
import {writeFileSync} from 'node:fs';
writeFileSync('coordinator.json',JSON.stringify({coordinator:process.pid}));
const context=await openSessionBrowser({profileDirectory:process.cwd()+'/profile',executablePath:${JSON.stringify(browserPath)},headless:true,network:'loopback-only'});
await context.newPage();
await context.close();
let failed=false;
try{await openSessionBrowser({profileDirectory:process.cwd()+'/failed-profile',executablePath:'/usr/bin/false',headless:true,network:'loopback-only'});}catch{failed=true;}
if(!failed)throw new Error('test:expected_launch_failure');
console.log(JSON.stringify({schemaVersion:1,status:'complete',normalClose:true,failedLaunch:true}));
`);
  const pids = await readJSON(path.join(f.directory, 'coordinator.json'));
  try {
    assert.equal(await f.done, 0, f.output());
    assert.deepEqual(JSON.parse(f.output()), { schemaVersion: 1, status: 'complete', normalClose: true, failedLaunch: true });
    absent(pids.coordinator!); absent(-pids.coordinator!);
  } finally {
    try { process.kill(-pids.coordinator!, 'SIGKILL'); } catch {}
    f.child.kill('SIGKILL');
  }
});
