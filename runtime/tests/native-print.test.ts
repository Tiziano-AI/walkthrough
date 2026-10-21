import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {Ajv2020} from 'ajv/dist/2020.js';
import {completedGeneration,NativePrintPreview,printFrame,requireSameGeneration} from '../src/session/native-print.ts';
import {attachNativeTarget,awaitNativeOperation,printCandidate} from '../src/session/native-print-transport.ts';
import {validateAction} from '../src/session/runtime.ts';

const preview={targetId:'preview',type:'page',url:'chrome://print/',browserContextId:'owned'};
const token='2AF673B25AE551AB18A7758B40077821';
const pdfUrl=`chrome-untrusted://print/${token}/0/print.pdf`;
const frame={id:'wrapper',url:`chrome://print/pdf/index_print.html?${pdfUrl}`,pdfUrl,previewToken:token};
const ready={width:1600,height:900,dpr:2,title:'A record',state:'display-preview',ready:true,requestId:0,ticket:{requestID:0,landscape:false},settingsChanged:false};

test('native association excludes old/foreign targets and refuses multiple new previews',()=>{
  assert.equal(printCandidate([preview],new Set(['preview']),'owned'),undefined);
  assert.equal(printCandidate([{...preview,browserContextId:'other'}],new Set(),'owned'),undefined);
  assert.equal(printCandidate([preview],new Set(),'owned'),preview);
  assert.throws(()=>printCandidate([preview,{...preview,targetId:'manual'}],new Set(),'owned'),{code:'NATIVE_PRINT_AMBIGUOUS'});
});
test('generation requires complete matching request and current settings even when Chrome reuses its token',()=>{
  const generation=completedGeneration(ready,frame);assert.equal(generation.previewToken,token);assert.equal(generation.requestId,0);
  for(const change of [{ready:false},{state:'loading'},{settingsChanged:true},{requestId:1}])assert.throws(()=>completedGeneration({...ready,...change},frame),{code:'NATIVE_PRINT_NOT_READY'});
  assert.throws(()=>requireSameGeneration(generation,completedGeneration({...ready,ticket:{requestID:0,landscape:true}},frame)),{code:'NATIVE_PRINT_GENERATION_CHANGED'});
  assert.throws(()=>requireSameGeneration(generation,undefined),{code:'NATIVE_PRINT_GENERATION_CHANGED'});
});
test('the observed trusted descendant wrapper binds its untrusted PDF URL, not its own pathname token',()=>{
  assert.deepEqual(printFrame({frame:{id:'root',url:'chrome://print/'},childFrames:[{frame:{id:frame.id,url:frame.url}}]}),frame);
  assert.throws(()=>printFrame({frame:{id:'root',url:'chrome://print/'}}),{code:'NATIVE_PRINT_FRAME_UNAVAILABLE'});
  assert.throws(()=>printFrame({frame:{id:'root',url:'chrome://print/'},childFrames:[{frame},{frame:{...frame,id:'second'}}]}),{code:'NATIVE_PRINT_FRAME_UNAVAILABLE'});
  for(const url of [pdfUrl,frame.url+'#fragment',frame.url+'&other=true',frame.url.replace(token,'not-a-preview-token'),frame.url.replace('chrome-untrusted://print/','https://print/')])
    assert.throws(()=>printFrame({frame:{id:'root',url:'chrome://print/'},childFrames:[{frame:{id:frame.id,url}}]}),{code:'NATIVE_PRINT_FRAME_UNAVAILABLE'});
});

