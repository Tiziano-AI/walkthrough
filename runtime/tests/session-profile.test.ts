import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createServer} from 'node:net';
import {readFileSync} from 'node:fs';
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {commandHelp} from '../src/command-help.ts';
import {inspectSession,openSession,retainedProfileDirectory} from '../src/session/index.ts';
import {SessionRuntime} from '../src/session/runtime.ts';
import type {SessionConfig,SessionInfo} from '../src/session/contracts.ts';
import {digest,infoPath} from '../src/session/journal.ts';

async function fixture(t:TestContext){
  const root=await mkdtemp('/private/tmp/wt-profile-'),projectPath=join(root,'project'),directory=join(projectPath,'sessions','original');
  await mkdir(directory,{recursive:true,mode:0o700});
  const stateRoot=join(root,'original-state'),socketRoot=join(stateRoot,'sockets');await mkdir(socketRoot,{recursive:true,mode:0o700});
  const config:SessionConfig={directory,projectId:'profile-project',projectPath,startUrl:'http://127.0.0.1/',allowedOrigins:['http://127.0.0.1'],uploadRoots:[],network:'loopback-only'};
  const info:SessionInfo={version:1,sessionId:'original',projectId:config.projectId,projectPath,directory,status:'closed',createdAt:'2026-10-08T00:00:00.000Z',updatedAt:'2026-10-08T00:00:00.000Z',captureActive:false,socketPath:join(socketRoot,`${digest(directory).slice(0,20)}.sock`)};
  const configPath=join(directory,'config.json');
  const save=async()=>{await writeFile(infoPath(directory),JSON.stringify(info));await writeFile(configPath,JSON.stringify(config));};
  const before=process.env.WALKTHROUGH_STATE_ROOT;
  process.env.WALKTHROUGH_STATE_ROOT=join(root,'different-current-state');
  t.after(async()=>{if(before===undefined)delete process.env.WALKTHROUGH_STATE_ROOT;else process.env.WALKTHROUGH_STATE_ROOT=before;await rm(root,{recursive:true,force:true});});
  return {root,stateRoot,directory,config,info,configPath,save};
}

test('new session reserves the resolved profile before any worker can launch',async t=>{
  const f=await fixture(t),stop=new Error('synthetic worker boundary: no process is spawned');
  let launches=0,expected='';
  const spawn=t.mock.method(childProcess,'spawn',()=>{
    launches++;
    const saved=JSON.parse(readFileSync(infoPath(f.directory),'utf8')) as SessionInfo;
    assert.equal(saved.status,'starting');assert.equal(saved.profileDirectory,expected);
    throw stop;
  });
  syncBuiltinESMExports();t.after(()=>{spawn.mock.restore();syncBuiltinESMExports();});
  expected=join(process.env.WALKTHROUGH_STATE_ROOT!,'profiles','original');
  await assert.rejects(openSession(f.config),error=>error===stop);
  const saved=JSON.parse(await readFile(infoPath(f.directory),'utf8')) as SessionInfo;
  assert.equal(saved.status,'interrupted');assert.equal(saved.profileDirectory,expected);
  await assert.rejects(access(expected),{code:'ENOENT'},'reserving identity does not open or create the profile');

  const other=join(f.config.projectPath,'sessions','explicit');
  expected=join(f.root,'external-profile');
  // The mock reads the exact reservation for this second independent launch.
  spawn.mock.restore();
  const explicitSpawn=t.mock.method(childProcess,'spawn',()=>{
    launches++;assert.equal(JSON.parse(readFileSync(infoPath(other),'utf8')).profileDirectory,expected);throw stop;
  });
  syncBuiltinESMExports();t.after(()=>{explicitSpawn.mock.restore();syncBuiltinESMExports();});
  await assert.rejects(openSession({...f.config,directory:other,profileDirectory:expected}),error=>error===stop);
  assert.equal(launches,2);await assert.rejects(access(expected),{code:'ENOENT'});
});

test('historical default and explicit profiles use original evidence despite a changed state root',async t=>{
  const f=await fixture(t);await f.save();
  const original=await readFile(infoPath(f.directory),'utf8'),configBefore=await readFile(f.configPath,'utf8');
  assert.equal(await retainedProfileDirectory(f.info),join(f.stateRoot,'profiles','original'));
  assert.equal(await readFile(infoPath(f.directory),'utf8'),original);
  assert.equal(await readFile(f.configPath,'utf8'),configBefore);
  assert.equal(f.info.profileDirectory,undefined,'readback must not mutate the retained record in memory');

  f.config.profileDirectory=join(f.root,'custom-authenticated-storage');await f.save();
  const explicitBefore=await readFile(f.configPath,'utf8');
  assert.equal(await retainedProfileDirectory(f.info),f.config.profileDirectory);
  assert.equal(await retainedProfileDirectory({...f.info,socketPath:'missing-original-socket'}),f.config.profileDirectory,'an explicit original profile needs no default-profile inference');
  assert.equal(await readFile(f.configPath,'utf8'),explicitBefore);
  await assert.rejects(access(f.config.profileDirectory),{code:'ENOENT'},'lookup must not inspect or create the profile');
});

