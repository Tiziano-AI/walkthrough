import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {access,cp,mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {LocalTools} from '../src/core/contracts.ts';
import {resolveLocalTools} from '../src/core/toolchain.ts';
import type {ProjectBrief} from '../src/project/contracts.ts';
import type {SessionInfo} from '../src/session/contracts.ts';
import {writeJson} from '../src/session/journal.ts';
import {processTable} from '../src/session/process.ts';

const execute=promisify(execFile),program=resolve(import.meta.dirname,'..');
async function fixture(tools?:LocalTools){
  const directory=await mkdtemp('/private/tmp/wts-public-'),state=join(directory,'state'),project=join(directory,'.walkthrough');
  if(tools){await mkdir(join(directory,'settings'),{mode:0o700});await writeFile(join(directory,'settings','toolchain.json'),JSON.stringify({schemaVersion:1,tools}));}
  const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end('<!doctype html><h1>Public session</h1><button onclick="this.textContent=\'Count 1 trusted \'+event.isTrusted">Count 0</button>');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
  const brief:ProjectBrief={title:'Public loopback session',brief:'Exercise native input',audience:'Test author',mandate:{applicationUrl:url,navigationOrigins:[new URL(url).origin],network:'loopback-only',allowedEffects:'One synthetic counter click.',dataDescription:'Synthetic fixture',inputRoots:[],mediaReview:'agent-reviewable-synthetic',delivery:'local'}};
  await writeFile(join(directory,'brief.json'),JSON.stringify(brief));
  const cli=async(args:string[],runtime=program)=>{
    let stdout:string,stderr:string,code=0;
    try{({stdout,stderr}=await execute(process.execPath,[join(runtime,'bin/walkthrough.mjs'),...args,'--json'],{cwd:directory,env:{...process.env,WALKTHROUGH_STATE_ROOT:state,WALKTHROUGH_CONFIG_ROOT:join(directory,'settings')},timeout:60000,maxBuffer:8*1024*1024}));}
    catch(error){const result=error as {stdout:string;stderr:string;code:number};stdout=result.stdout;stderr=result.stderr;code=result.code;}
    assert.equal(stderr,'');const lines=stdout.trim().split('\n');assert.equal(lines.length,1,'one public record');
    return {code,record:JSON.parse(lines[0])};
  };
  return {directory,state,project,cli,close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}};
}

test('real public launcher opens, observes, delivers trusted input, inspects and closes under the loopback sandbox',async t=>{
  const tools=resolveLocalTools();
  tools.browserPath=process.env.WALKTHROUGH_TEST_BROWSER_PATH??tools.browserPath;
  try{await access(tools.browserPath);}catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    t.skip('Install the selected browser or provide an explicit WALKTHROUGH_TEST_BROWSER_PATH. No browser is downloaded.');return;
  }
  const f=await fixture(tools);let opened=false;
  try{
    const created=await f.cli(['project','create','--path','.walkthrough','--brief','brief.json']);assert.equal(created.code,0,JSON.stringify(created.record));
    const openedResult=await f.cli(['session','open','--project',f.project,'--id','public']);assert.equal(openedResult.code,0,JSON.stringify(openedResult.record));opened=true;
    const identity=openedResult.record.result.processIdentity;assert.ok(identity.startedAt);assert.match(identity.commandSha256,/^[a-f0-9]{64}$/);
    const observation=await f.cli(['observe','--project',f.project,'--session','public']);assert.equal(observation.code,0,JSON.stringify(observation.record));
    const button=observation.record.result.refs.find((element:{name:string})=>element.name==='Count 0');assert.ok(button);
    const action={kind:'click',target:{ref:button.ref}};
    const clicked=await f.cli(['act','--project',f.project,'--session','public','--id','one-click','--data',JSON.stringify(action)]);assert.equal(clicked.record.result.status,'input-completed',JSON.stringify(clicked.record));
    assert.equal((await f.cli(['act','--project',f.project,'--session','public','--id','one-click','--data',JSON.stringify(action)])).record.result.actionId,'one-click');
    const after=await f.cli(['observe','--project',f.project,'--session','public']);assert.ok(after.record.result.refs.some((element:{name:string})=>element.name==='Count 1 trusted true'));
    const inspected=await f.cli(['session','inspect','--project',f.project,'--session','public']);assert.equal(inspected.record.result.live,true);assert.deepEqual(inspected.record.result.session.processIdentity,identity);
    assert.equal((await f.cli(['session','close','--project',f.project,'--session','public'])).record.result.status,'closed');opened=false;
    const retained=await f.cli(['session','inspect','--project',f.project,'--session','public']);assert.equal(retained.record.result.session.status,'closed');
    await assert.rejects(access(join(f.state,'active','public.json')),{code:'ENOENT'});
  }finally{
    if(opened){const closed=await f.cli(['session','close','--project',f.project,'--session','public']);assert.equal(closed.code,0,JSON.stringify(closed.record));}
    await f.close();
  }
});

