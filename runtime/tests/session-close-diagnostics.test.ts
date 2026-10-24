import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {SessionRuntime} from '../src/session/runtime.ts';
import {SessionError,type SessionClosePhase,type SessionConfig,type SessionInfo,type SessionRuntimeOptions} from '../src/session/contracts.ts';

/** Replace only external close boundaries. The original close attempt, journal
 * and marker handling run unchanged; no browser or application is opened. */
async function fixture(t:TestContext,options:SessionRuntimeOptions={}){
  const root=await mkdtemp('/private/tmp/wts-close-unit-'),directory=join(root,'session'),state=join(root,'state');
  const previousState=process.env.WALKTHROUGH_STATE_ROOT;process.env.WALKTHROUGH_STATE_ROOT=state;
  await mkdir(directory);await mkdir(join(state,'active'),{recursive:true});
  const config:SessionConfig={directory,projectId:'project',projectPath:root,startUrl:'http://127.0.0.1/',allowedOrigins:['http://127.0.0.1'],uploadRoots:[],network:'loopback-only'};
  const info:SessionInfo={version:1,sessionId:'close-unit',projectId:'project',projectPath:root,directory,status:'open',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),captureActive:false,socketPath:join(root,'unused.sock'),workerToken:'owned-token'};
  const marker=join(state,'active','close-unit.json');
  await writeFile(marker,JSON.stringify({kind:'session',sessionId:info.sessionId,projectPath:root,workerToken:info.workerToken}));
  const phases:SessionClosePhase[]=[],releases:Array<()=>void>=[];
  const runtime=new (SessionRuntime as any)(config,info,{...options,onClosePhase:(phase:SessionClosePhase)=>{phases.push(phase);return options.onClosePhase?.(phase);}}) as SessionRuntime,internals=runtime as any;
  internals.context={close:async()=>{}};
  t.after(async()=>{
    for(const release of releases)release();await internals.closing?.catch(()=>{});
    if(previousState===undefined)delete process.env.WALKTHROUGH_STATE_ROOT;else process.env.WALKTHROUGH_STATE_ROOT=previousState;
    await rm(root,{recursive:true,force:true});
  });
  const boundary=()=>{
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0;
    releases.push(release.resolve);
    return {entered:entered.promise,release:release.resolve,calls:()=>calls,block:()=>{calls++;entered.resolve();return release.promise;}};
  };
  return {runtime,internals,info,phases,marker,directory,boundary};
}

const blockedPhases:Array<{phase:SessionClosePhase;prepare:(internals:any,block:()=>Promise<void>)=>void}>=[
  {phase:'print-close',prepare:(runtime,block)=>{runtime.pendingPrintPreview={};runtime.closePrint=block;}},
  {phase:'print-discovery-cancel',prepare:(runtime,block)=>{runtime.pendingPrintDiscovery={cancel:block,completion:Promise.resolve()};}},
  {phase:'print-discovery-settle',prepare:(runtime,block)=>{runtime.pendingPrintDiscovery={cancel:async()=>{},completion:block()};}},
  {phase:'context-close-before-capture',prepare:(runtime,block)=>{runtime.dialogs.set('owned',{});runtime.context.close=block;}},
  {phase:'capture-stop',prepare:(runtime,block)=>{runtime.stopCapture=block;}},
  {phase:'context-close',prepare:(runtime,block)=>{runtime.context.close=block;}},
  {phase:'parked-capture-stop',prepare:(runtime,block)=>{runtime.parkedCapture={capture:{stop:block},page:{isClosed:()=>true}};}},
  {phase:'print-dispose',prepare:(runtime,block)=>{runtime.prints.set('owned',{dispose:block});}},
  {phase:'input-dispose',prepare:(runtime,block)=>{runtime.inputs.set('owned',{dispose:block});}},
  {phase:'pending-input-settle',prepare:(runtime,block)=>{runtime.pendingInput={completion:block()};}},
  {phase:'events-settle',prepare:(runtime,block)=>{runtime.pendingEvents.add(block());}},
];

for(const {phase,prepare} of blockedPhases)test(`close retains its visible ${phase} boundary while the original operation is pending`,{timeout:10000},async t=>{
  const reported=Promise.withResolvers<void>();
  const f=await fixture(t,{onClosePhase:value=>{if(value===phase)reported.resolve();}}),boundary=f.boundary();prepare(f.internals,boundary.block);
  let settled=false;const first=f.runtime.close('original-close');void first.then(()=>{settled=true;},()=>{settled=true;});
  // Some retained completion promises already exist before close starts.
  // Wait for both their controlled boundary and the actual drain phase.
  await Promise.all([boundary.entered,reported.promise]);
  assert.equal(settled,false);assert.equal(f.phases.at(-1),phase);assert.equal(boundary.calls(),1);
  assert.equal(f.runtime.close('not-a-new-attempt'),first);assert.equal(f.phases.filter(value=>value==='starting').length,1);
  boundary.release();await first;
  assert.equal(f.runtime.close(),first);assert.equal(f.phases.at(-1),'closed');assert.equal(f.info.closeReason,'original-close');
  assert.equal(JSON.parse(await readFile(join(f.directory,'session.json'),'utf8')).status,'closed');
  await assert.rejects(access(f.marker),{code:'ENOENT'});
});

test('close diagnostics cannot replace the original failure or strand its retained attempt',async t=>{
  const original=new SessionError('ORIGINAL_CLOSE_FAILURE','Private original failure'),diagnostic=new Error('Private diagnostic failure');let closed=0;
  const f=await fixture(t,{onClosed:()=>{closed++;},onClosePhase:phase=>{
    if(phase==='starting')throw diagnostic;
    if(phase==='context-close')return Promise.reject(diagnostic);
    if(phase==='failed')return new Promise<void>(()=>{});
  }});
  f.internals.context.close=async()=>{throw original;};
  f.internals.inputs.set('owned',{dispose:async()=>{throw new Error('Ignored input disposal failure');}});
  const first=f.runtime.close('original-close');await assert.rejects(first,error=>error===original);
  assert.equal(f.runtime.close(),first);await assert.rejects(f.runtime.close(),error=>error===original);
  assert.equal(closed,1);assert.equal(f.info.status,'interrupted');assert.equal(f.phases.at(-1),'failed');
  assert.ok(!f.phases.includes('marker-remove'));await access(f.marker);
});

test('a reentrant diagnostic observer rejoins the promise retained before its first phase',async t=>{
  let runtime:SessionRuntime,rejoined:Promise<void>|undefined;
  const f=await fixture(t,{onClosePhase:phase=>{if(phase==='starting')rejoined=runtime.close('reentrant');}});runtime=f.runtime;
  const first=runtime.close('original-close');assert.equal(rejoined,first);await first;
  assert.equal(f.phases.filter(phase=>phase==='starting').length,1);assert.equal(f.info.closeReason,'original-close');
});

test('close reports a terminal failure when the original session journal cannot be saved',async t=>{
  const f=await fixture(t);await rm(f.directory,{recursive:true});
  await assert.rejects(f.runtime.close(),{code:'ENOENT'});
  assert.deepEqual(f.phases.slice(-2),['journal-save','failed']);await access(f.marker);
});

test('close reports marker-removal failure without losing the original custody marker',async t=>{
  const f=await fixture(t),foreign=JSON.stringify({kind:'foreign'});await writeFile(f.marker,foreign);
  await assert.rejects(f.runtime.close(),{code:'SESSION_MARKER_IDENTITY_CONFLICT'});
  assert.deepEqual(f.phases.slice(-2),['marker-remove','failed']);assert.equal(await readFile(f.marker,'utf8'),foreign);
});