test('runtime uses the retained profile and refuses unknown or inside-project identities before browser launch',async t=>{
  const f=await fixture(t),profileDirectory=join(f.stateRoot,'profiles','original'),stop=new Error('synthetic browser boundary: no browser is launched');
  const launches:string[]=[];
  t.mock.method(chromium,'launchPersistentContext',async(profile:string)=>{launches.push(profile);throw stop;});
  await assert.rejects(SessionRuntime.open(f.config,{...f.info,status:'starting',profileDirectory}),error=>error===stop);
  assert.deepEqual(launches,[profileDirectory]);
  await assert.rejects(SessionRuntime.open(f.config,{...f.info,status:'starting'}),{code:'SESSION_PROFILE_UNRESOLVED'});
  await assert.rejects(SessionRuntime.open(f.config,{...f.info,status:'starting',profileDirectory:join(f.config.projectPath,'private-profile')}),{code:'AUTH_PROFILE_INSIDE_PROJECT'});
  assert.equal(launches.length,1);
  await assert.rejects(access(join(process.env.WALKTHROUGH_STATE_ROOT!,'profiles')),{code:'ENOENT'},'the runtime must not fall back to its current state root');
});

test('missing or invalid historical evidence is unknown, never an assumed default',async t=>{
  const f=await fixture(t);
  assert.equal(await retainedProfileDirectory(f.info),null,'missing config cannot exclude an explicit original profile');
  for(const config of ['{not-json','null','{}',JSON.stringify({...f.config,directory:join(f.root,'another-session')}),JSON.stringify({...f.config,profileDirectory:'relative-profile'}),JSON.stringify({...f.config,profileDirectory:null})]){
    await writeFile(f.configPath,config);assert.equal(await retainedProfileDirectory(f.info),null,config);assert.equal(await readFile(f.configPath,'utf8'),config);
  }
  await f.save();
  for(const socketPath of ['relative.sock',join(f.root,'unrecognized','socket.sock'),join(f.stateRoot,'sockets','wrong-session.sock')])assert.equal(await retainedProfileDirectory({...f.info,socketPath}),null,socketPath);
  assert.equal(await retainedProfileDirectory({...f.info,profileDirectory:null}),null);
  assert.equal(await retainedProfileDirectory({...f.info,profileDirectory:'relative-profile'}),null);
  const retained=join(f.root,'resolved-at-launch');
  await writeFile(f.configPath,'not valid JSON');
  assert.equal(await retainedProfileDirectory({...f.info,profileDirectory:retained,socketPath:'unavailable'}),retained,'a persisted profile identity needs no reconstruction');
});

test('public inspect and same-ID open expose historical profile without writing the record or launching',async t=>{
  const f=await fixture(t);await f.save();
  const original=await readFile(infoPath(f.directory),'utf8'),configBefore=await readFile(f.configPath,'utf8');
  // This local protocol fixture supplies only the worker response. No worker,
  // browser, process reader or authenticated storage is opened.
  const server=createServer(socket=>socket.once('data',()=>socket.end(JSON.stringify({ok:true,result:{...f.info,pages:[],events:[],capture:null}})+'\n')));
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(f.info.socketPath,resolve);});
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const spawn=t.mock.method(childProcess,'spawn',()=>{throw new Error('same-ID open must not launch');});
  syncBuiltinESMExports();t.after(()=>{spawn.mock.restore();syncBuiltinESMExports();});
  const expected=join(f.stateRoot,'profiles','original');
  const inspected=await inspectSession(f.directory);
  assert.equal(inspected.session.profileDirectory,expected);assert.equal(inspected.session.status,'closed');
  const reopened=await openSession(f.config);assert.equal(reopened.profileDirectory,expected);assert.equal(reopened.sessionId,'original');
  await assert.rejects(openSession({...f.config,profileDirectory:expected}),{code:'SESSION_ID_CONFLICT'},'same launch retains its original configuration identity');
  await writeFile(f.configPath,'{}');assert.equal((await inspectSession(f.directory)).session.profileDirectory,null);
  await writeFile(f.configPath,configBefore);
  assert.equal(await readFile(infoPath(f.directory),'utf8'),original);assert.equal(await readFile(f.configPath,'utf8'),configBefore);
  assert.equal(spawn.mock.callCount(),0);
});

test('session help exposes the profile readback and new-ID reuse contract',()=>{
  const help=commandHelp('session') as {status:string;commands:string[];notes:string[]};
  assert.equal(help.status,'ok');assert.ok(help.commands.some(command=>command.startsWith('help [')&&command.includes('|session|')));
  assert.ok(help.notes.some(note=>note.includes('result.profileDirectory')&&note.includes('result.session.profileDirectory')));
  assert.ok(help.notes.some(note=>note.includes('new --id')&&note.includes('--profile')));
  assert.ok(help.notes.some(note=>note.includes('null')&&note.includes('retained evidence')));
});
