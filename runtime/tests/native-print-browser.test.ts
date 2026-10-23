import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {accessSync,constants} from 'node:fs';
import {access,lstat,mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {delimiter,isAbsolute,join,resolve} from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {qualifiedBrowserPath,qualifiedNode,qualifiedNodePath} from '../src/core/environment.ts';
import {resolveLocalTools} from '../src/core/toolchain.ts';
import type {FilmSource,TakeRecord} from '../src/project/contracts.ts';
import {sealTakes} from '../src/project/capture.ts';
import {createProject,loadSourceSet,retainedPath} from '../src/project/store.ts';
import type {ActionRecord,ActionRequest,CaptureRequest,Observation,SessionConfig} from '../src/session/contracts.ts';
import {captureSession,closeSession,dispatchSession,inspectAction,inspectSession,listSessionArtifacts,observeSession,openSession} from '../src/session/index.ts';
import {infoPath,readJson} from '../src/session/journal.ts';
import {inspectWorker,verifyProcessReader} from '../src/session/process.ts';

// Explicit opt-in only: this opens a headed, isolated Chrome for Testing window
// and uses the real native recorder. Run only after other browser/media owners
// release their resources, with an unlocked macOS desktop. A default skip is
// NOT native-print qualification. Missing prerequisites fail an opted-in run.
// WALKTHROUGH_NATIVE_PRINT_BROWSER_TEST=1 node \
//   --test --test-concurrency=1 tests/native-print-browser.test.ts
// Requires the qualified/provisioned development runtime, FFmpeg/ffprobe and
// read-only Poppler pdfinfo/pdftotext discovered on PATH; never installs anything.
const enabled=process.env.WALKTHROUGH_NATIVE_PRINT_BROWSER_TEST==='1';
const execute=promisify(execFile);
const {ffmpegPath:ffmpeg,ffprobePath:ffprobe}=resolveLocalTools();
const testPrerequisite=(name:string)=>{
  for(const directory of (process.env.PATH??'').split(delimiter)){
    if(!isAbsolute(directory))continue;
    const path=resolve(directory,name);
    try{accessSync(path,constants.X_OK);return path;}catch{/* Prerequisite discovery never installs a missing tool. */}
  }
  return join('/usr/bin',name);
};
const pdfinfo=testPrerequisite('pdfinfo'),pdftotext=testPrerequisite('pdftotext');
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const paragraphs=[
  ['Cobalt Workshop overview','Fictional plan reference COBALT-FIRST-173.','The workshop has four desks and two shared benches.','END-OF-FIRST-PAGE-271'],
  ['Cobalt Workshop materials','Fictional inventory reference COBALT-SECOND-389.','The inventory contains seven blue notebooks and eleven green folders.','END-OF-SECOND-PAGE-463'],
  ['Cobalt Workshop conclusion','Fictional review reference COBALT-THIRD-587.','The fictional coordinator approved the sample plan for this local test.','END-OF-LAST-PAGE-691'],
];
// SVG fills print even when Chrome's optional CSS background printing is off.
// The three large colors also distinguish a rendered PDF from an empty viewer.
const fingerprint='<svg viewBox="0 0 480 144" width="480" height="144" aria-label="Fictional report color signature"><rect width="160" height="144" fill="#e3342f"/><rect x="160" width="160" height="144" fill="#159e55"/><rect x="320" width="160" height="144" fill="#2463dd"/></svg>';
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Cobalt Workshop native print fixture</title>
<style>
  *{box-sizing:border-box}body{margin:0;background:#e8edf5;color:#172334;font:20px sans-serif}
  header{padding:24px;background:#254d86;color:white}button{font:inherit;padding:12px 24px}
  pre{white-space:pre-wrap}section{margin:24px;padding:24px;background:white;max-width:780px}
  body[data-phase="beforeprint"] header{background:#952956}body[data-phase="afterprint"] header{background:#087460}
  h1{font-size:28px}.phase{font-weight:bold}svg{display:block;max-width:100%}
  @page{size:A4;margin:18mm}
  @media print{body{background:white;font-size:16px}.screen-only{display:none}section{margin:0;padding:0;max-width:none;break-after:page}section:last-of-type{break-after:auto}svg{width:144mm;height:43.2mm}h1{font-size:24px}}
</style><body data-phase="ready"><header class="screen-only"><h1>Cobalt Workshop</h1>
<button id="print">Print fictional report</button><pre id="state"></pre></header>
${paragraphs.map((lines,index)=>`<section><h1>${lines[0]}</h1><p>Report page ${index+1} of 3</p>${fingerprint}<p class="phase">PHASE READY</p>${lines.slice(1).map(line=>`<p>${line}</p>`).join('')}</section>`).join('')}
<script>
  const state={clicks:0,trusted:false,before:0,after:0,returned:0,phase:'ready'};
  function paint(){document.body.dataset.phase=state.phase;document.querySelector('#state').textContent='PRINT-STATE '+JSON.stringify(state);for(const label of document.querySelectorAll('.phase'))label.textContent='PHASE '+state.phase.toUpperCase()+' BEFORE '+state.before+' AFTER '+state.after}
  addEventListener('beforeprint',()=>{state.before++;state.phase='beforeprint';paint()});
  addEventListener('afterprint',()=>{state.after++;state.phase='afterprint';paint()});
  document.querySelector('#print').onclick=event=>{state.clicks++;state.trusted=event.isTrusted;paint();window.print();state.returned++;paint()};
  paint();
</script></body></html>`;

type CaptureResult<T>={status:string;result?:T;error?:{code:string;message:string}};
type CaptureStart={state:string;take:TakeRecord};
type CaptureClock={start:{beforeMs:number;afterMs:number};end:{beforeMs:number;afterMs:number}};
type CaptureWindow={startMs:number;endMs:number};
type CaptureAnalysis={map:{offsetSeconds:number;uncertaintySeconds:number;driftSeconds:number;frameCount:number};markerFrames:number[];probe:{frames:Array<{best_effort_timestamp_time:string}>}};
const failure=(stage:string,value:{status:string;error?:{code:string;message:string}})=>`${stage}: ${value.status}${value.error?` (${value.error.code}: ${value.error.message})`:''}`;

function completed(record:ActionRecord,stage:string){assert.equal(record.status,'input-completed',failure(stage,record));return record;}
async function capture<T>(directory:string,request:CaptureRequest):Promise<T>{
  const result=await captureSession(directory,request) as CaptureResult<T>;
  assert.equal(result.status,'completed',failure(`capture ${request.operationId}`,result));
  assert.ok(result.result,`capture ${request.operationId} did not retain its result`);return result.result;
}
async function until<T>(label:string,read:()=>Promise<T>,ready:(value:T)=>boolean,timeoutMs=10000):Promise<T>{
  const end=performance.now()+timeoutMs;
  do{const value=await read();if(ready(value))return value;await delay(100);}while(performance.now()<end);
  assert.fail(`${label} did not reach its required observed state. The original occurrence is retained; do not replay it.`);
}
function printState(observation:Observation){
  const match=/PRINT-STATE (\{[^\n]+\})/.exec(observation.text);assert.ok(match,'The original source must expose its fixture state.');
  return JSON.parse(match[1]) as {clicks:number;trusted:boolean;before:number;after:number;returned:number;phase:string};
}
async function imageHasReport(path:string,sourceFrame?:number){
  const filter=`${sourceFrame===undefined?'':`select=eq(n\\,${sourceFrame}),`}scale=160:90:flags=area`;
  const {stdout}=await execute(ffmpeg,['-v','error','-i',path,'-vf',filter,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer',timeout:15000,maxBuffer:160*90*3+1024});
  assert.equal(stdout.length,160*90*3,'Decode the actual observed screenshot, not an inferred viewer state.');
  const colors=[0,0,0];
  for(let index=0;index<stdout.length;index+=3){const [r,g,b]=stdout.subarray(index,index+3);
    if(r>140&&r>g*1.5&&r>b*1.5)colors[0]++;
    if(g>100&&g>r*1.5&&g>b*1.5)colors[1]++;
    if(b>140&&b>r*1.5&&b>g*1.5)colors[2]++;
  }
  return colors.every(count=>count>=6);
}
async function recordedReport(projectPath:string,take:TakeRecord,markId:string){
  assert.ok(take.source);const mark=take.marks.find(mark=>mark.id===markId);assert.ok(mark?.settled);
  const at=(mark.settled.startSeconds+mark.settled.endSeconds)/2;
  const directory=join(projectPath,'takes',take.id),path=await retainedPath(directory,take.source.media);
  const analysis=await readJson<CaptureAnalysis>(join(directory,'capture-analysis.json'));
  // Select the real sample held at this point, rather than seeking forward to
  // the next VFR sample (which can already be the closing calibration slate).
  let frame=-1;for(const [index,item] of analysis.probe.frames.entries())if(Number(item.best_effort_timestamp_time)<=at)frame=index;
  assert.ok(frame>=0,`${take.title}: no retained frame at the settled mark`);
  assert.ok(await imageHasReport(path,frame),`${take.title}: the actual recorded settled frame must show the report signature, not merely its observation screenshot.`);
}
async function renderedReport(directory:string,pageId:string){
  return until('Actual PDF pixels',async()=>{
    const observation=await observeSession(directory,{pageId,screenshot:true});
    assert.ok(observation.screenshotPath);assert.deepEqual(observation.screenshotPixels,{width:3200,height:1800});
    return {observation,hasReport:await imageHasReport(observation.screenshotPath)};
  },value=>value.hasReport);
}
type ReportObservation=Pick<Observation,'pageId'|'documentId'|'pages'|'nativePrint'>;
type SettledReportMark={id:string;takeId:string;settled:boolean};
type SettlementOperations={observe:()=>Promise<ReportObservation>;mark:(request:CaptureRequest)=>Promise<CaptureResult<SettledReportMark>>};
function sameSelectedReport(expected:ReportObservation,observed:ReportObservation){
  assert.equal(observed.pageId,expected.pageId,'Settlement must stay on the original selected report.');
  assert.equal(observed.documentId,expected.documentId,'Settlement must not follow a replacement document.');
  assert.deepEqual(observed.pages.filter(page=>page.selected&&!page.closed).map(page=>page.pageId),[expected.pageId],'Settlement must not reselect a changed target.');
  assert.deepEqual(observed.nativePrint,expected.nativePrint,'Settlement must preserve the original native generation and source binding.');
}
async function settledReportMark(directory:string,expected:ReportObservation,takeId:string,prefix:string,title:string,operations:SettlementOperations={
  // Observe the selection as it is; supplying pageId would hide selection drift.
  observe:()=>observeSession(directory,{screenshot:false}),
  mark:async request=>await captureSession(directory,request) as CaptureResult<SettledReportMark>,
}){
  // Four distinct candidate holds, each using the unchanged runtime raster
  // check. A rejected interval keeps its own operation and failed PNG samples;
  // this never retries an input, save, close or the original mark identity.
  for(let attempt=1;attempt<=4;attempt++){
    sameSelectedReport(expected,await operations.observe());
    const id=`${prefix}-${attempt}`;
    const result=await operations.mark({operationId:id,kind:'mark',request:{id,title,settled:true}});
    if(result.status!=='completed'){
      assert.equal(result.status,'outcome-uncertain',failure(`capture ${id}`,result));
      assert.equal(result.error?.code,'SCENE_NOT_SETTLED',failure(`capture ${id}`,result));
      assert.equal(result.result,undefined,`Rejected hold ${id} must not report a retained mark.`);
    }else{
      assert.equal(result.error,undefined,`Completed hold ${id} must not report uncertainty.`);
      assert.ok(result.result,`capture ${id} did not retain its result`);
      assert.equal(result.result.id,id);assert.equal(result.result.takeId,takeId);assert.equal(result.result.settled,true);
    }
    sameSelectedReport(expected,await operations.observe());
    if(result.status==='completed')return id;
  }
  assert.fail(`${prefix}: none of four distinct observed intervals settled. Their failed samples and the original occurrence are retained; no application action was repeated.`);
}
async function qualifiedTake(projectPath:string,takeId:string,pageId:string){
  const directory=join(projectPath,'takes',takeId),take=await readJson<TakeRecord>(join(directory,'take.json'));
  assert.equal(take.state,'stopped',`${take.title}: ${take.error?.code??take.state}; original take ${takeId}`);
  assert.equal(take.pageId,pageId);assert.ok(take.source,`${take.title}: no clock-qualified source`);
  const source:FilmSource=take.source;
  assert.deepEqual([source.width,source.height],[3200,1800]);
  assert.ok(source.clock.uncertaintySeconds<=0.05,`${take.title}: clock uncertainty ${source.clock.uncertaintySeconds}`);
  assert.ok(source.clock.driftSeconds<=0.05,`${take.title}: clock drift ${source.clock.driftSeconds}`);
  assert.ok(source.frameCount>0);assert.ok(source.usableRange.endSeconds>source.usableRange.startSeconds);
  await retainedPath(directory,source.media);
  const clock=await readJson<CaptureClock>(join(directory,'capture-clock.json'));
  const window=await readJson<CaptureWindow>(join(directory,'capture-window.json'));
  const analysis=await readJson<CaptureAnalysis>(join(directory,'capture-analysis.json'));
  assert.equal(analysis.markerFrames.length,2,`${take.title}: both original slates must qualify`);
  assert.deepEqual(source.clock,{offsetSeconds:analysis.map.offsetSeconds,uncertaintySeconds:analysis.map.uncertaintySeconds,driftSeconds:analysis.map.driftSeconds});
  assert.equal(source.frameCount,analysis.map.frameCount);
  assert.ok(clock.start.afterMs<window.startMs&&window.endMs<clock.end.beforeMs);
  return {take,source,clock,window};
}

const observedReport:ReportObservation={pageId:'preview',documentId:'original-document',pages:[{pageId:'preview',selected:true,closed:false}],nativePrint:{sourcePageId:'source',actionId:'print-once',sourceBinding:'exclusive-action-and-browser-context',state:'display-preview',generation:{requestId:0,ticketSha256:'original-ticket',previewToken:'original-token',frameId:'original-frame'}}};
const unsettledReport:CaptureResult<SettledReportMark>={status:'outcome-uncertain',error:{code:'SCENE_NOT_SETTLED',message:'SCENE_NOT_SETTLED'}};
const acceptedReport=(request:CaptureRequest):CaptureResult<SettledReportMark>=>({status:'completed',result:{id:request.request!.id!,takeId:'original-take',settled:true}});
test('report settlement accepts only the successful distinct hold after exact scene rejections',async()=>{
  const requests:CaptureRequest[]=[],order:string[]=[];
  const mark=await settledReportMark('unused',observedReport,'original-take','native-ready','Completed report',{
    observe:async()=>{order.push('observe');return observedReport;},
    mark:async request=>{requests.push(request);order.push(request.operationId);return requests.length<3?unsettledReport:acceptedReport(request);},
  });
  assert.equal(mark,'native-ready-3');
  assert.deepEqual(requests.map(request=>[request.operationId,request.kind,request.request?.id,request.request?.settled]),[
    ['native-ready-1','mark','native-ready-1',true],['native-ready-2','mark','native-ready-2',true],['native-ready-3','mark','native-ready-3',true],
  ]);
  assert.deepEqual(order,['observe','native-ready-1','observe','observe','native-ready-2','observe','observe','native-ready-3','observe']);
});
test('report settlement stops after four rejected holds without accepting a changing scene',async()=>{
  const requests:string[]=[];
  await assert.rejects(settledReportMark('unused',observedReport,'original-take','native-ready','Completed report',{
    observe:async()=>observedReport,mark:async request=>{requests.push(request.operationId);return unsettledReport;},
  }),/none of four distinct observed intervals settled/);
  assert.deepEqual(requests,['native-ready-1','native-ready-2','native-ready-3','native-ready-4']);
});
test('report settlement propagates every non-scene failure and malformed completion without retry',async()=>{
  const failures:CaptureResult<SettledReportMark>[]=[
    {status:'outcome-uncertain',error:{code:'CAPTURE_WORKER_INTERRUPTED',message:'Original worker lost'}},
    {status:'outcome-uncertain'},
    {...unsettledReport,status:'not-dispatched'},
    {...unsettledReport,result:{id:'native-ready-1',takeId:'original-take',settled:true}},
    {status:'completed'},
    {status:'completed',error:{code:'SCENE_NOT_SETTLED',message:'Contradictory completion'},result:{id:'native-ready-1',takeId:'original-take',settled:true}},
    {status:'completed',result:{id:'wrong-mark',takeId:'original-take',settled:true}},
    {status:'completed',result:{id:'native-ready-1',takeId:'wrong-take',settled:true}},
    {status:'completed',result:{id:'native-ready-1',takeId:'original-take',settled:false}},
  ];
  for(const result of failures){let marks=0,observations=0;
    await assert.rejects(settledReportMark('unused',observedReport,'original-take','native-ready','Completed report',{
      observe:async()=>{observations++;return observedReport;},mark:async()=>{marks++;return result;},
    }));
    assert.equal(marks,1);assert.equal(observations,1);
  }
  const error=new Error('Transport outcome unknown');let marks=0;
  await assert.rejects(settledReportMark('unused',observedReport,'original-take','native-ready','Completed report',{
    observe:async()=>observedReport,mark:async()=>{marks++;throw error;},
  }),value=>value===error);assert.equal(marks,1);
});
test('report settlement rejects target, document and native-generation drift before and after a hold',async()=>{
  const changes:ReportObservation[]=[
    {...observedReport,pageId:'other'},
    {...observedReport,documentId:'replacement'},
    {...observedReport,pages:[{pageId:'other',selected:true,closed:false}]},
    {...observedReport,nativePrint:undefined},
    ...[{requestId:1},{ticketSha256:'changed'},{previewToken:'changed'},{frameId:'changed'}].map(change=>({...observedReport,nativePrint:{...observedReport.nativePrint!,generation:{...observedReport.nativePrint!.generation!,...change}}})),
  ];
  for(const changed of changes)for(const driftAt of [1,2]){let observations=0,marks=0;
    await assert.rejects(settledReportMark('unused',observedReport,'original-take','native-ready','Completed report',{
      observe:async()=>++observations===driftAt?changed:observedReport,
      mark:async request=>{marks++;return acceptedReport(request);},
    }));
    assert.equal(marks,driftAt-1);
  }
});
test('retained viewer settlement preserves selection without requiring a native generation',async()=>{
  const viewer={...observedReport,nativePrint:undefined};
  assert.equal(await settledReportMark('unused',viewer,'original-take','viewer-ready','Retained PDF',{
    observe:async()=>viewer,mark:async request=>acceptedReport(request),
  }),'viewer-ready-1');
});

test('real native print retains one input, calibrated source/preview/viewer and the full original PDF',{
  skip:enabled?false:'NOT QUALIFIED: explicit WALKTHROUGH_NATIVE_PRINT_BROWSER_TEST=1 and exclusive headed browser/media resources required',
  timeout:240000,
},async t=>{
  assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');assert.ok(qualifiedNode(process.version),'Use qualified Node 24.22.1 or later on the 24 line.');
  for(const path of [qualifiedNodePath(),qualifiedBrowserPath(),ffmpeg,ffprobe,pdfinfo,pdftotext])await access(path,constants.X_OK).catch(()=>assert.fail(`Required executable missing: ${path}; no dependency is downloaded by this test.`));
  await verifyProcessReader();
  const root=await realpath(await mkdtemp('/private/tmp/wt-native-print-'));
  const projectPath=join(root,'native-print.walkthrough'),directory=join(projectPath,'sessions','native-print');
  const previousState=process.env.WALKTHROUGH_STATE_ROOT;
  process.env.WALKTHROUGH_STATE_ROOT=join(root,'state');
  let passed=false,attemptedOpen=false,stage='fixture setup';
  const server=createServer((request,response)=>{
    if(request.method==='GET'&&request.url==='/'){response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});response.end(html);}
    else{response.writeHead(404);response.end('No fixture route');}
  });
  t.after(async()=>{
    let teardownError:unknown;
    try{
      if(attemptedOpen){
        await closeSession(directory);
        const info=await readJson<Awaited<ReturnType<typeof openSession>>>(infoPath(directory));
        await until('Owned worker/browser shutdown',()=>inspectWorker(info),state=>state.worker==='stopped'&&state.members.length===0,5000);
      }
    }catch(error){teardownError=error;}
    finally{
      server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
      if(previousState===undefined)delete process.env.WALKTHROUGH_STATE_ROOT;else process.env.WALKTHROUGH_STATE_ROOT=previousState;
    }
    if(passed&&!teardownError){
      // Only this successful disposable fixture is removed, after process custody
      // has drained. Failed/uncertain originals are never deleted or reacquired.
      assert.equal(await realpath(root),root);assert.ok((await lstat(root)).isDirectory());
      await rm(root,{recursive:true,force:false});
    }else{
      t.diagnostic(`Native-print regression stopped at ${stage}. Retained project: ${projectPath}. Original session: ${directory}.`);
      if(teardownError)t.diagnostic(`Shutdown was not confirmed: ${teardownError instanceof Error?teardownError.message:String(teardownError)}. Inspect/close that same session; no replacement was launched.`);
    }
    if(teardownError)throw teardownError;
  });
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
    const {project}=await createProject(projectPath,{title:'Native print public-path regression',brief:'One trusted print click, the actual native preview and the retained three-page fictional PDF.',audience:'Walkthrough maintainers',mandate:{applicationUrl:origin,navigationOrigins:[origin],network:'loopback-only',allowedEffects:'One fictional print action, local PDF retention and captured viewing in this isolated fixture.',dataDescription:'Only the fictional Cobalt Workshop report generated by this test.',inputRoots:[],mediaReview:'agent-reviewable-synthetic',delivery:'local'}});
    const config:SessionConfig={directory,projectPath,projectId:project.id,startUrl:origin,allowedOrigins:[origin],uploadRoots:[],network:'loopback-only',mediaReview:'agent-reviewable-synthetic',headless:false,idleTimeoutMs:120000,pacing:{minimumApproachMs:30,distanceMsPerPixel:0,targetDwellMs:0,keyDelayMs:0}};
    stage='headed session open';attemptedOpen=true;await openSession(config);
    const initial=await observeSession(directory,{screenshot:true}),sourcePageId=initial.pageId;
    assert.deepEqual(printState(initial),{clicks:0,trusted:false,before:0,after:0,returned:0,phase:'ready'});
    const control=initial.refs.find(ref=>ref.name==='Print fictional report');assert.ok(control,'Print must be activated through an observed real button.');
    const sourceStart=await capture<CaptureStart>(directory,{operationId:'source-start',kind:'start',request:{title:'Source across suspended native print'}});
    await capture(directory,{operationId:'source-ready',kind:'mark',request:{id:'source-ready',title:'Ready fictional report',settled:true}});

    stage='original native print click and target discovery';
    const request:ActionRequest={actionId:'print-once',action:{kind:'click',target:{ref:control.ref},expectPrintPreview:true}};
    const original=await dispatchSession(directory,request);
    assert.equal(original.result?.print?.discovery.status,'found',failure('Original print discovery',original));
    assert.notEqual(original.result?.print?.input.status,'failed',failure('Original print input',original));
    const previewId=original.result?.pageId;assert.ok(previewId,'Discovery must identify the actual native target.');assert.notEqual(previewId,sourcePageId);
    const joined=await dispatchSession(directory,request);
    assert.equal(joined.dispatchedAt,original.dispatchedAt);assert.equal(joined.startedAtMs,original.startedAtMs);assert.equal(joined.result?.pageId,previewId);
    await assert.rejects(observeSession(directory,{pageId:sourcePageId,screenshot:false}),{code:'NATIVE_PRINT_PENDING'});
    completed(await dispatchSession(directory,{actionId:'select-native',action:{kind:'select-page',pageId:previewId}}),'Select native preview');
    // Selecting native replaces the active capture surface, not the original
    // source recorder. Its take must still be recording, without an ending slate.
    assert.equal((await inspectSession(directory)).session.captureActive,true);
    assert.equal((await readJson<TakeRecord>(join(projectPath,'takes',sourceStart.take.id,'take.json'))).state,'recording');
    const ready=await until('Native completed generation',()=>observeSession(directory,{screenshot:false}),value=>!!value.nativePrint?.generation);
    assert.equal(ready.nativePrint?.sourcePageId,sourcePageId);assert.equal(ready.nativePrint?.actionId,request.actionId);
    assert.equal(ready.nativePrint?.sourceBinding,'exclusive-action-and-browser-context');
    assert.equal(ready.pages.find(page=>page.pageId===previewId)?.kind,'native-print');

    stage='native preview capture and exact PDF retention';
    const nativeStart=await capture<CaptureStart>(directory,{operationId:'native-start',kind:'start',request:{title:'Actual native print preview'}});
    const {observation:renderedNative}=await renderedReport(directory,previewId);
    sameSelectedReport(ready,renderedNative);
    // Retention depends on the fresh completed generation, not a reading hold.
    // Exercise its complete bytes before waiting for transient UI raster changes.
    const native=await observeSession(directory,{screenshot:false});
    assert.ok(native.nativePrint?.generation);sameSelectedReport(renderedNative,native);
    const saveRequest:ActionRequest={actionId:'retain-print',action:{kind:'save-print-preview',pageId:previewId,observationId:native.observationId,filename:'Cobalt Workshop.pdf'}};
    const saved=completed(await dispatchSession(directory,saveRequest),'Retain exact print PDF');
    assert.deepEqual(await dispatchSession(directory,saveRequest),saved,'Rejoining save must not create another artifact.');
    const artifacts=await listSessionArtifacts(directory);assert.equal(artifacts.length,1);
    const artifact=artifacts[0];assert.equal(artifact.artifactId,saved.result?.artifactId);assert.equal(artifact.status,'retained');
    assert.equal(artifact.origin,'native-print-preview');assert.equal(artifact.pageId,previewId);assert.equal(artifact.actionId,saveRequest.actionId);assert.equal(artifact.mediaType,'application/pdf');
    assert.equal(typeof artifact.path,'string');const artifactPath=String(artifact.path),pdf=await readFile(artifactPath);
    assert.match(pdf.subarray(0,8).toString(),/^%PDF-/);assert.equal(pdf.length,artifact.bytes);assert.equal(hash(pdf),artifact.sha256);
    const info=await execute(pdfinfo,[artifactPath],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
    assert.match(info.stdout,/^Pages:\s+3\s*$/m,'The retained bytes must be the complete multipage document, not a preview thumbnail/page.');
    const text=await execute(pdftotext,['-layout',artifactPath,'-'],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
    const pages=text.stdout.split('\f').map(page=>page.replace(/\s+/g,' ').trim()).filter(Boolean);assert.equal(pages.length,3);
    for(const [index,page] of pages.entries()){
      for(const line of paragraphs[index])assert.ok(page.includes(line),`Retained PDF page ${index+1} lacks: ${line}`);
      assert.ok(page.includes(`Report page ${index+1} of 3`));
      assert.ok(page.includes('PHASE BEFOREPRINT BEFORE 1 AFTER 0'),`Page ${index+1} must include the actual beforeprint state.`);
      assert.ok(!page.includes('PHASE AFTERPRINT'),'No PDF may be regenerated from the resumed source.');
    }

    stage='native preview observed reading hold';
    const nativeMark=await settledReportMark(directory,native,nativeStart.take.id,'native-ready','Completed native preview');

    stage='native close, original input settlement and suspended source clock';
    const closed=completed(await dispatchSession(directory,{actionId:'close-native',action:{kind:'close-print-preview',pageId:previewId}}),'Close native and qualify both original captures');
    const settled=completed(await inspectAction(directory,request.actionId),'Original print settlement');
    assert.equal(settled.result?.print?.input.status,'completed');assert.equal(settled.result?.print?.discovery.status,'found');
    assert.equal(settled.startedAtMs,original.startedAtMs);assert.equal(settled.dispatchedAt,original.dispatchedAt);
    assert.deepEqual(await dispatchSession(directory,request),settled,'Same action ID must rejoin the settled original, never click again.');
    const resumed=await observeSession(directory,{screenshot:true});assert.equal(resumed.pageId,sourcePageId);
    assert.deepEqual(printState(resumed),{clicks:1,trusted:true,before:1,after:1,returned:1,phase:'afterprint'});
    assert.equal(resumed.pages.find(page=>page.pageId===previewId)?.closed,true);
    assert.equal(resumed.events.filter(event=>event.kind==='print-preview'&&event.actionId===request.actionId).length,1);
    assert.equal((await inspectSession(directory)).session.captureActive,false);
    const source=await qualifiedTake(projectPath,sourceStart.take.id,sourcePageId),preview=await qualifiedTake(projectPath,nativeStart.take.id,previewId);
    await recordedReport(projectPath,source.take,'source-ready');await recordedReport(projectPath,preview.take,nativeMark);
    assert.ok(source.window.startMs<original.startedAtMs!);assert.ok(source.window.endMs>closed.startedAtMs!);
    assert.ok(source.window.startMs<preview.window.startMs&&source.window.endMs>preview.window.endMs,'The original source clock must span native-preview recording, not remove its suspended interval.');
    assert.ok(source.source.pointer.some(event=>event.type==='down'));assert.ok(source.source.pointer.some(event=>event.type==='up'));

    stage='verified retained PDF viewer and its distinct capture';
    const openRequest:ActionRequest={actionId:'open-retained-pdf',action:{kind:'open-artifact',artifactId:String(artifact.artifactId)}};
    const opened=completed(await dispatchSession(directory,openRequest),'Open retained PDF');
    assert.deepEqual(await dispatchSession(directory,openRequest),opened,'Rejoining viewer open must not open another page.');
    const viewerId=opened.result?.pageId;assert.ok(viewerId);assert.ok(![sourcePageId,previewId].includes(viewerId));
    const {observation:viewer}=await renderedReport(directory,viewerId);
    assert.equal(viewer.pages.find(page=>page.pageId===viewerId)?.url,`http://127.0.0.1/__walkthrough_pdf/native-print/${artifact.artifactId}.pdf`);
    assert.equal(viewer.nativePrint,undefined);assert.equal(viewer.pages.filter(page=>page.pageId===viewerId&&!page.closed).length,1);
    const viewerStart=await capture<CaptureStart>(directory,{operationId:'viewer-start',kind:'start',request:{title:'Original retained PDF in Chrome viewer'}});
    const {observation:recordingViewer}=await renderedReport(directory,viewerId);sameSelectedReport(viewer,recordingViewer);
    const viewerMark=await settledReportMark(directory,recordingViewer,viewerStart.take.id,'viewer-ready','Rendered original retained PDF');
    const viewerStop=await capture<TakeRecord>(directory,{operationId:'viewer-stop',kind:'stop'});
    assert.equal(viewerStop.id,viewerStart.take.id);const viewed=await qualifiedTake(projectPath,viewerStop.id,viewerId);
    await recordedReport(projectPath,viewed.take,viewerMark);
    assert.deepEqual(await readFile(artifactPath),pdf,'Viewing must leave the original retained PDF bytes unchanged.');
    assert.equal(printState(await observeSession(directory,{pageId:sourcePageId,screenshot:false})).clicks,1);

    stage='sealing original captures and PDF';
    const sealed=await sealTakes({projectPath,takeIds:[source.take.id,preview.take.id,viewed.take.id],artifactPaths:[{path:artifactPath,id:String(artifact.artifactId),title:'Actual three-page printed report',filename:String(artifact.filename),mediaType:'application/pdf',role:'deliverable'}]});
    const verified=await loadSourceSet(projectPath,sealed.sourceSet.id);assert.equal(verified.sourceSet.sources.length,3);
    assert.deepEqual(await readFile(verified.artifactPaths[String(artifact.artifactId)]),pdf);
    for(const item of [source,preview,viewed])t.diagnostic(`${item.take.title}: ${item.source.frameCount} native frames; clock uncertainty=${item.source.clock.uncertaintySeconds}, drift=${item.source.clock.driftSeconds}.`);
    t.diagnostic(`Verified one trusted print click, three PDF pages, exact retained SHA-256 ${artifact.sha256}, and three original calibrated sources. This is a source/custody regression, not full-film viewing acceptance.`);
    passed=true;
  }catch(error){
    if(error instanceof Error)error.message=`${stage}: ${error.message}`;
    throw error;
  }
});