function nativeFixture(after=ready,{parentId=frame.id,contextId='owned',location=pdfUrl}={}){
  const root=new EventEmitter() as any;let attachment=0,reads=0;const methods:string[]=[];let retrieval='',fetches=0;
  root.detach=async()=>{};
  root.send=async(method:string,params:any)=>{
    methods.push(method);
    if(method==='Target.getTargets')return {targetInfos:[preview,{targetId:'pdf-target',type:'iframe',url:pdfUrl,browserContextId:contextId}]};
    if(method==='Target.attachToTarget')return {sessionId:`lease-${++attachment}`};
    if(method==='Target.sendMessageToTarget'){
      const command=JSON.parse(params.message);
      let result:any;
      if(command.method==='Page.getFrameTree')result={frameTree:{frame:{id:'pdf-frame',parentId,url:pdfUrl}}};
      else if(command.method==='Runtime.evaluate'){
        retrieval=command.params.expression;
        try{result={result:{value:await runInNewContext(retrieval,{URL,location:{href:location},btoa:(value:string)=>Buffer.from(value,'binary').toString('base64'),fetch:async(url:string)=>{fetches++;assert.equal(url,`chrome-untrusted://print/${token}/-1/print.pdf`);return new Response('%PDF-1.7\nwhole document\n%%EOF');}})}};}
        catch(error){result={exceptionDetails:{text:error instanceof Error?error.message:String(error)}};}
      }else throw new Error(`Unexpected child call ${command.method}`);
      queueMicrotask(()=>root.emit('Target.receivedMessageFromTarget',{sessionId:params.sessionId,message:JSON.stringify({id:command.id,result})}));
      return {};
    }
    return {};
  };
  const target={send:async(method:string)=>method==='Runtime.evaluate'?{result:{value:reads++?after:ready}}:{frameTree:{frame:{id:'root',url:'chrome://print/'},childFrames:[{frame}]}},detach:async()=>{}};
  return {native:new NativePrintPreview({root,target,targetInfo:preview,sourcePageId:'source',actionId:'print-action',contextId:'owned',baseline:new Set()}),methods,retrieval:()=>retrieval,fetches:()=>fetches};
}
test('complete PDF retrieval uses exact related child and /-1/, checking generation on both sides',async()=>{
  const f=nativeFixture(),bytes=await f.native.pdf(completedGeneration(ready,frame));
  assert.match(bytes.toString(),/^%PDF-/);assert.match(f.retrieval(),/\/-1\/print\.pdf/);assert.ok(!f.retrieval().includes('current.origin'));
  assert.equal(f.methods.filter(method=>method==='Target.attachToTarget').length,1);
  const changed=nativeFixture({...ready,requestId:1,ticket:{requestID:1,landscape:true}});
  await assert.rejects(changed.native.pdf(completedGeneration(ready,frame)),{code:'NATIVE_PRINT_GENERATION_CHANGED'});
});
test('a matching PDF URL in another context cannot attach, and a different parent cannot retrieve',async()=>{
  const foreign=nativeFixture(ready,{contextId:'foreign'});await assert.rejects(foreign.native.pdf(completedGeneration(ready,frame)),{code:'NATIVE_PRINT_FRAME_UNAVAILABLE'});
  assert.equal(foreign.methods.includes('Target.attachToTarget'),false);
  const unrelated=nativeFixture(ready,{parentId:'unrelated'});await assert.rejects(unrelated.native.pdf(completedGeneration(ready,frame)),{code:'NATIVE_PRINT_FRAME_CHANGED'});
  assert.equal(unrelated.fetches(),0);
  const changed=nativeFixture(ready,{location:frame.url});await assert.rejects(changed.native.pdf(completedGeneration(ready,frame)),{code:'NATIVE_PRINT_INSPECTION_FAILED'});
  assert.equal(changed.fetches(),0);
});
test('Cancel sends one real gesture and waits for observed destruction rather than command acceptance',async()=>{
  const root=new EventEmitter() as any;let present=true,destroy!:()=>void;const input:string[]=[];
  root.send=async(method:string)=>{assert.notEqual(method,'Target.closeTarget');return {targetInfos:present?[preview]:[]};};root.detach=async()=>{};
  const target={send:async(method:string,params:any)=>{
    if(method==='Runtime.evaluate'){assert.match(params.expression,/cr-button\.cancel-button/);return {result:{value:{x:100,y:200}}};}
    assert.equal(method,'Input.dispatchMouseEvent');input.push(params.type);
    if(params.type==='mouseReleased')destroy=()=>{present=false;root.emit('Target.targetDestroyed',{targetId:preview.targetId});};
    return {};
  },detach:async()=>{}};
  const native=new NativePrintPreview({root,target,targetInfo:preview,sourcePageId:'source',actionId:'print-action',contextId:'owned',baseline:new Set()});
  let settled=false;const close=native.close().then(()=>{settled=true;});
  for(let turn=0;turn<30&&!destroy;turn++)await Promise.resolve();
  for(let turn=0;turn<30;turn++)await Promise.resolve();
  assert.deepEqual(input,['mouseMoved','mousePressed','mouseReleased']);assert.equal(native.closed,false);assert.equal(settled,false);
  destroy();await close;await native.close();assert.equal(native.closed,true);assert.equal(input.length,3);await native.dispose();
});
test('missing operation settlement is bounded without cancelling or repeating the original',async()=>{
  let settle!:(value:string)=>void;
  const original=new Promise<string>(resolve=>{settle=resolve;});
  await assert.rejects(awaitNativeOperation(original,'NATIVE_PRINT_INPUT_UNSETTLED',1),{code:'NATIVE_PRINT_INPUT_UNSETTLED'});
  settle('late original completion');assert.equal(await original,'late original completion');
});
test('an acknowledged Cancel without destruction stays uncertain and cannot dispatch a second gesture',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const root=new EventEmitter() as any;let gestures=0;
  root.send=async()=>({targetInfos:[preview]});root.detach=async()=>{};
  const target={send:async(method:string,params:any)=>{
    if(method==='Runtime.evaluate')return {result:{value:{x:100,y:200}}};
    if(params.type==='mouseReleased')gestures++;return {};
  },detach:async()=>{}};
  const native=new NativePrintPreview({root,target,targetInfo:preview,sourcePageId:'source',actionId:'print-action',contextId:'owned',baseline:new Set()});
  const original=native.close(),rejected=assert.rejects(original,{code:'NATIVE_PRINT_CLOSE_UNCERTAIN'});
  for(let turn=0;turn<55;turn++){
    for(let microtask=0;microtask<20;microtask++)await Promise.resolve();
    t.mock.timers.tick(100);
  }
  await rejected;assert.equal(native.closed,false);assert.equal(gestures,1);assert.equal(native.close(),original);
  await native.dispose();t.mock.timers.reset();
});
test('scoped transport filters other leases and rejects pending calls on target loss',async()=>{
  const root=new EventEmitter() as any;let command:any;
  root.send=async(method:string,params:any)=>{if(method==='Target.attachToTarget')return {sessionId:'one'};if(method==='Target.sendMessageToTarget')command=JSON.parse(params.message);return {};};
  const connection=await attachNativeTarget(root,'observed'),call=connection.send('Page.captureScreenshot');
  root.emit('Target.receivedMessageFromTarget',{sessionId:'foreign',message:JSON.stringify({id:command.id,result:{bad:true}})});
  root.emit('Target.receivedMessageFromTarget',{sessionId:'one',message:JSON.stringify({id:command.id,result:{data:'png'}})});
  assert.deepEqual(await call,{data:'png'});
  const pending=connection.send('Page.getFrameTree');root.emit('Target.detachedFromTarget',{sessionId:'one'});
  await assert.rejects(pending,{code:'NATIVE_PRINT_TARGET_CLOSED'});await connection.detach();
});
test('public print actions admit stable identities and reject arbitrary code, paths and false expectations',()=>{
  for(const action of [{kind:'click',target:{ref:'ref-one'},expectPrintPreview:true},{kind:'keys',keys:'Meta+P',expectPrintPreview:true},{kind:'save-print-preview',pageId:'print-one',observationId:'surface-one',filename:'Report α.PDF'},{kind:'close-print-preview',pageId:'print-one'},{kind:'open-artifact',artifactId:'artifact-one'}])assert.doesNotThrow(()=>validateAction(action as any));
  for(const filename of ['../report.pdf','.report.pdf','a/b.pdf','a\\b.pdf','report.txt','report\n.pdf','x'.repeat(181)+'.pdf'])assert.throws(()=>validateAction({kind:'save-print-preview',pageId:'print-one',observationId:'surface-one',filename}));
  assert.throws(()=>validateAction({kind:'click',target:{ref:'ref-one'},expectPrintPreview:false} as any),{code:'INVALID_PRINT_EXPECTATION'});
  assert.throws(()=>validateAction({kind:'open-artifact',artifactId:'artifact-one',evaluate:'alert(1)'} as any),{code:'INVALID_ACTION'});
});
test('shipped schema and runtime agree on new print action identities and filename boundaries',async()=>{
  const schema=JSON.parse(await readFile(new URL('../docs/schemas/session-action.schema.json',import.meta.url),'utf8'));
  // Upload's existing oneOf requires fields declared by its enclosing object.
  const validate=new Ajv2020({strict:true,strictRequired:false,allErrors:true}).compile(schema);
  const actions=[{kind:'save-print-preview',pageId:'print-one',observationId:'surface-one',filename:'Report α.PDF'},{kind:'close-print-preview',pageId:'print-one'},{kind:'open-artifact',artifactId:'artifact-one'}];
  for(const action of actions){
    assert.equal(validate(action),true,JSON.stringify(validate.errors));assert.doesNotThrow(()=>validateAction(action as any));
    for(const field of ['pageId','observationId','artifactId'].filter(field=>field in action))for(const value of ['', '.leading','has.dot','a'.repeat(102)]){
      const invalid={...action,[field]:value};assert.equal(validate(invalid),false,JSON.stringify(invalid));assert.throws(()=>validateAction(invalid as any));
    }
  }
  for(const filename of ['../report.pdf','.report.pdf','a/b.pdf','a\\b.pdf','report.txt','report.pdf\n','report.pdf\u007f','x'.repeat(177)+'.pdf']){
    const invalid={...actions[0],filename};assert.equal(validate(invalid),false,filename);assert.throws(()=>validateAction(invalid as any));
  }
});
