import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {SessionRuntime} from '../src/session/runtime.ts';
import {retainPrintArtifact,verifiedPdfArtifact} from '../src/session/print-artifact.ts';
import {writeJson} from '../src/session/journal.ts';
import {SessionError,type SessionEvent} from '../src/session/contracts.ts';

async function fixture(){
  const directory=await mkdtemp('/private/tmp/walkthrough-native-runtime-');
  for(const name of ['actions','downloads','observations'])await mkdir(join(directory,name),{mode:0o700});
  const config={directory,projectId:'project',projectPath:directory,startUrl:'http://127.0.0.1/',allowedOrigins:['http://127.0.0.1'],uploadRoots:[],network:'loopback-only',mediaReview:'agent-reviewable-synthetic'};
  const info={version:1,sessionId:'session',projectId:'project',projectPath:directory,directory,status:'open',createdAt:'date',updatedAt:'date',captureActive:false,socketPath:join(directory,'none.sock'),selectedPageId:'source'};
  const runtime=new (SessionRuntime as any)(config,info,{});
  return {runtime,directory,dispose:async()=>{clearTimeout(runtime.idleTimer);await runtime.eventWrites;await rm(directory,{recursive:true,force:true});}};
}
function setupPrint(runtime:any,logs:string[],nativeStopFails=false){
  const source={isClosed:()=>false,url:()=> 'http://127.0.0.1/',title:async()=>{logs.push('title');return 'source';}};
  const preview={pageId:'print-one',sourcePageId:'source',actionId:'print-action',targetId:'target',closed:false,
    prepareGeometry:async()=>{logs.push('geometry');},close:async()=>{logs.push('close-preview');preview.closed=true;},dispose:async()=>{logs.push('dispose');}};
  const sourceCapture={inspect:()=>({take:{id:'source-take'},state:'recording'}),stop:async()=>{logs.push('stop-source');return {id:'source-take'};}};
  const nativeCapture={inspect:()=>({take:{id:'native-take'},state:'recording'}),stop:async()=>{logs.push('stop-native');if(nativeStopFails)throw new Error('native-finalization');return {id:'native-take'};}};
  runtime.pages.set('source',source);runtime.pageIds.set(source,'source');runtime.prints.set('print-one',preview);runtime.inputs.set(source,{flush:async()=>{logs.push('flush-source');}});
  runtime.capture=sourceCapture;runtime.capturePage=source;runtime.captureActive=true;runtime.pendingPrintSource=source;runtime.pendingPrintPreview=preview;
  return {source,preview,nativeCapture};
}
function expectedPrint(runtime:any,targets:()=>string[],onClose=()=>{}){
  const root=new EventEmitter() as any;let reads=0,detaches=0,closed=false;
  root.detach=async()=>{detaches++;};
  root.send=async(method:string,params:any)=>{
    if(method==='Target.getTargetInfo')return {targetInfo:{targetId:'source',browserContextId:'owned'}};
    if(method==='Target.getTargets')return {targetInfos:(reads++===0||closed?[]:targets()).map(targetId=>({targetId,type:'page',url:'chrome://print/',browserContextId:'owned'}))};
    if(method==='Target.attachToTarget')return {sessionId:'native-lease'};
    if(method==='Target.sendMessageToTarget'){
      const command=JSON.parse(params.message);
      const result=command.method==='Runtime.evaluate'?{result:{value:{x:100,y:100}}}:{};
      queueMicrotask(()=>{
        root.emit('Target.receivedMessageFromTarget',{sessionId:params.sessionId,message:JSON.stringify({id:command.id,result})});
        if(command.method==='Input.dispatchMouseEvent'&&command.params.type==='mouseReleased'){
          const ids=targets();closed=true;for(const targetId of ids)root.emit('Target.targetDestroyed',{targetId});onClose();
        }
      });
      return {};
    }
    assert.notEqual(method,'Target.closeTarget');
    return {};
  };
  const source={isClosed:()=>false,url:()=> 'http://127.0.0.1/'};
  runtime.pages.set('source',source);runtime.pageIds.set(source,'source');runtime.context={newCDPSession:async()=>root};
  return {source,detaches:()=>detaches};
}
test('failed discovery preserves late input completion, explicit resolution and the block against another action',async()=>{
  for(const failure of ['ambiguous','missing'] as const){
    const f=await fixture();let finish!:()=>void;
    try{
      expectedPrint(f.runtime,()=>{if(failure==='missing')throw new SessionError('NATIVE_PRINT_NOT_OBSERVED');return ['one','two'];});
      f.runtime.execute=()=>new Promise<void>(resolve=>{finish=resolve;});
      const request={actionId:'original',action:{kind:'keys',keys:'Meta+P',expectPrintPreview:true}};
      const result=await f.runtime.dispatch(request),pending=f.runtime.pendingInput;
      const code=failure==='ambiguous'?'NATIVE_PRINT_AMBIGUOUS':'NATIVE_PRINT_NOT_OBSERVED';
      assert.equal(result.error.code,code);assert.ok(pending);
      await assert.rejects(f.runtime.preflightAction({kind:'keys',keys:'X'}),{code:'NATIVE_PRINT_UNRESOLVED'});
      await f.runtime.resolveAction('original',{outcome:'uncertain',note:'The original print remains unassociated.'});
      finish();await pending.completion;
      const saved=JSON.parse(await readFile(join(f.directory,'actions','original.json'),'utf8'));
      assert.equal(saved.status,'outcome-uncertain');assert.equal(saved.error.code,code);assert.ok(saved.completedAtMs);
      assert.equal(saved.result.print.input.status,'completed');assert.equal(saved.result.print.discovery.status,'failed');
      assert.equal(saved.resolution.note,'The original print remains unassociated.');
      await assert.rejects(f.runtime.preflightAction({kind:'keys',keys:'X'}),{code:'NATIVE_PRINT_UNRESOLVED'});
      assert.deepEqual(await f.runtime.dispatch(request),saved);
    }finally{await f.dispose();}
  }
});
test('rejected original input does not cancel discovery of its surviving preview',async()=>{
  const f=await fixture();
  try{
    const native=expectedPrint(f.runtime,()=>['one']);f.runtime.execute=async()=>{throw new Error('input-response-lost');};
    const result=await f.runtime.dispatch({actionId:'original',action:{kind:'keys',keys:'Meta+P',expectPrintPreview:true}});
    assert.equal(result.status,'outcome-uncertain');assert.equal(result.error.message,'input-response-lost');assert.ok(result.result.pageId);
    assert.equal(native.detaches(),0);assert.equal(f.runtime.pendingPrint().pageId,result.result.pageId);
    await f.runtime.pendingPrint().dispose();
  }finally{await f.dispose();}
});
test('input failure and ambiguous discovery retain their distinct outcomes in the same action',async()=>{
  const f=await fixture();
  try{
    expectedPrint(f.runtime,()=>['one','two']);f.runtime.execute=async()=>{throw new Error('input-response-lost');};
    await f.runtime.dispatch({actionId:'original',action:{kind:'keys',keys:'Meta+P',expectPrintPreview:true}});
    const saved=JSON.parse(await readFile(join(f.directory,'actions','original.json'),'utf8'));
    assert.deepEqual(saved.result.print.input,{status:'failed',error:{code:'SESSION_OPERATION_FAILED',message:'input-response-lost'}});
    assert.equal(saved.result.print.discovery.status,'failed');assert.equal(saved.result.print.discovery.error.code,'NATIVE_PRINT_AMBIGUOUS');
    await assert.rejects(f.runtime.preflightAction({kind:'keys',keys:'X'}),{code:'NATIVE_PRINT_UNRESOLVED'});
  }finally{await f.dispose();}
});
test('confirmation acceptance keeps the same print discovery and does not wait for the suspended source',async()=>{
  const f=await fixture();let accepted=false,finish!:()=>void;
  try{
    const {source}=expectedPrint(f.runtime,()=>accepted?['one']:[],()=>finish());
    f.runtime.inputs.set(source,{ready:async()=>{},flush:async()=>{},keys:async()=>{
      f.runtime.dialogs.set('confirm',{pageId:'source',dialog:{accept:async()=>{accepted=true;}}});f.runtime.dialogWake?.();
      await new Promise<void>(resolve=>{finish=resolve;});
    }});
    const original=await f.runtime.dispatch({actionId:'original',action:{kind:'keys',keys:'Meta+P',expectPrintPreview:true}});
    assert.equal(original.error.code,'DIALOG_PENDING');
    const answer=await f.runtime.dispatch({actionId:'answer',action:{kind:'dialog',dialogId:'confirm',response:'accept'}});
    assert.equal(answer.status,'input-completed');assert.ok(f.runtime.pendingInput);assert.ok(f.runtime.pendingPrint());
    const event=f.runtime.events.find((event:SessionEvent)=>event.kind==='print-preview');assert.equal(event.actionId,'original');assert.ok(original.eventIds.includes(event.eventId));assert.ok(!answer.eventIds.includes(event.eventId));
    await f.runtime.dispatch({actionId:'close-print',action:{kind:'close-print-preview',pageId:f.runtime.pendingPrint().pageId}});
    const saved=JSON.parse(await readFile(join(f.directory,'actions','original.json'),'utf8'));assert.equal(saved.status,'input-completed');
  }finally{await f.dispose();}
});
test('selection parks the suspended source without stopping/flushing it, close orders native then source',async()=>{
  const f=await fixture(),logs:string[]=[];
  try{
    const {preview,nativeCapture}=setupPrint(f.runtime,logs);
    await f.runtime.execute({kind:'select-page',pageId:'print-one'});
    assert.deepEqual(logs,['geometry']);assert.equal(f.runtime.parkedCapture.capture.inspect().take.id,'source-take');
    f.runtime.capture=nativeCapture;f.runtime.captureNative=preview;f.runtime.captureActive=true;
    await f.runtime.closePrint(preview);
    assert.deepEqual(logs,['geometry','stop-native','close-preview','flush-source','stop-source','flush-source','dispose']);
    assert.equal(f.runtime.parkedCapture,undefined);assert.equal(f.runtime.info.selectedPageId,'source');assert.equal(f.runtime.captureActive,false);
  }finally{await f.dispose();}
});
test('failed native finalization does not lose the parked source or issue another stop',async()=>{
  const f=await fixture(),logs:string[]=[];
  try{
    const {preview,nativeCapture}=setupPrint(f.runtime,logs,true);await f.runtime.execute({kind:'select-page',pageId:'print-one'});
    f.runtime.capture=nativeCapture;f.runtime.captureNative=preview;f.runtime.captureActive=true;
    await assert.rejects(f.runtime.closePrint(preview),/native-finalization/);
    assert.equal(logs.filter(item=>item==='stop-native').length,1);assert.equal(logs.filter(item=>item==='stop-source').length,1);assert.ok(logs.indexOf('close-preview')<logs.indexOf('stop-source'));
    assert.equal(f.runtime.info.selectedPageId,'source');assert.equal(f.runtime.parkedCapture,undefined);
  }finally{await f.dispose();}
});
test('unsettled original input reaches exact context shutdown before finalizing the parked recorder',async t=>{
  const f=await fixture(),logs:string[]=[];let finish!:()=>void;
  try{
    t.mock.timers.enable({apis:['setTimeout']});
    const {source,preview,nativeCapture}=setupPrint(f.runtime,logs);await f.runtime.execute({kind:'select-page',pageId:'print-one'});
    f.runtime.capture=nativeCapture;f.runtime.captureNative=preview;f.runtime.captureActive=true;
    const original=new Promise<void>(resolve=>{finish=resolve;});
    f.runtime.pendingInput={record:{actionId:'original-print'},completion:original};f.runtime.pendingEvents.add(original);
    f.runtime.context={close:async()=>{logs.push('close-context');source.isClosed=()=>true;finish();}};
    f.runtime.inputs.get(source).dispose=async()=>{logs.push('dispose-input');};
    const closing=f.runtime.close();const rejected=assert.rejects(closing,{code:'NATIVE_PRINT_INPUT_UNSETTLED'});
    for(let turn=0;turn<40;turn++)await Promise.resolve();
    assert.equal(logs.includes('close-preview'),true);assert.equal(logs.includes('close-context'),false);assert.ok(f.runtime.parkedCapture);
    t.mock.timers.tick(5000);await rejected;
    assert.ok(logs.indexOf('close-context')<logs.indexOf('stop-source'));
    assert.equal(logs.filter(value=>value==='stop-native').length,1);assert.equal(logs.filter(value=>value==='stop-source').length,1);
    assert.equal(f.runtime.parkedCapture,undefined);assert.equal(f.runtime.info.status,'interrupted');
    assert.equal(await original,undefined);
  }finally{t.mock.timers.reset();await f.dispose();}
});
test('failed native Cancel reaches exact context shutdown without flushing the suspended source first',async()=>{
  const f=await fixture(),logs:string[]=[];
  try{
    const {source,preview}=setupPrint(f.runtime,logs);
    preview.close=async()=>{logs.push('close-preview');throw new SessionError('NATIVE_PRINT_CLOSE_UNCERTAIN');};
    f.runtime.context={close:async()=>{logs.push('close-context');source.isClosed=()=>true;}};
    f.runtime.inputs.get(source).dispose=async()=>{};
    await assert.rejects(f.runtime.close(),{code:'NATIVE_PRINT_CLOSE_UNCERTAIN'});
    assert.ok(logs.indexOf('close-context')<logs.indexOf('stop-source'));
    assert.equal(logs.includes('flush-source'),false);assert.equal(logs.filter(value=>value==='stop-source').length,1);
    assert.equal(f.runtime.info.status,'interrupted');
  }finally{await f.dispose();}
});
test('source titles are not evaluated while print blocks it; preview input and unrelated pages are refused',async()=>{
  const f=await fixture(),logs:string[]=[];
  try{
    setupPrint(f.runtime,logs);const pages=await f.runtime.pageInfo();assert.equal(pages.find((p:any)=>p.pageId==='source').title,'');assert.equal(logs.includes('title'),false);
    await assert.rejects(f.runtime.preflightAction({kind:'click',target:{surfaceId:'native',x:0,y:0}}),{code:'NATIVE_PRINT_PENDING'});
    await assert.rejects(f.runtime.preflightAction({kind:'select-page',pageId:'source'}),{code:'NATIVE_PRINT_PAGE_MISMATCH'});
    await f.runtime.preflightAction({kind:'close-print-preview',pageId:'print-one'});
    assert.notEqual(f.runtime.eventsForPage('source'),f.runtime.eventsForPage('print-one'));assert.equal(f.runtime.eventsForPage('source'),f.runtime.eventsForPage('source'));
  }finally{await f.dispose();}
});
test('an owned destroyed preview still admits cleanup and finalizes its source before browser shutdown',async()=>{
  const f=await fixture(),logs:string[]=[];
  try{
    const {preview,nativeCapture}=setupPrint(f.runtime,logs,true);await f.runtime.execute({kind:'select-page',pageId:'print-one'});
    f.runtime.capture=nativeCapture;f.runtime.captureNative=preview;f.runtime.captureActive=true;preview.closed=true;
    await f.runtime.preflightAction({kind:'close-print-preview',pageId:'print-one'});
    await assert.rejects(f.runtime.closePrint(preview),/native-finalization/);
    assert.equal(logs.filter(item=>item==='stop-source').length,1);assert.equal(f.runtime.pendingPrint(),undefined);assert.equal(f.runtime.parkedCapture,undefined);
    await assert.rejects(f.runtime.preflightAction({kind:'close-print-preview',pageId:'print-one'}),{code:'NATIVE_PRINT_TARGET_CLOSED'});
  }finally{await f.dispose();}
});
test('destroyed-preview cleanup binds the current occurrence after an earlier print from the same source',async()=>{
  const f=await fixture(),logs:string[]=[];
  try{
    const {preview,nativeCapture}=setupPrint(f.runtime,logs,true);
    const previous={...preview,pageId:'print-previous',actionId:'previous-print',closed:true};
    f.runtime.prints.clear();f.runtime.prints.set(previous.pageId,previous);f.runtime.prints.set(preview.pageId,preview);
    await f.runtime.execute({kind:'select-page',pageId:preview.pageId});
    f.runtime.capture=nativeCapture;f.runtime.captureNative=preview;f.runtime.captureActive=true;preview.closed=true;
    await assert.rejects(f.runtime.preflightAction({kind:'close-print-preview',pageId:previous.pageId}),{code:'NATIVE_PRINT_PAGE_MISMATCH'});
    await f.runtime.preflightAction({kind:'close-print-preview',pageId:preview.pageId});
    await assert.rejects(f.runtime.closePrint(preview),/native-finalization/);
    assert.equal(logs.filter(item=>item==='stop-native').length,1);assert.equal(logs.filter(item=>item==='stop-source').length,1);
    assert.equal(f.runtime.pendingPrint(),undefined);assert.equal(f.runtime.parkedCapture,undefined);
  }finally{await f.dispose();}
});
test('viewer failure retains the exact PDF and rejoining the same action never opens another viewer',async()=>{
  const f=await fixture();let viewers=0,served:Buffer|undefined;
  try{
    const event:SessionEvent={eventId:'download',kind:'download',at:'date',pageId:'print-one',detail:{artifactId:'artifact-one',filename:'Report.pdf',status:'receiving'}};
    f.runtime.events.push(event);const bytes=Buffer.from('%PDF-1.7\nexact retained complete bytes\n%%EOF');
    await retainPrintArtifact(f.directory,event,bytes,()=>writeJson(join(f.directory,'events.json'),f.runtime.events));
    f.runtime.context={newPage:async()=>{viewers++;const page=new EventEmitter() as any;page.route=async(_url:string,handler:any)=>handler({fulfill:async(response:any)=>{served=response.body;}});page.goto=async()=>{throw new Error('viewer-unavailable');};return page;}};
    const request={actionId:'open-original',action:{kind:'open-artifact',artifactId:'artifact-one'}};
    const result=await f.runtime.dispatch(request);
    assert.equal(result.status,'outcome-uncertain');assert.equal(result.result.artifactId,'artifact-one');assert.ok(result.result.pageId);
    assert.deepEqual(served,bytes);assert.deepEqual(await verifiedPdfArtifact(f.directory,event),bytes);
    assert.deepEqual(await readFile(String(event.detail.path)),bytes);
    const rejoined=await f.runtime.dispatch(request);assert.deepEqual(rejoined,result);assert.equal(viewers,1);
    await assert.rejects(f.runtime.dispatch({...request,action:{kind:'open-artifact',artifactId:'artifact-other'}}),{code:'ACTION_ID_CONFLICT'});
  }finally{await f.dispose();}
});
