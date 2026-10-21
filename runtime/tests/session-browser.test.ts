import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Page} from 'playwright';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm,readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openSession,observeSession,dispatchSession,captureSession,inspectSession,closeSession,inspectAction,resolveAction,listSessionArtifacts,sessionRequest} from '../src/session/index.ts';
import type {Observation,ResolvedTarget,SessionAction,SessionConfig,SessionInfo} from '../src/session/contracts.ts';
import {actionPath,infoPath,recoverInterruptedActions,writeJson,readAction,digest} from '../src/session/journal.ts';
import {processTable} from '../src/session/process.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {createProject,loadSourceSet,ownedDirectory,retainFile,saveSourceSet} from '../src/project/store.ts';
import {sealTakes} from '../src/project/capture.ts';
import type {TakeRecord} from '../src/project/contracts.ts';
import {createSessionInput} from '../src/session/input.ts';
import {openSessionBrowser} from '../src/session/browser.ts';
import type {InputEvent} from '../src/session/events.ts';
import {validateAction,validateCaptureRequest} from '../src/session/runtime.ts';

const gestureHtml=`<!doctype html><style>body{margin:0}#plot{position:absolute;left:100px;top:100px;width:400px;height:240px;touch-action:none;background:#eef}input{position:absolute;left:600px;top:100px}#other{top:160px}#events{position:fixed;top:400px;left:10px;width:1500px;height:400px;overflow:hidden}</style>
<svg id="plot" tabindex="0" role="img" aria-label="Plot" viewBox="0 0 400 240"><g><circle id="point" tabindex="0" role="button" aria-label="Point" cx="100" cy="100" r="10"/><circle cx="100" cy="100" r="12"/></g></svg><input id="key-target" aria-label="Key target"><input id="other" aria-label="Other"><pre id="events">EVENTS []</pre>
<script>window.nativeEvents=[];const plot=document.querySelector('#plot'),mode=new URL(location.href).searchParams.get('mode');
for(const kind of ['pointermove','pointerdown','pointerup','wheel','keydown','keyup'])window.addEventListener(kind,e=>{
 window.nativeEvents.push({kind,target:e.target.id,x:e.clientX,y:e.clientY,buttons:e.buttons,shift:e.shiftKey,alt:e.altKey,key:e.key,deltaY:e.deltaY,trusted:e.isTrusted,atMs:performance.now()});document.querySelector('#events').textContent='EVENTS '+JSON.stringify(window.nativeEvents);
 if(kind==='pointerdown'&&e.target.closest('svg'))plot.setPointerCapture(e.pointerId);
 if(kind==='wheel')e.preventDefault();
 if(kind==='keydown'&&e.key==='Shift'){
  const input=document.querySelector('#key-target');
  if(mode==='key-replaced'){const next=input.cloneNode(true);input.replaceWith(next);next.focus()}
  if(mode==='key-hidden')input.style.visibility='hidden';
  if(mode==='key-disabled')input.disabled=true;
  if(mode==='key-blurred')document.querySelector('#other').focus();
  if(mode==='key-moved')input.style.left='800px';
  if(mode==='key-obscured'){const cover=document.createElement('div');cover.style='position:fixed;inset:0;z-index:100';document.body.append(cover)}
  if(mode==='drag-moved')plot.style.left='300px';
 }
}, {capture:true,passive:false});
plot.onpointerenter=()=>{
 if(mode==='hover-replaced')plot.replaceWith(plot.cloneNode(true));
 if(mode==='hover-moved')plot.style.left='300px';
 if(mode==='hover-hidden')plot.style.visibility='hidden';
 if(mode==='hover-obscured'){const cover=document.createElement('div');cover.style='position:fixed;inset:0;z-index:100';document.body.append(cover)}
};</script>`;

const textHtml=`<!doctype html><style>body{margin:0}#editor{position:absolute;left:100px;top:100px;width:240px;height:40px;font:16px monospace}#other{position:absolute;left:700px;top:100px}#state{position:absolute;left:10px;top:400px;white-space:pre-wrap}</style>
<textarea id="editor" aria-label="Editor"></textarea><input id="other" aria-label="Other"><pre id="state"></pre>
<script>
const original=document.querySelector('#editor'),other=document.querySelector('#other'),mode=new URL(location.href).searchParams.get('mode'),events=[];let mutated=false,clicks=0;
function snapshot(){const current=document.querySelector('#editor'),box=current.getBoundingClientRect();document.querySelector('#state').textContent='STATE '+JSON.stringify({original:original.value,current:current.value,other:other.value,focus:document.activeElement.id,mutated,clicks,bounds:{x:box.x,y:box.y,width:box.width,height:box.height},events})}
window.addEventListener('pointerdown',()=>{clicks++;snapshot()},true);
window.addEventListener('input',event=>{
 events.push({kind:'input',target:event.target.id,value:event.target.value,trusted:event.isTrusted});
 if(original.value.includes('\\n')){
  if(mode==='grow'){original.style.height='auto';original.style.height=original.scrollHeight+'px';original.style.width=(240+original.value.length)+'px';original.style.left=(100+original.value.length)+'px'}
  if(!mutated){
   mutated=true;
   if(mode==='replaced'){const next=original.cloneNode(true);next.value=original.value;original.replaceWith(next);next.focus()}
   if(mode==='hidden')original.style.visibility='hidden';
   if(mode==='disabled')original.disabled=true;
   if(mode==='blurred')other.focus();
   if(mode==='obscured'){const cover=document.createElement('div');cover.style='position:absolute;left:0;top:0;width:600px;height:300px;z-index:100';document.body.append(cover)}
  }
 }
 snapshot();
},true);
window.addEventListener('keydown',event=>{events.push({kind:'keydown',target:event.target.id,key:event.key,trusted:event.isTrusted});snapshot()},true);
snapshot();
</script>`;

const html=`<!doctype html><style>body{margin:20px;font:16px sans-serif}button,input,select{margin:8px}canvas{display:block;border:1px solid;width:300px;height:140px}iframe{display:block;width:500px;height:110px}</style>
<h1>Generic session fixture</h1><button id="count">Count</button><span id="result">Count 0</span>
<button id="replace">Replace counter</button><input aria-label="Name" id="name"><select aria-label="Choice" id="choice"><option value="a">A</option><option value="b">B</option></select>
<input id="file" aria-label="Upload" type="file" hidden><span id="file-result">No file</span><br>
<button id="choose-file">Choose upload</button><button id="confirm-file">Confirm upload</button><pre id="chooser-result"></pre>
<button id="dialog">Prompt</button><button id="popup">Popup</button><a href="/download" download="actual.txt">Download</a><a href="https://outside.invalid/">Outside</a>
<canvas id="canvas" width="300" height="140"></canvas><div id="canvas-result">Canvas 0</div>
<iframe title="Child" src="/child"></iframe><p id="detail"></p>
<script>
let count=0;function bind(){document.querySelector('#count').onclick=()=>{document.querySelector('#result').textContent='Count '+(++count)}}bind();
document.querySelector('#replace').onclick=()=>{const old=document.querySelector('#count'),next=old.cloneNode(true);old.replaceWith(next);bind()};
document.querySelector('#name').oninput=e=>document.querySelector('#detail').textContent='Name '+e.target.value;
document.querySelector('#choice').onchange=e=>document.querySelector('#detail').textContent='Choice '+e.target.value;
document.querySelector('#file').onchange=async e=>document.querySelector('#file-result').textContent=await e.target.files[0].text();
const chooserState={clicks:0,trusted:false,files:[]};function chooserSnapshot(){document.querySelector('#chooser-result').textContent='CHOOSER '+JSON.stringify(chooserState)}chooserSnapshot();
for(const id of ['choose-file','confirm-file'])document.getElementById(id).onclick=event=>{
 chooserState.clicks++;chooserState.trusted=event.isTrusted;chooserSnapshot();
 if(id==='confirm-file'&&!confirm('Choose a file?'))return;
 const input=document.createElement('input');input.type='file';input.multiple=true;
 input.onchange=async()=>{chooserState.files=await Promise.all([...input.files].map(async file=>({name:file.name,text:await file.text()})));chooserSnapshot()};input.click();
};
const chooserMode=new URL(location.href).searchParams.get('chooser'),chooserButton=document.getElementById('choose-file');
if(chooserMode==='disabled')chooserButton.disabled=true;
if(chooserMode==='obscured'){const cover=document.createElement('div');cover.style='position:fixed;inset:0;z-index:100';document.body.append(cover)}
chooserButton.onpointerenter=()=>{
 if(chooserMode==='moved')chooserButton.style.transform='translateX(100px)';
 if(chooserMode==='hidden')chooserButton.hidden=true;
 if(chooserMode==='replaced')chooserButton.replaceWith(chooserButton.cloneNode(true));
};
document.querySelector('#dialog').onclick=()=>document.querySelector('#detail').textContent='Prompt '+prompt('Fixture prompt','initial');
document.querySelector('#popup').onclick=()=>window.open('/popup','_blank');
let clicks=0;document.querySelector('#canvas').onclick=e=>document.querySelector('#canvas-result').textContent='Canvas '+(++clicks)+' trusted '+e.isTrusted;
</script>`;

