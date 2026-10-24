import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Failure} from '../src/core/contracts.ts';
import {SessionRuntime} from '../src/session/runtime.ts';
import type {CaptureRequest,SessionConfig,SessionInfo} from '../src/session/contracts.ts';

/** Keep the real operation journal, admission and close flow. Only the browser,
 * input and recorder boundaries are in memory; no browser or media is opened. */
async function fixture(t:TestContext,options:{startError?:Error;sampleError?:Error;active?:boolean}={}){
  const root=await mkdtemp('/private/tmp/wts-capture-start-unit-'),directory=join(root,'session'),state=join(root,'state');
  const previous=process.env.WALKTHROUGH_STATE_ROOT;process.env.WALKTHROUGH_STATE_ROOT=state;
  for(const child of ['actions','observations','capture-operations'])await mkdir(join(directory,child),{recursive:true});
  await mkdir(join(state,'active'),{recursive:true});
  const config:SessionConfig={directory,projectId:'project',projectPath:root,startUrl:'http://127.0.0.1/',allowedOrigins:['http://127.0.0.1'],uploadRoots:[],network:'loopback-only',mediaReview:'agent-reviewable-synthetic'};
  const info:SessionInfo={version:1,sessionId:'capture-start-unit',projectId:'project',projectPath:root,directory,status:'open',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),captureActive:!!options.active,selectedPageId:'page-unit',socketPath:join(root,'unused.sock'),workerToken:'owned-token'};
  const marker=join(state,'active',`${info.sessionId}.json`);
  await writeFile(marker,JSON.stringify({kind:'session',sessionId:info.sessionId,projectPath:root,workerToken:info.workerToken}));
  const runtime=new (SessionRuntime as any)(config,info,{}) as SessionRuntime,internals=runtime as any;
  const calls={start:0,stop:0,mark:0,contextClose:0,sample:0,ready:0,navigate:0,flush:0,dispose:0,pageEvaluation:0};
  let pageClosed=false;
  const forbiddenEvaluation=async()=>{calls.pageEvaluation++;throw new Error('Unexpected page evaluation or guessed slate removal');};
  const page={isClosed:()=>pageClosed,url:()=>config.startUrl,title:async()=>'Synthetic page',evaluate:forbiddenEvaluation,evaluateHandle:forbiddenEvaluation};
  const capture={
    inspect:()=>({state:internals.captureActive?'recording':'idle',take:{id:'take-original',state:options.startError?'failed':'recording',marks:[]}}),
    start:async()=>{calls.start++;if(options.startError)throw options.startError;return {state:'recording',take:{id:'take-original'}};},
    stop:async()=>{calls.stop++;return {id:'take-original',state:'stopped'};},
    mark:async()=>{calls.mark++;return {id:'mark-original',takeId:'take-original',settled:false};},
  };
  internals.context={close:async()=>{calls.contextClose++;pageClosed=true;}};
  internals.pages.set(info.selectedPageId,page);internals.pageIds.set(page,info.selectedPageId);
  internals.capture=capture;internals.capturePage=page;internals.captureActive=!!options.active;
  internals.inputs.set(page,{samplePointer:async()=>{calls.sample++;if(options.sampleError)throw options.sampleError;},ready:async()=>{calls.ready++;},navigate:async()=>{calls.navigate++;},flush:async()=>{calls.flush++;},dispose:async()=>{calls.dispose++;}});
  t.after(async()=>{
    clearTimeout(internals.idleTimer);await internals.closing?.catch(()=>{});
    if(previous===undefined)delete process.env.WALKTHROUGH_STATE_ROOT;else process.env.WALKTHROUGH_STATE_ROOT=previous;
    await rm(root,{recursive:true,force:true});
  });
  const operation=(id:string)=>join(directory,'capture-operations',`${id}.json`);
  return {runtime,internals,info,calls,marker,operation,directory};
}

