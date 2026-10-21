import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {openSessionBrowser} from '../src/session/browser.ts';
import {SessionRuntime,validateCaptureRequest} from '../src/session/runtime.ts';
import type {CaptureMarkTarget,CaptureRequest,SessionConfig,SessionInfo} from '../src/session/contracts.ts';
import type {MarkTargetObservation,Box} from '../src/project/contracts.ts';

const html=`<!doctype html><style>body{margin:0}button{position:absolute;left:100px;top:80px;width:140px;height:50px}canvas{position:absolute;left:350px;top:100px;width:500px;height:300px}#offscreen{top:1300px}#scroll{position:absolute;top:500px;width:500px;height:100px;overflow:auto}</style>
<button id="subject" disabled>Visible disabled subject</button><canvas aria-label="Canvas subject" width="1000" height="600"></canvas>
<input type="file" hidden><button id="offscreen">Offscreen subject</button><div id="scroll"><div style="height:500px">Scrollable subject</div></div>
<script>window.markInputs=[];for(const type of ['pointermove','pointerdown','pointerup','keydown','keyup','wheel','scroll','focus','input'])window.addEventListener(type,event=>window.markInputs.push(event.type),true);</script>`;

type CapturedMark={id?:string;title:string;settled?:boolean;target?:Box;targetObservation?:Omit<MarkTargetObservation,'markId'>;verifyTarget?:()=>Promise<void>};
async function fixture(t:TestContext){
  const root=await mkdtemp('/private/tmp/wts-framing-'),directory=join(root,'session');
  for(const child of ['observations','capture-operations','actions'])await mkdir(join(directory,child),{recursive:true});
  const context=await openSessionBrowser({profileDirectory:join(root,'profile'),headless:true,network:'loopback-only'});
  const page=await context.newPage();await page.setContent(html);
  const config:SessionConfig={directory,projectId:'project',projectPath:root,startUrl:'http://127.0.0.1/',allowedOrigins:['http://127.0.0.1'],uploadRoots:[],network:'loopback-only',mediaReview:'agent-reviewable-synthetic'};
  const info:SessionInfo={version:1,sessionId:'framing',projectId:'project',projectPath:root,directory,status:'open',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),captureActive:true,socketPath:join(root,'unused.sock')};
  // Exercise the real observation/mark handler without starting a recorder or
  // application occurrence. Only its capture receiver is in memory.
  const runtime=new (SessionRuntime as any)(config,info,{}) as SessionRuntime,internals=runtime as any;
  internals.context=context;internals.attachPage(page,false);info.selectedPageId=internals.pageIds.get(page);
  const marks:CapturedMark[]=[];
  internals.capturePage=page;internals.captureActive=true;
  internals.capture={async mark(options:CapturedMark){await options.verifyTarget?.();marks.push(options);return {id:options.id??'mark',takeId:'take',settled:!!options.settled};},inspect(){return {state:'recording',take:null};}};
  t.after(async()=>{clearTimeout(internals.idleTimer);internals.captureActive=false;info.status='authentication';await context.close();await rm(root,{recursive:true,force:true});});
  let sequence=0;
  const mark=(target:CaptureMarkTarget)=>runtime.captureCommand({operationId:`mark-${++sequence}`,kind:'mark',request:{id:`mark-${sequence}`,title:'Observed subject',target}});
  return {runtime,internals,page,context,info,marks,mark};
}

test('observed DOM and screenshot canvas framing preserve geometry without scrolling or input',async t=>{
  const f=await fixture(t),observation=await f.runtime.observe(),subject=observation.refs.find(ref=>ref.tag==='button')!;
  const marked=await f.mark({observationId:observation.observationId,ref:subject.ref});assert.equal(marked.status,'completed',JSON.stringify(marked.error));
  assert.deepEqual(f.marks[0].target,{x:100,y:80,width:140,height:50});
  assert.deepEqual(f.marks[0].targetObservation,{observationId:observation.observationId,observedAt:observation.observedAt,pageId:observation.pageId,frameId:subject.frameId,documentId:subject.documentId,ref:subject.ref,coordinateSpace:'css',box:{x:100,y:80,width:140,height:50},viewport:{width:1600,height:900}});
  const box={x:800,y:250,width:600,height:400};
  const rectangle=await f.mark({observationId:observation.observationId,coordinateSpace:'screenshot',box});assert.equal(rectangle.status,'completed',JSON.stringify(rectangle.error));
  assert.deepEqual(observation.screenshotPixels,{width:3200,height:1800});
  assert.deepEqual(f.marks[1].target,{x:400,y:125,width:300,height:200});
  assert.deepEqual(f.marks[1].targetObservation?.box,box);assert.equal(f.marks[1].targetObservation?.coordinateSpace,'screenshot');
  assert.equal(f.marks[1].settled,undefined,'framing does not assert settlement');
  assert.deepEqual(await f.page.evaluate(()=>({x:scrollX,y:scrollY,events:(window as any).markInputs})),{x:0,y:0,events:[]});
  assert.equal(f.runtime.inputEvents.length,0);
});

test('framing rejects offscreen or absent observed geometry and never scrolls to repair it',async t=>{
  const f=await fixture(t),observation=await f.runtime.observe({screenshot:false});
  for(const subject of observation.refs.filter(ref=>ref.tag==='input'||ref.name==='Offscreen subject')){
    const result=await f.mark({observationId:observation.observationId,ref:subject.ref});assert.equal((result.error as any)?.code,'MARK_TARGET_NOT_VISIBLE');
  }
  const rectangle=await f.mark({observationId:observation.observationId,coordinateSpace:'screenshot',box:{x:10,y:10,width:20,height:20}});
  assert.equal((rectangle.error as any)?.code,'MARK_SCREENSHOT_REQUIRED');
  assert.equal(f.marks.length,0);assert.deepEqual(await f.page.evaluate(()=>({y:scrollY,events:(window as any).markInputs})),{y:0,events:[]});
});