test('public open refuses a missing process reader before reserving or launching a session',async()=>{
  const f=await fixture(),runtime=join(f.directory,'program');
  try{
    await mkdir(runtime);for(const path of ['bin','src','scripts/loopback-only.sb','package.json'])await cp(join(program,path),join(runtime,path),{recursive:true});
    await symlink(join(program,'node_modules'),join(runtime,'node_modules'),'dir');
    const missingDoctor=await f.cli(['doctor','--phase','capture'],runtime);assert.equal(missingDoctor.record.status,'not-ready');assert.equal(missingDoctor.record.checks.find((check:{name:string})=>check.name==='session-process-reader').detail.code,'SESSION_PROCESS_READER_NOT_PROVISIONED');
    assert.equal((await f.cli(['project','create','--path','.walkthrough','--brief','brief.json'],runtime)).code,0);
    const failed=await f.cli(['session','open','--project',f.project,'--id','original'],runtime);assert.equal(failed.record.error.code,'SESSION_PROCESS_READER_NOT_PROVISIONED');
    const directory=join(f.project,'sessions','original');
    for(const path of ['session.json','config.json','worker.log'])await assert.rejects(access(join(directory,path)),{code:'ENOENT'});
    await assert.rejects(access(join(f.state,'active','original.json')),{code:'ENOENT'});
    await assert.rejects(access(join(f.state,'profiles','original')),{code:'ENOENT'});
    // Restore only this isolated test program's explicitly provisioned bytes;
    // runtime commands do not build them or create a launch occurrence.
    await cp(join(program,'native'),join(runtime,'native'),{recursive:true});
    const readyDoctor=await f.cli(['doctor','--phase','capture'],runtime);const reader=readyDoctor.record.checks.find((check:{name:string})=>check.name==='session-process-reader');assert.equal(reader.ok,true);assert.equal(reader.detail.executable,join(runtime,'native/walkthrough-process-reader'));assert.match(reader.detail.binarySha256,/^[a-f0-9]{64}$/);
    await assert.rejects(access(join(directory,'session.json')),{code:'ENOENT'});
    await writeFile(join(runtime,'src/session/native/process-reader.c'),'changed source');
    const driftedDoctor=await f.cli(['doctor','--phase','capture'],runtime);assert.equal(driftedDoctor.record.checks.find((check:{name:string})=>check.name==='session-process-reader').ok,false);
  }finally{await f.close();}
});

test('public close refuses a starting launch, a pre-identity runtime marker and reused process identity',async()=>{
  const f=await fixture();
  try{
    const created=await f.cli(['project','create','--path','.walkthrough','--brief','brief.json']);assert.equal(created.code,0);
    const directory=join(f.project,'sessions','ambiguous');await mkdir(directory,{mode:0o700});
    const info:SessionInfo={version:1,sessionId:'ambiguous',projectId:created.record.projectId,projectPath:f.project,directory,status:'starting',createdAt:'2026-10-03',updatedAt:'2026-10-03',captureActive:false,socketPath:join(f.directory,'absent.sock'),workerToken:'no-such-starting-worker'};
    await writeJson(join(directory,'session.json'),info);
    assert.equal((await f.cli(['session','close','--project',f.project,'--session','ambiguous'])).record.error.code,'SESSION_LAUNCH_UNRESOLVED');
    info.status='interrupted';await writeJson(join(directory,'session.json'),info);await mkdir(join(f.state,'active'),{recursive:true,mode:0o700});await writeJson(join(f.state,'active','ambiguous.json'),{kind:'session',sessionId:info.sessionId,projectPath:f.project,workerToken:info.workerToken});
    assert.equal((await f.cli(['session','close','--project',f.project,'--session','ambiguous'])).record.error.code,'SESSION_LAUNCH_UNRESOLVED');await access(join(f.state,'active','ambiguous.json'));
    const own=(await processTable()).find(row=>row.pid===process.pid)!;
    info.processIdentity={pid:own.pid,pgid:own.pgid,startedAt:own.startedAt,commandSha256:'0'.repeat(64)};info.processes=[];
    await writeJson(join(directory,'session.json'),info);
    assert.equal((await f.cli(['session','close','--project',f.project,'--session','ambiguous'])).record.error.code,'SESSION_PROCESS_CUSTODY_UNCERTAIN');await access(join(f.state,'active','ambiguous.json'));process.kill(process.pid,0);
  }finally{await f.close();}
});

test('native process reader returns only hashes under sandbox and refuses arguments',async()=>{
  const secret='synthetic-process-argument-canary',script='const timer=setTimeout(()=>{},30000);process.stdout.write("ready\\n");';
  const {spawn}=await import('node:child_process');
  const child=spawn(process.execPath,['--input-type=module','-e',script,secret],{env:{...process.env,WALKTHROUGH_SYNTHETIC_ENV_CANARY:'synthetic-environment-canary'},stdio:['ignore','pipe','ignore']});
  try{
    await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.stdout!.once('data',()=>resolve());});
    const executable=join(program,'native/walkthrough-process-reader');
    const {stdout}=await execute('/usr/bin/sandbox-exec',['-f',join(program,'scripts/loopback-only.sb'),executable],{maxBuffer:16*1024*1024});
    assert.ok(!stdout.includes(secret));assert.ok(!stdout.includes('synthetic-environment-canary'));
    const row=JSON.parse(stdout).processes.find((row:{pid:number})=>row.pid===child.pid);assert.equal(row.lastArgumentSha256,createHash('sha256').update(secret).digest('hex'));assert.match(row.commandSha256,/^[a-f0-9]{64}$/);
    await assert.rejects(execute(executable,['--anything']),{code:64});
  }finally{child.kill();await new Promise<void>(resolve=>child.once('close',()=>resolve()));}
});