test('a rejected recorder start fences the original session and rejoins its retained operation without retry',async t=>{
  const original=new Failure('ORIGINAL_START_FAILURE','capture','The synthetic recorder could not prove that its starting slate was removed.');
  const f=await fixture(t,{startError:original});
  const request:CaptureRequest={operationId:'original-start',kind:'start',request:{title:'Original attempted take'}};
  const failed=await f.runtime.captureCommand(request);
  assert.equal(failed.status,'outcome-uncertain');
  const error=failed.error as {code:string;message:string;recovery?:string};
  assert.equal(error.code,original.code,'containment must not replace the original recorder failure');
  assert.ok(`${error.message} ${error.recovery??''}`.includes(original.recovery),'the original retained recovery diagnostic must survive containment');
  const guidance=`${error.message} ${error.recovery??''}`;
  assert.match(guidance,/close/i);assert.match(guidance,/(?:same|original) session|session.{0,40}(?:same|original)/i,'the operation must direct the caller to close this session, not retry capture or remove an assumed overlay');
  assert.equal(f.info.status,'interrupted');assert.equal(f.info.closeReason,'capture-start-failed');assert.equal(f.info.captureActive,false);
  const saved=JSON.parse(await readFile(join(f.directory,'session.json'),'utf8'));
  assert.equal(saved.status,'interrupted');assert.equal(saved.closeReason,'capture-start-failed');
  assert.deepEqual(JSON.parse(await readFile(f.operation(request.operationId),'utf8')),failed);
  await access(f.marker);
  assert.equal(f.calls.start,1);assert.equal(f.calls.stop,0);assert.equal(f.calls.pageEvaluation,0);assert.equal(f.calls.contextClose,0);assert.equal(f.calls.sample,0);

  const originalBytes=await readFile(f.operation(request.operationId),'utf8');
  assert.deepEqual(await f.runtime.captureCommand(request),failed,'repeating the same operation ID must read the original failure even though the session is fenced');
  assert.equal(await readFile(f.operation(request.operationId),'utf8'),originalBytes,'reconciliation must not rewrite the original operation as a new attempt');
  assert.equal(f.calls.start,1);
  await assert.rejects(()=>f.runtime.captureCommand({...request,request:{title:'Different payload'}}),{code:'CAPTURE_OPERATION_ID_CONFLICT'});
  await assert.rejects(()=>f.runtime.observe(),{code:'SESSION_NOT_OPEN'});
  await assert.rejects(()=>f.runtime.dispatch({actionId:'new-input',action:{kind:'navigate',url:'http://127.0.0.1/next'}}),{code:'SESSION_NOT_OPEN'});
  for(const next of [{operationId:'new-start',kind:'start'},{operationId:'new-mark',kind:'mark',request:{title:'No new mark'}},{operationId:'new-stop',kind:'stop'}] satisfies CaptureRequest[]){
    await assert.rejects(()=>f.runtime.captureCommand(next),{code:'SESSION_NOT_OPEN'});
  }
  assert.equal(f.calls.start,1);assert.equal(f.calls.stop,0);assert.equal(f.calls.mark,0);assert.equal(f.calls.ready,0);assert.equal(f.calls.navigate,0);assert.equal(f.calls.pageEvaluation,0);assert.equal(f.calls.contextClose,0,'containment must leave the original context owned until explicit close');

  await f.runtime.close('explicit-original-close');
  assert.equal(f.calls.contextClose,1);assert.equal(f.calls.stop,0,'a failed start must not guess a second recorder operation while closing its context');
  assert.equal(f.info.status,'closed');await assert.rejects(access(f.marker),{code:'ENOENT'});
  assert.deepEqual(await f.runtime.captureCommand(request),failed,'a closed runtime must still return an existing operation without sending it again');
  assert.equal(f.calls.start,1);assert.equal(f.calls.contextClose,1);
});