test('framing rejects stale observations, mismatched refs, moved subjects and dispatched-input snapshots',async t=>{
  const f=await fixture(t),first=await f.runtime.observe({screenshot:false}),second=await f.runtime.observe({screenshot:false});
  assert.equal(((await f.mark({observationId:first.observationId,ref:first.refs[0].ref})).error as any)?.code,'STALE_MARK_OBSERVATION');
  assert.equal(((await f.mark({observationId:second.observationId,ref:first.refs[0].ref})).error as any)?.code,'MARK_REF_NOT_IN_OBSERVATION');
  await f.page.locator('#subject').evaluate(element=>{(element as HTMLElement).style.left='150px';});
  assert.equal(((await f.mark({observationId:second.observationId,ref:second.refs[0].ref})).error as any)?.code,'MARK_TARGET_MOVED');
  const third=await f.runtime.observe({screenshot:false});
  // Use the actual dispatch admission path; replace only application execution.
  f.internals.execute=async()=>{};
  assert.equal((await f.runtime.dispatch({actionId:'dispatched',action:{kind:'navigate',url:'http://127.0.0.1/'}})).status,'input-completed');
  assert.equal(((await f.mark({observationId:third.observationId,ref:third.refs[0].ref})).error as any)?.code,'STALE_MARK_OBSERVATION');
  assert.equal(f.marks.length,0);
});

test('framing rejects changed document, selected page, viewport and nested scroll geometry',async t=>{
  const f=await fixture(t),first=await f.runtime.observe();
  const rectangle=(observationId:string)=>({observationId,coordinateSpace:'screenshot' as const,box:{x:400,y:300,width:200,height:100}});
  await f.page.locator('#scroll').evaluate(element=>{element.scrollTop=50;});
  assert.equal(((await f.mark(rectangle(first.observationId))).error as any)?.code,'MARK_VIEW_CHANGED');
  const second=await f.runtime.observe();await f.page.setViewportSize({width:1500,height:900});
  assert.equal(((await f.mark(rectangle(second.observationId))).error as any)?.code,'MARK_VIEW_CHANGED');
  await f.page.setViewportSize({width:1600,height:900});const third=await f.runtime.observe();
  await f.page.goto('about:blank');
  assert.equal(((await f.mark(rectangle(third.observationId))).error as any)?.code,'MARK_DOCUMENT_CHANGED');
  const other=await f.context.newPage();f.internals.attachPage(other,false);f.info.selectedPageId=f.internals.pageIds.get(other);
  const originalCapture=f.internals.capture;
  assert.equal(((await f.mark(rectangle(third.observationId))).error as any)?.code,'CAPTURE_PAGE_MISMATCH');
  assert.equal(f.internals.capture,originalCapture,'mismatch cannot replace the active source receiver');
  assert.equal(f.marks.length,0);
});

test('frame-local document identity is checked even when the main document remains current',async t=>{
  const f=await fixture(t);await f.page.setContent('<iframe srcdoc="<button>Child subject</button>"></iframe>');
  await f.page.frames()[1].waitForSelector('button');
  const observed=await f.runtime.observe({screenshot:false}),child=observed.refs.find(ref=>ref.name==='Child subject')!;assert.ok(child);
  await f.page.frames()[1].goto('about:blank');
  assert.equal(((await f.mark({observationId:observed.observationId,ref:child.ref})).error as any)?.code,'MARK_DOCUMENT_CHANGED');
});

test('DOM framing rejects geometry hidden by a clipping container or iframe viewport',async t=>{
  const f=await fixture(t);
  await f.page.setContent('<div style="width:50px;height:50px;overflow:hidden"><button style="margin-top:100px">Clipped subject</button></div><iframe style="width:300px;height:100px" srcdoc="<button style=\'margin-top:200px\'>Child clipped subject</button>"></iframe>');
  await f.page.frames()[1].waitForSelector('button');
  const observed=await f.runtime.observe({screenshot:false});
  for(const subject of observed.refs.filter(ref=>ref.tag==='button'))assert.equal(((await f.mark({observationId:observed.observationId,ref:subject.ref})).error as any)?.code,'MARK_TARGET_NOT_VISIBLE');
  assert.equal(f.marks.length,0);
});

test('capture target request accepts only observed refs or explicit screenshot-pixel rectangles',()=>{
  const request=(target:unknown)=>({operationId:'mark',kind:'mark',request:{title:'Subject',target}} as CaptureRequest);
  for(const target of [{observationId:'observation',ref:'ref'},{observationId:'observation',coordinateSpace:'screenshot',box:{x:0,y:0,width:3200,height:1800}}])assert.doesNotThrow(()=>validateCaptureRequest(request(target)));
  for(const target of [null,{x:0,y:0,width:20,height:20},{ref:'ref'},{observationId:'observation',ref:'ref',coordinateSpace:'css'},
    {observationId:'observation',coordinateSpace:'css',box:{x:0,y:0,width:20,height:20}},
    {observationId:'observation',coordinateSpace:'screenshot',box:{x:0,y:0,width:0,height:20}},
    {observationId:'observation',coordinateSpace:'screenshot',box:{x:0,y:0,width:20,height:Infinity}}])assert.throws(()=>validateCaptureRequest(request(target)),{code:'INVALID_CAPTURE_TARGET'});
});