async function setup(){
  const root=await mkdtemp('/private/tmp/wts-'),state=join(root,'state'),project=join(root,'project'),inputs=join(root,'inputs');
  await mkdir(project,{mode:0o700});await mkdir(inputs,{mode:0o700});
  await writeFile(join(inputs,'input.txt'),'actual upload bytes');
  const server=createServer((request,response)=>{
    if(request.url==='/download'){response.writeHead(200,{'content-type':'text/plain','content-disposition':'attachment; filename="actual.txt"'});response.end('retained actual bytes');}
    else if(request.url==='/child'){response.setHeader('content-type','text/html');response.end('<button onclick="this.textContent=\'Child clicked\'">Child button</button>');}
    else if(request.url==='/popup'){response.setHeader('content-type','text/html');response.end('<h1>Popup destination</h1><button>Popup target</button>');}
    else if(request.url?.startsWith('/gestures')){response.setHeader('content-type','text/html');response.end(gestureHtml);}
    else if(request.url?.startsWith('/text')){response.setHeader('content-type','text/html');response.end(textHtml);}
    else{response.setHeader('content-type','text/html');response.end(html);}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
  const prior=process.env.WALKTHROUGH_STATE_ROOT;process.env.WALKTHROUGH_STATE_ROOT=state;
  const created=await createProject(project,{title:'Generic browser qualification',brief:'Exercise native input and retained capture on a local synthetic page.',audience:'Test',mandate:{applicationUrl:origin,navigationOrigins:[origin],network:'loopback-only',allowedEffects:'Synthetic fixture input and downloads.',dataDescription:'Generated test data',inputRoots:[inputs],mediaReview:'agent-reviewable-synthetic',delivery:'local'}});
  const config:SessionConfig={directory:join(project,'sessions','synthetic'),projectPath:project,projectId:created.project.id,startUrl:origin,allowedOrigins:[origin],uploadRoots:[inputs],network:'loopback-only',mediaReview:'agent-reviewable-synthetic',headless:true,pacing:{minimumApproachMs:30,distanceMsPerPixel:0,targetDwellMs:0,keyDelayMs:0}};
  try{await openSession(config);}catch(error){await new Promise<void>(resolve=>server.close(()=>resolve()));if(prior===undefined)delete process.env.WALKTHROUGH_STATE_ROOT;else process.env.WALKTHROUGH_STATE_ROOT=prior;throw error;}
  return {root,config,origin,inputs,async close(options:{retain?:boolean}={}){try{await closeSession(config.directory);}catch{}await new Promise<void>(resolve=>server.close(()=>resolve()));if(prior===undefined)delete process.env.WALKTHROUGH_STATE_ROOT;else process.env.WALKTHROUGH_STATE_ROOT=prior;if(!options.retain)await rm(root,{recursive:true,force:true});}};
}
const target=(observation:Observation,name:string)=>({ref:observation.refs.find(ref=>ref.name===name)!.ref});

test('one persistent worker observes generic controls, keeps exact refs and never redispatches an action ID',async()=>{
  const fixture=await setup();const directory=fixture.config.directory;
  try{
    let observation=await observeSession(directory,{screenshot:true});
    assert.equal(observation.width,1600);assert.equal(observation.coordinateSpace,'css');assert.deepEqual(observation.screenshotPixels,{width:3200,height:1800});assert.ok(observation.screenshotPath);
    const counter=target(observation,'Count');
    const request={actionId:'count-once',action:{kind:'click',target:counter} as SessionAction};
    const first=await dispatchSession(directory,request);assert.equal(first.status,'input-completed',JSON.stringify(first.error));
    const replay=await dispatchSession(directory,request);assert.deepEqual(replay,first);
    await assert.rejects(dispatchSession(directory,{...request,action:{kind:'hover',target:counter}}),/different payload/);
    observation=await observeSession(directory,{screenshot:false});assert.match(observation.text,/Count 1/);
    const replaced=await dispatchSession(directory,{actionId:'replace',action:{kind:'click',target:target(observation,'Replace counter')}});assert.equal(replaced.status,'input-completed');
    const stale=await dispatchSession(directory,{actionId:'stale-ref',action:{kind:'click',target:counter}});assert.equal(stale.status,'not-dispatched');assert.equal(stale.error?.code,'STALE_ELEMENT_REF');
    observation=await observeSession(directory,{screenshot:false});
    assert.equal((await dispatchSession(directory,{actionId:'type',action:{kind:'text',target:target(observation,'Name'),text:'Ada',mode:'replace'}})).status,'input-completed');
    assert.equal((await dispatchSession(directory,{actionId:'select',action:{kind:'select',target:target(observation,'Choice'),values:['b']}})).status,'input-completed');
    assert.equal((await dispatchSession(directory,{actionId:'file',action:{kind:'upload',target:target(observation,'Upload'),paths:[join(fixture.inputs,'input.txt')]}})).status,'input-completed');
    const child=await dispatchSession(directory,{actionId:'child',action:{kind:'click',target:target(observation,'Child button')}});assert.equal(child.status,'input-completed',JSON.stringify(child.error));
    observation=await observeSession(directory,{screenshot:false});
    assert.equal(observation.refs.find(ref=>ref.name==='Name')?.value,'Ada');assert.equal(observation.refs.find(ref=>ref.name==='Choice')?.value,'b');
    assert.match(observation.text,/actual upload bytes/);assert.ok(observation.refs.some(ref=>ref.name==='Child clicked'));
    const canvas=observation.refs.find(ref=>ref.tag==='canvas')!.bounds!;
    const clicked=await dispatchSession(directory,{actionId:'canvas',action:{kind:'click',target:{surfaceId:observation.surfaceId,x:canvas.x+100,y:canvas.y+50}}});assert.equal(clicked.status,'input-completed');
    assert.match((await observeSession(directory,{screenshot:false})).text,/Canvas 1 trusted true/);
    assert.equal((await dispatchSession(directory,{actionId:'outside',action:{kind:'navigate',url:'https://outside.invalid'}})).status,'not-dispatched');
    await assert.rejects(sessionRequest(directory,'evaluate',{script:'alert(1)'}),/UNKNOWN_SESSION_METHOD/);
  }finally{await fixture.close();}
});

test('popup, dialog and real download are observed without switching the selected page; reimport uses retained bytes',async()=>{
  const fixture=await setup(),directory=fixture.config.directory;
  try{
    let observation=await observeSession(directory,{screenshot:false});const original=observation.pageId;
    let result=await dispatchSession(directory,{actionId:'popup',action:{kind:'click',target:target(observation,'Popup')}});assert.equal(result.status,'input-completed',JSON.stringify(result.error));
    observation=await observeSession(directory,{screenshot:false});assert.equal(observation.pageId,original);assert.equal(observation.pages.filter(page=>!page.closed).length,2);
    result=await dispatchSession(directory,{actionId:'prompt',action:{kind:'click',target:target(observation,'Prompt')}});assert.equal(result.status,'outcome-uncertain',JSON.stringify(result.error));assert.equal(result.error?.code,'DIALOG_PENDING');
    const state=await inspectSession(directory),dialog=state.events!.find(event=>event.kind==='dialog')!;
    assert.ok(dialog);assert.equal(state.session.selectedPageId,original);
    await assert.rejects(observeSession(directory),/retained dialog/);
    result=await dispatchSession(directory,{actionId:'answer',action:{kind:'dialog',dialogId:String(dialog.detail.dialogId),response:'accept',promptText:'yes'}});assert.equal(result.status,'input-completed');
    assert.equal((await inspectAction(directory,'prompt')).status,'input-completed');
    observation=await observeSession(directory,{screenshot:false});assert.match(observation.text,/Prompt yes/);
    result=await dispatchSession(directory,{actionId:'download',action:{kind:'click',target:target(observation,'Download')}});assert.equal(result.status,'input-completed',JSON.stringify(result.error));
    let artifacts=await listSessionArtifacts(directory);
    for(let attempt=0;attempt<20&&artifacts[0]?.status!=='retained';attempt++)artifacts=await listSessionArtifacts(directory);
    assert.equal(artifacts[0]?.status,'retained');assert.equal(await readFile(String(artifacts[0].path),'utf8'),'retained actual bytes');
    result=await dispatchSession(directory,{actionId:'reimport',action:{kind:'upload',target:target(observation,'Upload'),artifactIds:[String(artifacts[0].artifactId)]}});assert.equal(result.status,'input-completed',JSON.stringify(result.error));
    observation=await observeSession(directory,{screenshot:false});assert.match(observation.text,/retained actual bytes/);
    const popup=observation.pages.find(page=>page.pageId!==original&&!page.closed)!;
    result=await dispatchSession(directory,{actionId:'choose-popup',action:{kind:'select-page',pageId:popup.pageId}});assert.equal(result.status,'input-completed');
    assert.match((await observeSession(directory,{screenshot:false})).text,/Popup destination/);
  }finally{await fixture.close();}
});

test('upload opens an application-created detached file input with one trusted button click and retained bytes',async()=>{
  const fixture=await setup(),directory=fixture.config.directory;
  try{
    let observation=await observeSession(directory,{screenshot:false});
    const action={kind:'upload' as const,target:target(observation,'Choose upload'),paths:[join(fixture.inputs,'input.txt')]},request={actionId:'chooser-upload',action};
    const first=await dispatchSession(directory,request);assert.equal(first.status,'input-completed',JSON.stringify(first.error));
    assert.deepEqual(await dispatchSession(directory,request),first);
    observation=await observeSession(directory,{screenshot:false});
    assert.match(observation.text,/CHOOSER \{"clicks":1,"trusted":true,"files":\[\{"name":"input.txt","text":"actual upload bytes"\}\]\}/);
    await dispatchSession(directory,{actionId:'chooser-download',action:{kind:'click',target:target(observation,'Download')}});
    let artifacts=await listSessionArtifacts(directory);
    for(let attempt=0;attempt<20&&artifacts[0]?.status!=='retained';attempt++)artifacts=await listSessionArtifacts(directory);
    assert.equal(artifacts[0]?.status,'retained');
    observation=await observeSession(directory,{screenshot:false});
    const retained=await dispatchSession(directory,{actionId:'chooser-retained',action:{kind:'upload',target:target(observation,'Choose upload'),artifactIds:[String(artifacts[0].artifactId)]}});
    assert.equal(retained.status,'input-completed',JSON.stringify(retained.error));
    observation=await observeSession(directory,{screenshot:false});
    assert.match(observation.text,/CHOOSER \{"clicks":2,"trusted":true,"files":\[\{"name":"actual.txt","text":"retained actual bytes"\}\]\}/);
    const refused=await dispatchSession(directory,{actionId:'chooser-outside-mandate',action:{...action,target:target(observation,'Choose upload'),paths:[join(fixture.config.directory,'config.json')]}});
    assert.equal(refused.status,'not-dispatched');assert.equal(refused.error?.code,'UPLOAD_OUTSIDE_MANDATE');
    assert.match((await observeSession(directory,{screenshot:false})).text,/CHOOSER \{"clicks":2,/);
  }finally{await fixture.close();}
});

test('chooser upload keeps its original attempt while a JavaScript confirmation is answered',async()=>{
  const fixture=await setup(),directory=fixture.config.directory;
  try{
    const observation=await observeSession(directory,{screenshot:false});
    const request={actionId:'chooser-confirm',action:{kind:'upload' as const,target:target(observation,'Confirm upload'),paths:[join(fixture.inputs,'input.txt')]}};
    const pending=await dispatchSession(directory,request);assert.equal(pending.status,'outcome-uncertain');assert.equal(pending.error?.code,'DIALOG_PENDING');
    const state=await inspectSession(directory),dialog=state.events!.find(event=>event.kind==='dialog')!;assert.ok(dialog);
    assert.equal((await dispatchSession(directory,{actionId:'chooser-confirm-answer',action:{kind:'dialog',dialogId:String(dialog.detail.dialogId),response:'accept'}})).status,'input-completed');
    assert.equal((await inspectAction(directory,request.actionId)).status,'input-completed');
    assert.equal((await dispatchSession(directory,request)).status,'input-completed');
    assert.match((await observeSession(directory,{screenshot:false})).text,/CHOOSER \{"clicks":1,"trusted":true,"files":\[\{"name":"input.txt","text":"actual upload bytes"\}\]\}/);
  }finally{await fixture.close();}
});

test('chooser upload never forces a disabled, obscured, hidden, moved or replaced control',async()=>{
  const fixture=await setup(),directory=fixture.config.directory;
  try{
    for(const [mode,code] of [['disabled','ELEMENT_DISABLED'],['obscured','ELEMENT_OBSCURED'],['hidden','ELEMENT_NOT_VISIBLE'],['moved','ELEMENT_MOVED'],['replaced','STALE_ELEMENT_REF']]){
      await dispatchSession(directory,{actionId:`chooser-page-${mode}`,action:{kind:'navigate',url:fixture.origin+`/?chooser=${mode}`}});
      const observation=await observeSession(directory,{screenshot:false});
      const request={actionId:`chooser-refuse-${mode}`,action:{kind:'upload' as const,target:target(observation,'Choose upload'),paths:[join(fixture.inputs,'input.txt')]}};
      const result=await dispatchSession(directory,request);
      assert.equal(result.error?.code,code,JSON.stringify(result));
      assert.equal(result.status,mode==='disabled'?'not-dispatched':'outcome-uncertain');
      assert.deepEqual(await dispatchSession(directory,request),result);
      assert.match((await observeSession(directory,{screenshot:false})).text,/CHOOSER \{"clicks":0,/);
    }
  }finally{await fixture.close();}
});

test('chooser upload retains timed native input and removes failed, timed-out and cancelled waiters',async()=>{
  const root=await mkdtemp('/private/tmp/wts-upload-'),context=await openSessionBrowser({profileDirectory:join(root,'profile'),headless:true,network:'loopback-only'});
  const files=[{name:'first.txt',mimeType:'text/plain',buffer:Buffer.from('first bytes')}];
  try{
    const page=await context.newPage();page.setDefaultTimeout(300);
    await page.setContent(`<button id="idle">No chooser</button><button id="choose">Choose</button><button id="confirm">Confirm upload</button><button id="cross-frame">Other frame</button><iframe srcdoc="<input type='file'>"></iframe><pre id="state">No file</pre><script>
      window.fileChanges=0;window.confirmClicks=0;window.confirmTrusted=false;
      for(const id of ['choose','confirm'])document.getElementById(id).onclick=event=>{
        if(id==='confirm'){window.confirmClicks++;window.confirmTrusted=event.isTrusted;if(!confirm('Choose a file?'))return;}
        const input=document.createElement('input');input.type='file';input.onchange=async()=>{window.fileChanges++;document.querySelector('#state').textContent=await input.files[0].text()};input.click();
      };
      document.querySelector('#cross-frame').onclick=()=>document.querySelector('iframe').contentDocument.querySelector('input').click();
    </script>`);
    const events:InputEvent[]=[],driver=createSessionInput(page,event=>{events.push(event);},{minimumApproachMs:30,distanceMsPerPixel:0,targetDwellMs:0});await driver.ready();
    const resolve=async(selector:string):Promise<ResolvedTarget>=>{
      const element=await page.locator(selector).elementHandle();assert.ok(element);const box=await element.boundingBox();assert.ok(box);
      return {page,element,point:{x:box.x+box.width/2,y:box.y+box.height/2},verifyPointer:async()=>{},verifyKeyboard:async()=>{}};
    };
    const chooserListeners=()=>(page as unknown as {listenerCount(event:string):number}).listenerCount('filechooser');
    const baseline=chooserListeners(),idle=await resolve('#idle');
    await assert.rejects(driver.upload(idle,files,false),{code:'FILE_CHOOSER_NOT_OPENED'});
    assert.equal(chooserListeners(),baseline);
    let checks=0;
    await assert.rejects(driver.upload({...idle,verifyPointer:async()=>{if(++checks===2)throw new Error('CONTROL_MOVED');}},files,false),/CONTROL_MOVED/);
    assert.equal(chooserListeners(),baseline);
    // A subsequent chooser remains unfilled until this test explicitly selects
    // different bytes: no earlier failed upload can consume its event.
    const later=page.waitForEvent('filechooser');await driver.click(await resolve('#choose'));const chooser=await later;
    assert.equal(await page.evaluate(()=>(window as any).fileChanges),0);
    await chooser.setFiles([{...files[0],buffer:Buffer.from('later bytes')}]);
    await page.waitForFunction(()=>document.querySelector('#state')?.textContent==='later bytes');
    assert.equal(await page.locator('#state').textContent(),'later bytes');
    await driver.flush();events.length=0;
    await driver.upload(await resolve('#choose'),files,false);await driver.flush();
    await page.waitForFunction(()=>document.querySelector('#state')?.textContent==='first bytes');
    assert.equal(await page.locator('#state').textContent(),'first bytes');
    assert.equal(chooserListeners(),baseline);
    const native=events.filter(event=>event.source==='browser'&&event.kind.startsWith('pointer'));
    assert.ok(native.some(event=>event.kind==='pointermove'&&event.trusted));
    const down=native.find(event=>event.kind==='pointerdown'),up=native.find(event=>event.kind==='pointerup');assert.ok(down?.trusted&&up?.trusted);assert.ok(up.atMs>down.atMs);
    assert.ok(events.some(event=>event.kind==='upload'&&event.phase==='start'));assert.ok(events.some(event=>event.kind==='upload'&&event.phase==='end'));
    await assert.rejects(driver.upload(await resolve('#cross-frame'),files,false),{code:'FILE_CHOOSER_TARGET_MISMATCH'});
    assert.equal(chooserListeners(),baseline);assert.equal(await page.frames()[1].locator('input').evaluate(element=>(element as HTMLInputElement).files!.length),0);
    await assert.rejects(driver.upload(await resolve('#choose'),[files[0],{...files[0],name:'second.txt'}],false),{code:'FILE_CHOOSER_SELECTION_FAILED'});
    assert.equal(chooserListeners(),baseline);assert.equal(await page.evaluate(()=>(window as any).fileChanges),2);
    // Author confirmation may outlast the browser timeout. The same native
    // click must still open and fill its chooser after the dialog is answered.
    const confirmTarget=await resolve('#confirm'),confirmation=page.waitForEvent('dialog');
    const confirmed=driver.upload(confirmTarget,[{...files[0],buffer:Buffer.from('confirmed bytes')}],false).then(()=>({completed:true}),error=>({error}));
    const dialog=await confirmation;assert.equal(dialog.type(),'confirm');
    await delay(650);assert.equal(chooserListeners(),baseline+1);
    await dialog.accept();const confirmedResult=await confirmed;
    assert.deepEqual(confirmedResult,{completed:true});assert.equal(chooserListeners(),baseline);
    await page.waitForFunction(()=>document.querySelector('#state')?.textContent==='confirmed bytes');
    assert.deepEqual(await page.evaluate(()=>({clicks:(window as any).confirmClicks,trusted:(window as any).confirmTrusted,changes:(window as any).fileChanges})),{clicks:1,trusted:true,changes:3});
    const abort=new AbortController(),cancelled=createSessionInput(page,()=>{},{minimumApproachMs:0,targetDwellMs:0},{signal:abort.signal});
    checks=0;
    await assert.rejects(cancelled.upload({...idle,verifyPointer:async()=>{if(++checks===2)abort.abort();}},files,false),{name:'AbortError'});
    assert.equal(chooserListeners(),baseline);await cancelled.dispose();
    const disposed=createSessionInput(page,()=>{},{minimumApproachMs:0,targetDwellMs:0});checks=0;
    await assert.rejects(disposed.upload({...idle,verifyPointer:async()=>{if(++checks===2)await disposed.dispose();}},files,false),{code:'SESSION_INPUT_DISABLED'});
    assert.equal(chooserListeners(),baseline);
    const originalFrame=page.mainFrame();
    await page.locator('#idle').evaluate(element=>element.addEventListener('click',()=>{location.href='about:blank';},{once:true}));
    await assert.rejects(driver.upload(idle,files,false),{code:'FILE_CHOOSER_DOCUMENT_CHANGED'});
    assert.equal(page.mainFrame(),originalFrame);assert.equal(chooserListeners(),baseline);
    await page.setContent(`<button id="choose">New document</button><script>window.fileChanges=0;document.querySelector('button').onclick=()=>{const input=document.createElement('input');input.type='file';input.onchange=()=>window.fileChanges++;input.click()};</script>`);
    await driver.ready();
    const nextDocument=page.waitForEvent('filechooser');await driver.click(await resolve('#choose'));const nextChooser=await nextDocument;
    assert.equal(await page.evaluate(()=>(window as any).fileChanges),0);await nextChooser.setFiles([]);
    checks=0;
    const newTarget=await resolve('#choose');
    await assert.rejects(driver.upload({...newTarget,verifyPointer:async()=>{if(++checks===2)await page.close();}},files,false),/closed/i);
    assert.equal(chooserListeners(),baseline);await driver.dispose();
  }finally{await context.close();await rm(root,{recursive:true,force:true});}
});

test('authentication suspends observations and input and never resumes recording; navigation invalidates references',async()=>{
  const fixture=await setup(),directory=fixture.config.directory;
  try{
    const observation=await observeSession(directory,{screenshot:false}),counter=target(observation,'Count');
    assert.equal((await dispatchSession(directory,{actionId:'auth-off',action:{kind:'auth-begin'}})).status,'input-completed');
    await assert.rejects(observeSession(directory),/disabled/);
    const auth=await inspectSession(directory);assert.equal(auth.session.status,'authentication');assert.equal(auth.session.captureActive,false);assert.ok(auth.pages!.every(page=>!('url'in (page as object))));
    const disabled=await dispatchSession(directory,{actionId:'private-click',action:{kind:'click',target:counter}});assert.equal(disabled.status,'not-dispatched');
    assert.equal((await dispatchSession(directory,{actionId:'auth-on',action:{kind:'auth-resume'}})).status,'input-completed');
    assert.equal((await inspectSession(directory)).session.captureActive,false);
    assert.equal((await dispatchSession(directory,{actionId:'stale-after-auth',action:{kind:'click',target:counter}})).status,'not-dispatched');
    const fresh=await observeSession(directory,{screenshot:false});
    assert.equal((await dispatchSession(directory,{actionId:'navigate',action:{kind:'navigate',url:fixture.origin+'/next'}})).status,'input-completed');
    assert.equal((await dispatchSession(directory,{actionId:'stale-after-navigation',action:{kind:'click',target:target(fresh,'Count')}})).status,'not-dispatched');
    const resolution=await resolveAction(directory,'stale-after-navigation',{outcome:'no-effect-observed',note:'Original document reference was rejected.'});assert.equal(resolution.status,'not-dispatched');assert.equal(resolution.resolution?.outcome,'no-effect-observed');
  }finally{await fixture.close();}
});

test('retained dispatch admission becomes uncertain after interruption and a never-dispatched action stays distinct',async()=>{
  const root=await mkdtemp(join(tmpdir(),'wt-session-journal-'));await mkdir(join(root,'actions'));
  try{
    const base={version:1 as const,payloadSha256:'a'.repeat(64),action:{kind:'auth-begin'} as const,status:'not-dispatched' as const,createdAt:'2026-10-03T00:00:00Z',updatedAt:'2026-10-03T00:00:00Z',eventIds:[]};
    await writeJson(actionPath(root,'admitted'),{...base,actionId:'admitted',dispatchedAt:'2026-10-03T00:00:01Z'});
    await writeJson(actionPath(root,'prepared'),{...base,actionId:'prepared'});
    await recoverInterruptedActions(root);
    assert.equal((await readAction(root,'admitted'))?.status,'outcome-uncertain');assert.equal((await readAction(root,'prepared'))?.status,'not-dispatched');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('capture starts on the existing worker and page and retains native input on its calibrated clock',async()=>{
  const fixture=await setup(),directory=fixture.config.directory;
  let passed=false;
  try{
    const before=await inspectSession(directory),observation=await observeSession(directory,{screenshot:false});
    const counted=await dispatchSession(directory,{actionId:'before-capture',action:{kind:'click',target:target(observation,'Count')}});assert.equal(counted.status,'input-completed');
    const request={operationId:'take-start',kind:'start' as const,request:{title:'Same-page input'}};
    const started=await captureSession(directory,request) as any;assert.equal(started.status,'completed',JSON.stringify(started.error));
    assert.deepEqual(await captureSession(directory,request),started,'same start identity must not start another take');
    await assert.rejects(captureSession(directory,{...request,request:{title:'Different payload'}}),/CAPTURE_OPERATION_ID_CONFLICT/);
    assert.equal((await dispatchSession(directory,{actionId:'during-capture',action:{kind:'click',target:target(observation,'Count')}})).status,'input-completed');
    const observed=await observeSession(directory,{screenshot:true});assert.match(observed.text,/Count 2/);
    const marked=await captureSession(directory,{operationId:'take-mark',kind:'mark',request:{title:'Count response',settled:true}}) as any;assert.equal(marked.status,'completed',JSON.stringify(marked.error));
    const stopped=await captureSession(directory,{operationId:'take-stop',kind:'stop'}) as {status:string;result:TakeRecord;error?:unknown};
    assert.equal(stopped.status,'completed',JSON.stringify({error:stopped.error,retained:fixture.root}));assert.equal(stopped.result.state,'stopped');
    assert.equal(stopped.result.pageId,before.session.selectedPageId);assert.equal(stopped.result.source?.width,3200);assert.equal(stopped.result.source?.height,1800);
    assert.equal(stopped.result.marks.length,1);assert.equal(stopped.result.marks[0].title,'Count response');
    assert.ok(stopped.result.source!.pointer.some(event=>event.type==='down'));
    assert.ok(stopped.result.source!.pointer.every(event=>event.timeSeconds>=0&&event.timeSeconds<=stopped.result.source!.durationSeconds));
    // The initial position sample may precede the first revealed product
    // raster. Retain it for pointer continuity, but never expose slate footage.
    assert.ok(stopped.result.source!.pointer.filter(event=>event.type!=='move').every(event=>event.timeSeconds>=stopped.result.source!.usableRange.startSeconds&&event.timeSeconds<=stopped.result.source!.usableRange.endSeconds));
    const after=await inspectSession(directory);assert.equal(after.session.pid,before.session.pid);assert.equal(after.session.selectedPageId,before.session.selectedPageId);assert.equal(after.session.captureActive,false);
    assert.match((await observeSession(directory,{screenshot:false})).text,/Count 2/);
    const sealed=await sealTakes({projectPath:fixture.config.projectPath,takeIds:[stopped.result.id]});
    assert.equal((await loadSourceSet(fixture.config.projectPath,sealed.sourceSet.id)).sourceSet.sources[0].id,stopped.result.id);
    passed=true;
  }finally{await fixture.close({retain:!passed});}
});

const nativeEvents=(observation:Observation):any[]=>JSON.parse(observation.text.slice(observation.text.indexOf('EVENTS ')+7));
const textState=(observation:Observation):any=>JSON.parse(observation.text.slice(observation.text.indexOf('STATE ')+6));
test('public typing keeps the focused textarea through native multiline resize, movement and obscuration without replay',async()=>{
  const fixture=await setup(),directory=fixture.config.directory,text='Where should\nwe start?\nHere.';
  try{
    for(const mode of ['grow','obscured']){
      await dispatchSession(directory,{actionId:`go-text-${mode}`,action:{kind:'navigate',url:fixture.origin+'/text?mode='+mode}});
      const before=await observeSession(directory,{screenshot:false}),initial=before.refs.find(ref=>ref.name==='Editor')!.bounds!;
      const request={actionId:`text-${mode}`,action:{kind:'text',target:target(before,'Editor'),text,mode:'type'} as const};
      const result=await dispatchSession(directory,request);assert.equal(result.status,'input-completed',JSON.stringify(result.error));
      const after=await observeSession(directory,{screenshot:false}),state=textState(after);
      assert.equal(after.refs.find(ref=>ref.name==='Editor')?.value,text);assert.equal(state.original,text);assert.equal(state.other,'');assert.equal(state.focus,'editor');assert.equal(state.clicks,1);assert.ok(state.mutated);
      const inputs=state.events.filter((event:any)=>event.kind==='input');
      assert.equal(inputs.length,text.length);assert.ok(inputs.every((event:any)=>event.trusted&&event.target==='editor'));
      assert.deepEqual(inputs.map((event:any)=>event.value),[...text].map((_,index)=>text.slice(0,index+1)));
      if(mode==='grow'){assert.ok(state.bounds.x>initial.x);assert.ok(state.bounds.width>initial.width);assert.ok(state.bounds.height>initial.height);}
      assert.deepEqual(await dispatchSession(directory,request),result);
      assert.deepEqual(textState(await observeSession(directory,{screenshot:false})),state,'same action ID does not click or type again');
    }
  }finally{await fixture.close();}
});

test('public typing stops at input-triggered replacement, hiding, disabling or focus theft without typing the suffix elsewhere',async()=>{
  const fixture=await setup(),directory=fixture.config.directory,prefix='Where should\n',text=prefix+'we start?';
  try{
    for(const [mode,code] of Object.entries({replaced:'STALE_ELEMENT_REF',hidden:'ELEMENT_NOT_VISIBLE',disabled:'ELEMENT_DISABLED',blurred:'ELEMENT_LOST_FOCUS'})){
      await dispatchSession(directory,{actionId:`go-text-${mode}`,action:{kind:'navigate',url:fixture.origin+'/text?mode='+mode}});
      const observation=await observeSession(directory,{screenshot:false}),request={actionId:`text-${mode}`,action:{kind:'text',target:target(observation,'Editor'),text} as const};
      const result=await dispatchSession(directory,request);assert.equal(result.status,'outcome-uncertain',mode);assert.equal(result.error?.code,code,JSON.stringify(result));
      const state=textState(await observeSession(directory,{screenshot:false}));
      assert.equal(state.original,prefix,mode);assert.equal(state.current,prefix,mode);assert.equal(state.other,'',mode);assert.equal(state.clicks,1,mode);
      const inputs=state.events.filter((event:any)=>event.kind==='input');assert.equal(inputs.length,prefix.length,mode);assert.ok(inputs.every((event:any)=>event.trusted&&event.target==='editor'),mode);
      assert.deepEqual(await dispatchSession(directory,request),result);
      assert.deepEqual(textState(await observeSession(directory,{screenshot:false})),state,'a retained partial action never retries its remaining text');
    }
  }finally{await fixture.close();}
});

test('public focused key chords tolerate layout changes and pointer occlusion while modifiers remain held',async()=>{
  const fixture=await setup(),directory=fixture.config.directory;
  try{
    for(const mode of ['key-moved','key-obscured']){
      await dispatchSession(directory,{actionId:`go-${mode}`,action:{kind:'navigate',url:fixture.origin+'/gestures?mode='+mode}});
      const observation=await observeSession(directory,{screenshot:false});
      const result=await dispatchSession(directory,{actionId:mode,action:{kind:'keys',target:target(observation,'Key target'),keys:'Shift+Enter'}});
      assert.equal(result.status,'input-completed',JSON.stringify(result.error));
      const events=nativeEvents(await observeSession(directory,{screenshot:false}));
      assert.ok(events.some(event=>event.kind==='keydown'&&event.target==='key-target'&&event.key==='Enter'&&event.shift&&event.trusted),mode);
      assert.ok(events.some(event=>event.kind==='keyup'&&event.key==='Shift'&&!event.shift),mode);assert.equal(events.filter(event=>event.kind==='pointerdown').length,0,mode);
    }
  }finally{await fixture.close();}
});

test('public hover, wheel, focused keys and paced canvas coordinates produce trusted native input',async()=>{
  const fixture=await setup(),directory=fixture.config.directory;
  try{
    await dispatchSession(directory,{actionId:'gesture-page',action:{kind:'navigate',url:fixture.origin+'/gestures'}});
    let observation=await observeSession(directory,{screenshot:false});
    assert.equal((await dispatchSession(directory,{actionId:'hover',action:{kind:'hover',target:target(observation,'Plot')}})).status,'input-completed');
    assert.equal((await dispatchSession(directory,{actionId:'wheel',action:{kind:'wheel',target:target(observation,'Plot'),deltaX:0,deltaY:125}})).status,'input-completed');
    assert.equal((await dispatchSession(directory,{actionId:'keys',action:{kind:'keys',target:target(observation,'Plot'),keys:'Shift+ArrowRight'}})).status,'input-completed');
    observation=await observeSession(directory,{screenshot:false});let events=nativeEvents(observation);
    assert.ok(events.some(event=>event.kind==='wheel'&&event.deltaY===125&&event.trusted));
    assert.ok(events.some(event=>event.kind==='keydown'&&event.key==='ArrowRight'&&event.shift&&event.trusted));
    assert.equal(events.filter(event=>event.kind==='pointerdown').length,0,'hover, wheel and element-focused keys do not fabricate clicks');
    const surfaceId=observation.surfaceId;
    assert.equal((await dispatchSession(directory,{actionId:'drag',action:{kind:'drag',from:{surfaceId,x:180,y:220},to:{surfaceId,x:420,y:268},modifiers:['Shift'],durationMs:350}})).status,'input-completed');
    assert.equal((await dispatchSession(directory,{actionId:'plain-key',action:{kind:'keys',target:target(observation,'Plot'),keys:'ArrowRight'}})).status,'input-completed');
    events=nativeEvents(await observeSession(directory,{screenshot:false}));const down=events.find(event=>event.kind==='pointerdown'),up=events.find(event=>event.kind==='pointerup'),moves=events.filter(event=>event.kind==='pointermove'&&event.buttons===1);
    assert.deepEqual([down.x,down.y,up.x,up.y],[180,220,420,268]);assert.ok(down.shift&&up.shift&&up.buttons===0);assert.ok(moves.length>=8);
    assert.ok(moves.every(event=>event.trusted&&event.shift));assert.ok(moves.at(-1).atMs-down.atMs>=330);
    assert.ok(moves.every((event,index)=>index===0||event.x>=moves[index-1].x&&event.y>=moves[index-1].y));
    assert.equal(events.filter(event=>event.kind==='keydown'&&event.key==='ArrowRight').at(-1).shift,false);
    const pointRef=target(observation,'Point');
    assert.equal((await dispatchSession(directory,{actionId:'overlapped-key',action:{kind:'keys',target:pointRef,keys:'Enter'}})).status,'input-completed');
    const obscured=await dispatchSession(directory,{actionId:'overlapped-click',action:{kind:'click',target:pointRef}});assert.equal(obscured.error?.code,'ELEMENT_OBSCURED');
    events=nativeEvents(await observeSession(directory,{screenshot:false}));assert.ok(events.some(event=>event.target==='point'&&event.kind==='keydown'&&event.key==='Enter'&&event.trusted));assert.equal(events.filter(event=>event.kind==='pointerdown').length,1,'keyboard access does not require or invent a pointer click');
  }finally{await fixture.close();}
});

test('hover and modifier mutations never silently reacquire a replacement target and release all held keys',async()=>{
  const fixture=await setup(),directory=fixture.config.directory;
  try{
    for(const [mode,code] of Object.entries({'hover-replaced':'STALE_ELEMENT_REF','hover-moved':'ELEMENT_MOVED','hover-hidden':'ELEMENT_NOT_VISIBLE','hover-obscured':'ELEMENT_OBSCURED','key-replaced':'STALE_ELEMENT_REF','key-hidden':'ELEMENT_NOT_VISIBLE','key-disabled':'ELEMENT_DISABLED','key-blurred':'ELEMENT_LOST_FOCUS','drag-moved':'ELEMENT_MOVED'})){
      await dispatchSession(directory,{actionId:`go-${mode}`,action:{kind:'navigate',url:fixture.origin+'/gestures?mode='+mode}});
      const observation=await observeSession(directory,{screenshot:false});
      const action:SessionAction=mode.startsWith('key-')?{kind:'keys',target:target(observation,'Key target'),keys:'Shift+Enter'}:mode==='drag-moved'?{kind:'drag',from:target(observation,'Plot'),to:{surfaceId:observation.surfaceId,x:450,y:300},modifiers:['Shift','Alt']}:{kind:'click',target:target(observation,'Plot')};
      const result=await dispatchSession(directory,{actionId:mode,action});assert.equal(result.status,'outcome-uncertain',mode);assert.equal(result.error?.code,code,JSON.stringify(result));
      const events=nativeEvents(await observeSession(directory,{screenshot:false}));assert.equal(events.filter(event=>event.kind==='pointerdown').length,0,mode);assert.equal(events.filter(event=>event.key==='Enter').length,0,mode);
      if(!mode.startsWith('hover-'))assert.ok(events.some(event=>event.kind==='keyup'&&event.key==='Shift'&&!event.shift),mode);
    }
  }finally{await fixture.close();}
});

test('observation pagination retains its exact screenshot and refs without revisiting the page',async()=>{
  const fixture=await setup(),directory=fixture.config.directory;
  try{
    const first=await observeSession(directory,{limit:2,screenshot:true});assert.equal(first.refs.length,2);assert.ok(first.nextOffset);assert.ok(first.refsTotal>2);
    const next=await observeSession(directory,{observationId:first.observationId,offset:first.nextOffset,limit:2});assert.equal(next.observedAt,first.observedAt);assert.equal(next.screenshotPath,first.screenshotPath);assert.equal(next.surfaceId,first.surfaceId);assert.notEqual(next.refs[0].ref,first.refs[0].ref);
    const replay=await observeSession(directory,{observationId:first.observationId,limit:2});assert.deepEqual(replay,first);
    assert.equal((await dispatchSession(directory,{actionId:'from-retained-observation',action:{kind:'click',target:{ref:first.refs[0].ref}}})).status,'input-completed');
  }finally{await fixture.close();}
});

test('public CLI exposes retained select values and delivers modifier clicks without replay',async()=>{
  const fixture=await setup(),directory=fixture.config.directory;
  const call=async(command:string[],args:string[]=[])=>{
    const {stdout,stderr}=await promisify(execFile)(process.execPath,[join(import.meta.dirname,'../bin/walkthrough.mjs'),...command,'--project',fixture.config.projectPath,'--session','synthetic',...args,'--json'],{timeout:15000});
    assert.equal(stderr,'');return JSON.parse(stdout);
  };
  try{
    const first=(await call(['observe'])).result as Observation;
    const select=first.refs.find(ref=>ref.name==='Choice')!;
    const detail=(await call(['observe'],['--observation',first.observationId,'--ref',select.ref,'--offset','1','--limit','1'])).result as Observation;
    assert.equal(detail.observationId,first.observationId);assert.equal(detail.screenshotPath,first.screenshotPath);
    assert.deepEqual(detail.refs[0].options,[{index:1,value:'b',label:'B',disabled:false,selected:false}]);
    const selected=await call(['act'],['--id','public-select','--data',JSON.stringify({kind:'select',target:{ref:select.ref},values:[detail.refs[0].options![0].value]})]);
    assert.equal(selected.result.status,'input-completed');
    assert.match((await observeSession(directory,{screenshot:false})).text,/Choice b/);
    await dispatchSession(directory,{actionId:'gesture-view',action:{kind:'navigate',url:fixture.origin+'/gestures'}});
    const observation=(await call(['observe'])).result as Observation;
    const args=['--id','public-shift-click','--data',JSON.stringify({kind:'click',target:{surfaceId:observation.surfaceId,x:150,y:150},modifiers:['Shift','Alt']})];
    const click=await call(['act'],args);assert.equal(click.result.status,'input-completed',JSON.stringify(click));
    assert.deepEqual((await call(['act'],args)).result,click.result);
    const events=nativeEvents(await observeSession(directory,{screenshot:false}));
    const downs=events.filter(event=>event.kind==='pointerdown');assert.equal(downs.length,1,'same identity never resends native input');
    assert.equal(downs[0].trusted,true);assert.equal(downs[0].shift,true);assert.equal(downs[0].alt,true);
    const releases=events.filter(event=>event.kind==='keyup');assert.deepEqual(releases.map(event=>event.key),['Alt','Shift']);
  }finally{await fixture.close();}
});

test('strict public action and capture validation rejects null, falsy and unknown optional fields',()=>{
  const ref={ref:'observed'},surface={surfaceId:'observed',x:10,y:10};
  for(const action of [
    {kind:'navigate',url:'http://localhost/',pageId:null},{kind:'navigate',url:'http://localhost/',pageId:1},{kind:'navigate',url:'http://localhost/',pageId:''},
    ...[null,'',false,0].map(mode=>({kind:'text',target:ref,text:'x',mode})),
    ...[null,false,''].map(modifiers=>({kind:'drag',from:surface,to:surface,modifiers})),
    ...[null,false,'Shift',['Shift','Shift'],['ControlOrMeta'],['Alt',7]].map(modifiers=>({kind:'click',target:ref,modifiers})),
    {kind:'keys',target:null,keys:'Enter'},{kind:'click',target:ref,button:null},{kind:'upload',target:ref,paths:['/x'],artifactIds:['y']},
    {kind:'upload',target:ref,sourceArtifacts:null},{kind:'upload',target:ref,sourceArtifacts:[{sourceSetId:'x'}]},
    {kind:'upload',target:ref,sourceArtifacts:[{sourceSetId:'x',artifactId:'y',path:'/escape'}]},{kind:'upload',target:ref,paths:[],sourceArtifacts:[]},
  ])assert.throws(()=>validateAction(action as SessionAction),JSON.stringify(action));
  for(const modifiers of [[],['Shift'],['Alt','Control','Meta','Shift']])assert.doesNotThrow(()=>validateAction({kind:'click',target:ref,modifiers} as SessionAction));
  for(const request of [
    {operationId:'a',kind:'start',request:null},{operationId:'a',kind:'start',request:{title:''}},{operationId:'a',kind:'start',request:{script:'x'}},
    {operationId:'a',kind:'mark',request:{title:'x',settled:null}},{operationId:'a',kind:'mark',request:{title:'x',target:null}},{operationId:'a',kind:'stop',request:{title:'x'}},
  ])assert.throws(()=>validateCaptureRequest(request as any),JSON.stringify(request));
});

test('closing a killed worker reconciles its original actions and process identities without reopening or replay',async()=>{
  const fixture=await setup(),directory=fixture.config.directory;
  try{
    const observation=await observeSession(directory,{screenshot:false});
    const request={actionId:'interrupted-prompt',action:{kind:'click',target:target(observation,'Prompt')} as const};
    const action=await dispatchSession(directory,request);assert.equal(action.status,'outcome-uncertain');
    const before=await inspectSession(directory),identity=before.session.processIdentity!;
    assert.equal(identity.pid,before.session.pid);assert.ok(before.session.processes!.length>1);
    const marker=join(fixture.root,'state','active','synthetic.json');await access(marker);
    process.kill(identity.pid,'SIGKILL');
    let inspected=await inspectSession(directory);
    for(let attempt=0;attempt<100&&inspected.worker!=='stopped';attempt++){await delay(20);inspected=await inspectSession(directory);}
    assert.equal(inspected.live,false);assert.equal(inspected.worker,'stopped');assert.equal(inspected.session.status,'interrupted');
    assert.equal((await dispatchSession(directory,request)).actionId,action.actionId);assert.equal((await inspectAction(directory,action.actionId)).status,'outcome-uncertain');
    const closed=await closeSession(directory);assert.equal(closed.status,'closed');assert.equal(closed.pid,identity.pid);
    await assert.rejects(access(marker),{code:'ENOENT'});
    assert.equal((await openSession(fixture.config)).status,'closed','same session identity must never launch another browser');
    const resolution=await resolveAction(directory,action.actionId,{outcome:'uncertain',note:'The original worker ended while its prompt was pending.'});assert.equal(resolution.status,'outcome-uncertain');
    const originalProcesses=new Set(before.session.processes!.map(process=>`${process.pid}:${process.startedAt}:${process.commandSha256}`));
    assert.ok((await processTable()).filter(row=>!row.state.startsWith('Z')).every(row=>!originalProcesses.has(`${row.pid}:${row.startedAt}:${row.commandSha256}`)));
  }finally{await fixture.close();}
});

test('reused PID and unrecognized group never authorize signalling or removal of the active marker',async()=>{
  const root=await mkdtemp('/private/tmp/wts-custody-'),directory=join(root,'session'),state=join(root,'state');await mkdir(directory,{mode:0o700});await mkdir(join(state,'active'),{recursive:true,mode:0o700});
  const prior=process.env.WALKTHROUGH_STATE_ROOT;process.env.WALKTHROUGH_STATE_ROOT=state;
  try{
    const own=(await processTable()).find(row=>row.pid===process.pid)!;
    const info:SessionInfo={version:1,sessionId:'synthetic',projectId:'synthetic',projectPath:root,directory,status:'open',createdAt:'2026-10-03',updatedAt:'2026-10-03',captureActive:false,socketPath:join(root,'absent.sock'),pid:own.pid,workerToken:'original-worker',processIdentity:{...own,commandSha256:'0'.repeat(64)},processes:[]};
    await writeJson(infoPath(directory),info);const marker=join(state,'active','synthetic.json');await writeJson(marker,{kind:'session',sessionId:'synthetic',projectPath:root,workerToken:info.workerToken});
    const inspected=await inspectSession(directory);assert.equal(inspected.worker,'stopped');assert.equal(inspected.session.status,'interrupted');
    await assert.rejects(closeSession(directory),{code:'SESSION_PROCESS_CUSTODY_UNCERTAIN'});await access(marker);process.kill(process.pid,0);
  }finally{if(prior===undefined)delete process.env.WALKTHROUGH_STATE_ROOT;else process.env.WALKTHROUGH_STATE_ROOT=prior;await rm(root,{recursive:true,force:true});}
});

test('native event retention preserves eased motion, continued pointer, drag release and disposed-listener privacy',async()=>{
  const root=await mkdtemp('/private/tmp/wts-input-'),context=await openSessionBrowser({profileDirectory:join(root,'profile'),headless:true,network:'loopback-only'});
  try{
    const page=await context.newPage();await page.setContent(gestureHtml);const events:InputEvent[]=[];
    const driver=createSessionInput(page,event=>{events.push(event);},{minimumApproachMs:300,distanceMsPerPixel:0,targetDwellMs:40});
    const point=(x:number,y:number)=>({page,point:{x,y},verifyPointer:async()=>{},verifyKeyboard:async()=>{}});
    await driver.ready();await driver.hover(point(180,220));await driver.flush();
    const moves=events.filter(event=>event.kind==='pointermove');assert.ok(moves.length>=10);assert.ok(moves.every(event=>event.source==='browser'&&event.trusted));
    assert.ok(moves.at(-1)!.atMs-moves[0].atMs>=280);const steps=moves.slice(1).map((event,index)=>Math.hypot(event.x!-moves[index].x!,event.y!-moves[index].y!));
    assert.ok(steps[0]<Math.max(...steps)/2&&steps.at(-1)!<Math.max(...steps)/2,'motion eases into and out of its endpoint');
    const count=events.length;await driver.samplePointer();assert.deepEqual(driver.currentPointer(),{x:180,y:220});assert.ok(events.slice(count).every(event=>event.x===180&&event.y===220));
    await driver.drag(point(180,220),point(420,268),{durationMs:350,modifiers:['Shift','Alt']});
    const held=events.filter(event=>event.gesture==='drag'&&event.kind==='pointermove'&&event.buttons===1);
    const observed=await page.evaluate(()=>(window as any).nativeEvents.filter((event:any)=>event.kind==='pointermove'&&event.buttons===1).map(({x,y,buttons,trusted}:any)=>({x,y,buttons,trusted})));
    assert.deepEqual(held.map(({x,y,buttons,trusted})=>({x,y,buttons,trusted})),observed);assert.deepEqual(driver.currentPointer(),{x:420,y:268});
    assert.ok(events.some(event=>event.gesture==='drag'&&event.kind==='pointerup'&&event.buttons===0));assert.equal(events.filter(event=>event.kind==='keyboard'&&event.phase==='up').length,2);
    await driver.dispose();await page.goto('data:text/html,<input id="private">');await page.locator('input').fill('synthetic private value');
    assert.deepEqual(await page.evaluate(()=>Object.keys(window).filter(key=>key.startsWith('__walkthroughSessionInput_'))),[]);
  }finally{await context.close();await rm(root,{recursive:true,force:true});}
});

test('a cancelled drag releases native buttons and modifiers and retains the interrupted trajectory',async()=>{
  const root=await mkdtemp('/private/tmp/wts-release-'),context=await openSessionBrowser({profileDirectory:join(root,'profile'),headless:true,network:'loopback-only'});
  try{
    const page=await context.newPage();await page.setContent(gestureHtml);const events:InputEvent[]=[],abort=new AbortController();
    await page.exposeFunction('cancelHeldInput',()=>abort.abort());
    await page.evaluate(()=>window.addEventListener('pointermove',event=>{if(event.buttons)void (window as any).cancelHeldInput();}));
    const driver=createSessionInput(page,event=>{events.push(event);},{minimumApproachMs:0,distanceMsPerPixel:0,targetDwellMs:0},{signal:abort.signal});
    const point=(x:number,y:number)=>({page,point:{x,y},verifyPointer:async()=>{},verifyKeyboard:async()=>{}});await driver.ready();
    await assert.rejects(driver.drag(point(180,220),point(420,268),{durationMs:500,modifiers:['Shift','Alt']}),{name:'AbortError'});
    assert.ok(events.some(event=>event.kind==='pointerdown'));assert.ok(events.some(event=>event.kind==='pointerup'&&event.buttons===0));assert.equal(events.filter(event=>event.kind==='keyboard'&&event.phase==='up').length,2);
    await page.mouse.move(250,250);await page.keyboard.press('ArrowRight');
    assert.deepEqual(await page.evaluate(()=>{const e=(window as any).nativeEvents.at(-1);return {shift:e.shift,alt:e.alt};}),{shift:false,alt:false});await driver.dispose();
  }finally{await context.close();await rm(root,{recursive:true,force:true});}
});

test('an evidence sink failure retains the remaining native gesture and releases every held input',async()=>{
  const root=await mkdtemp('/private/tmp/wts-evidence-'),context=await openSessionBrowser({profileDirectory:join(root,'profile'),headless:true,network:'loopback-only'});
  try{
    const page=await context.newPage();await page.setContent(gestureHtml);const events:InputEvent[]=[];
    const driver=createSessionInput(page,event=>{events.push(event);if(event.kind==='pointerdown')throw new Error('SYNTHETIC_WRITE_FAILURE');},{minimumApproachMs:0,distanceMsPerPixel:0,targetDwellMs:0});
    const point=(x:number,y:number)=>({page,point:{x,y},verifyPointer:async()=>{},verifyKeyboard:async()=>{}});await driver.ready();
    await assert.rejects(driver.drag(point(180,220),point(420,268),{durationMs:150,modifiers:['Shift','Alt']}),/SYNTHETIC_WRITE_FAILURE/);
    const observed=await page.evaluate(()=>(window as any).nativeEvents.filter((event:any)=>event.kind==='pointermove'&&event.buttons===1).map(({x,y,buttons,trusted}:any)=>({x,y,buttons,trusted})));
    assert.ok(observed.length>1);assert.deepEqual(events.filter(event=>event.kind==='pointermove'&&event.buttons===1).map(({x,y,buttons,trusted})=>({x,y,buttons,trusted})),observed);
    assert.ok(events.some(event=>event.kind==='pointerup'&&event.buttons===0));assert.equal(events.filter(event=>event.kind==='keyboard'&&event.phase==='up').length,2);await driver.dispose();
    assert.deepEqual(await page.evaluate(()=>Object.keys(window).filter(key=>key.startsWith('__walkthroughSessionInput_'))),[]);
  }finally{await context.close();await rm(root,{recursive:true,force:true});}
});

test('cancelled keys release their chord and navigation cannot claim missing native gesture evidence',async()=>{
  const root=await mkdtemp('/private/tmp/wts-keys-'),context=await openSessionBrowser({profileDirectory:join(root,'profile'),headless:true,network:'loopback-only'});
  try{
    const page=await context.newPage();await page.setContent('<input>');const abort=new AbortController(),events:InputEvent[]=[];
    await page.exposeFunction('cancelKey',()=>abort.abort());await page.locator('input').evaluate(element=>element.addEventListener('keydown',event=>{if((event as KeyboardEvent).key==='ArrowRight')void (window as any).cancelKey();}));
    const element=await page.locator('input').elementHandle();assert.ok(element);const target={page,element,point:{x:10,y:10},verifyPointer:async()=>{},verifyKeyboard:async()=>{}};
    const driver=createSessionInput(page,event=>{events.push(event);},{keyDelayMs:100},{signal:abort.signal});await driver.ready();
    await assert.rejects(driver.keys(target,'Shift+ArrowRight'),{name:'AbortError'});assert.equal(events.filter(event=>event.kind==='keyboard'&&event.phase==='down').length,2);assert.equal(events.filter(event=>event.kind==='keyboard'&&event.phase==='up').length,2);await driver.dispose();
    await page.goto('data:text/html,<input>');const navigating=await page.locator('input').elementHandle();assert.ok(navigating);
    await navigating.evaluate(element=>element.addEventListener('keydown',()=>{location.href='about:blank';}));
    const next=createSessionInput(page,()=>{},{keyDelayMs:200});await next.ready();
    await assert.rejects(next.keys({page,element:navigating,point:{x:10,y:10},verifyPointer:async()=>{},verifyKeyboard:async()=>{}},'Enter'),{code:'SESSION_INPUT_EVIDENCE_LOST'});await next.dispose();
  }finally{await context.close();await rm(root,{recursive:true,force:true});}
});

test('sealed artifact reimport selects the exact source set and verifies retained bytes before input',async()=>{
  const fixture=await setup(),directory=fixture.config.directory;
  try{
    const source=join(fixture.inputs,'synthetic-source.bin');await writeFile(source,'Synthetic source envelope for retained-file custody only.');
    for(const [id,text] of [['first-set','first actual artifact'],['second-set','second actual artifact']]){
      const root=await ownedDirectory(fixture.config.projectPath,'sources',id),original=join(fixture.inputs,`${id}.txt`);await writeFile(original,text);
      const media=await retainFile(source,root,'source.bin'),artifact=await retainFile(original,root,'artifact.txt');
      await saveSourceSet(fixture.config.projectPath,{schemaVersion:1,kind:'source-set',id,projectId:fixture.config.projectId,createdAt:'2026-10-03',state:'sealed',mediaReview:'agent-reviewable-synthetic',sources:[{id:'source',media,width:3200,height:1800,durationSeconds:1,frameCount:60,clock:{offsetSeconds:0,uncertaintySeconds:0,driftSeconds:0},pointer:[],usableRange:{startSeconds:0,endSeconds:1}}],marks:[],artifacts:[{...artifact,id:'shared-artifact',title:'Actual artifact',filename:'actual.txt',mediaType:'text/plain',role:'deliverable'}]});
    }
    const observation=await observeSession(directory,{screenshot:false}),uploadTarget=target(observation,'Upload');
    const action={kind:'upload' as const,target:uploadTarget,sourceArtifacts:[{sourceSetId:'second-set',artifactId:'shared-artifact'}]};
    const result=await dispatchSession(directory,{actionId:'sealed-reimport',action});assert.equal(result.status,'input-completed',JSON.stringify(result.error));assert.match((await observeSession(directory,{screenshot:false})).text,/second actual artifact/);
    const chooserAction={...action,target:target(await observeSession(directory,{screenshot:false}),'Choose upload')};
    const chooserResult=await dispatchSession(directory,{actionId:'sealed-chooser-reimport',action:chooserAction});assert.equal(chooserResult.status,'input-completed',JSON.stringify(chooserResult.error));
    assert.match((await observeSession(directory,{screenshot:false})).text,/CHOOSER \{"clicks":1,"trusted":true,"files":\[\{"name":"actual.txt","text":"second actual artifact"\}\]\}/);
    assert.equal((await dispatchSession(directory,{actionId:'missing-artifact',action:{...action,sourceArtifacts:[{sourceSetId:'first-set',artifactId:'missing'}]}})).status,'not-dispatched');
    await writeFile(join(fixture.config.projectPath,'sources','first-set','artifact.txt'),'altered artifact bytes');
    const changed=await dispatchSession(directory,{actionId:'changed-artifact',action:{...action,sourceArtifacts:[{sourceSetId:'first-set',artifactId:'shared-artifact'}]}});assert.equal(changed.status,'not-dispatched');assert.equal(changed.error?.code,'RETAINED_FILE_CHANGED');
    const changedChooser=await dispatchSession(directory,{actionId:'changed-chooser-artifact',action:{...chooserAction,sourceArtifacts:[{sourceSetId:'first-set',artifactId:'shared-artifact'}]}});assert.equal(changedChooser.status,'not-dispatched');assert.equal(changedChooser.error?.code,'RETAINED_FILE_CHANGED');
    assert.match((await observeSession(directory,{screenshot:false})).text,/CHOOSER \{"clicks":1,/);
    assert.match((await observeSession(directory,{screenshot:false})).text,/second actual artifact/);
  }finally{await fixture.close();}
});

test('focused keyboard dispatch does not repeat pointer validation or recover stolen focus in replace mode',async()=>{
  let focused=true,clicked=false,refocuses=0,typed='',pointerChecks=0,keyboardChecks=0;
  const page={frames:()=>[],mainFrame:()=>undefined,
    mouse:{move:async()=>{},down:async()=>{},up:async()=>{clicked=true;}},
    keyboard:{type:async(text:string)=>{typed+=text;},insertText:async(text:string)=>{typed+=text;},down:async()=>{},up:async()=>{}},
  } as unknown as Page;
  const target:ResolvedTarget={page,point:{x:100,y:100},
    element:{evaluate:async()=>focused,ownerFrame:async()=>null,focus:async()=>{refocuses++;focused=true;}} as unknown as ResolvedTarget['element'],
    verifyPointer:async()=>{pointerChecks++;assert.equal(clicked,false,'pointer readiness is not a focused keyboard condition');},
    verifyKeyboard:async()=>{keyboardChecks++;},
  };
  const driver=createSessionInput(page,()=>{},{minimumApproachMs:0,distanceMsPerPixel:0,targetDwellMs:0,keyDelayMs:0});
  await driver.text(target,'A\nB');assert.equal(typed,'A\nB');assert.equal(pointerChecks,3);assert.equal(keyboardChecks,3);assert.equal(refocuses,0);
  clicked=false;focused=false;typed='';
  await assert.rejects(driver.text(target,'replacement','replace'),{code:'ELEMENT_LOST_FOCUS'});
  assert.equal(typed,'');assert.equal(refocuses,0,'a text action never refocuses after its click');await driver.dispose();
});