test('a successful recorder start keeps its session usable and original operation replay does not start again',async t=>{
  const f=await fixture(t),request:CaptureRequest={operationId:'successful-start',kind:'start',request:{title:'Successful take'}};
  const started=await f.runtime.captureCommand(request);
  assert.equal(started.status,'completed');assert.equal(started.error,undefined);
  assert.equal(f.info.status,'open');assert.equal(f.info.closeReason,undefined);assert.equal(f.info.captureActive,true);
  assert.equal(f.calls.start,1);assert.equal(f.calls.sample,1);assert.equal(f.calls.contextClose,0);
  assert.deepEqual(await f.runtime.captureCommand(request),started);assert.equal(f.calls.start,1);
  const marked=await f.runtime.captureCommand({operationId:'successful-mark',kind:'mark',request:{title:'Observed response'}});
  assert.equal(marked.status,'completed');assert.equal(f.calls.mark,1);assert.equal(f.info.status,'open');
  await f.runtime.close('explicit-success-close');assert.equal(f.calls.stop,1);assert.equal(f.calls.contextClose,1);assert.equal(f.info.status,'closed');
});

test('a start rejected before recorder dispatch does not fence an already active session',async t=>{
  const f=await fixture(t,{active:true}),request:CaptureRequest={operationId:'already-active',kind:'start',request:{title:'Not a second take'}};
  const refused=await f.runtime.captureCommand(request);
  assert.equal(refused.status,'outcome-uncertain');assert.equal((refused.error as {code:string}).code,'CAPTURE_ALREADY_ACTIVE');
  assert.equal(f.calls.start,0);assert.equal(f.info.status,'open');assert.equal(f.info.closeReason,undefined);assert.equal(f.info.captureActive,true);
  assert.deepEqual(await f.runtime.captureCommand(request),refused);assert.equal(f.calls.start,0);
  const marked=await f.runtime.captureCommand({operationId:'mark-after-refusal',kind:'mark',request:{title:'Original active take still works'}});
  assert.equal(marked.status,'completed');assert.equal(f.calls.mark,1);assert.equal(f.info.status,'open');
  await f.runtime.close('explicit-preflight-close');assert.equal(f.calls.stop,1);assert.equal(f.calls.contextClose,1);
});

test('pointer sampling failure after a successful start retains the owned capture without fencing its session',async t=>{
  const original=new Failure('POINTER_SAMPLE_FAILURE','input','Inspect the retained pointer sample without repeating capture start.');
  const f=await fixture(t,{sampleError:original}),request:CaptureRequest={operationId:'sample-failed-after-start',kind:'start',request:{title:'Recorder already started'}};
  const recorded=await f.runtime.captureCommand(request);
  assert.equal(recorded.status,'outcome-uncertain');assert.equal((recorded.error as {code:string}).code,original.code);
  assert.deepEqual(recorded.result,{state:'recording',take:{id:'take-original'}},'the successful recorder result must remain owned despite the later pointer evidence failure');
  assert.equal(f.info.status,'open');assert.equal(f.info.closeReason,undefined);assert.equal(f.info.captureActive,true);
  const saved=JSON.parse(await readFile(join(f.directory,'session.json'),'utf8'));
  assert.equal(saved.status,'open');assert.equal(saved.captureActive,true);assert.equal(saved.closeReason,undefined);
  assert.equal(f.calls.start,1);assert.equal(f.calls.sample,1);assert.equal(f.calls.stop,0);assert.equal(f.calls.contextClose,0);
  assert.deepEqual(await f.runtime.captureCommand(request),recorded);assert.equal(f.calls.start,1);assert.equal(f.calls.sample,1);
  const marked=await f.runtime.captureCommand({operationId:'mark-owned-capture',kind:'mark',request:{title:'Still the same live capture'}});
  assert.equal(marked.status,'completed');assert.equal(f.calls.mark,1);assert.equal(f.info.status,'open');
  await f.runtime.close('explicit-sample-failure-close');
  assert.equal(f.calls.stop,1,'explicit close must stop the already returned recorder handle once');
  assert.equal(f.calls.contextClose,1);assert.equal(f.calls.start,1);assert.equal(f.calls.pageEvaluation,0);assert.equal(f.info.status,'closed');
  await assert.rejects(access(f.marker),{code:'ENOENT'});
});
