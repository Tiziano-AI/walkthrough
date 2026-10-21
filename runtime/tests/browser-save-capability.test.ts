import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {SessionRuntime} from '../src/session/runtime.ts';
import {openSessionBrowser} from '../src/session/browser.ts';
import type {Observation,SessionConfig,SessionInfo} from '../src/session/contracts.ts';

const disableLocalFileSystem='--disable-blink-features=FileSystemAccessLocal';
const payloads={http:Buffer.from([72,84,84,80,0,255,10]),blob:Buffer.from([66,108,111,98,0,128,255]),fallback:Buffer.from([70,97,108,108,98,97,99,107,0,254,13,10])};
const html=`<!doctype html><title>Native save capability fixture</title>
<style>body{font:16px sans-serif;padding:20px}button,input,a{margin:12px}pre{white-space:pre-wrap}</style>
<pre id="capabilities"></pre><button id="picker">Native save picker</button><pre id="picker-result">Picker idle</pre>
<a id="http" href="/download" download="http.bin">HTTP download</a><button id="blob">Blob download</button>
<button id="fallback">Application save</button><pre id="save-result">Save idle</pre>
<button id="opfs">Private storage</button><pre id="storage-result">Storage idle</pre>
<input id="upload" type="file" aria-label="Reimport retained file"><pre id="upload-result">Upload idle</pre>
<script>
const bytes=${JSON.stringify(Object.fromEntries(Object.entries(payloads).map(([name,bytes])=>[name,[...bytes]])))};
document.querySelector('#capabilities').textContent='Capabilities '+JSON.stringify({save:'showSaveFilePicker' in window,open:'showOpenFilePicker' in window,directory:'showDirectoryPicker' in window,opfs:typeof navigator.storage?.getDirectory==='function'});
function download(name){const url=URL.createObjectURL(new Blob([new Uint8Array(bytes[name])],{type:'application/octet-stream'})),link=document.createElement('a');link.href=url;link.download=name+'.bin';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
document.querySelector('#picker').onclick=async event=>{
  const result=document.querySelector('#picker-result');
  result.textContent='Picker called; trusted '+event.isTrusted+'; active '+navigator.userActivation.isActive;
  try{await window.showSaveFilePicker({suggestedName:'native.bin'});result.textContent+='; resolved'}catch(error){result.textContent+='; rejected '+error.name}
};
document.querySelector('#http').onclick=event=>document.querySelector('#save-result').textContent='HTTP requested; trusted '+event.isTrusted;
document.querySelector('#blob').onclick=event=>{download('blob');document.querySelector('#save-result').textContent='Blob requested; trusted '+event.isTrusted};
document.querySelector('#fallback').onclick=async event=>{
  const result=document.querySelector('#save-result');
  if('showSaveFilePicker' in window){
    result.textContent='Application selected native picker; trusted '+event.isTrusted;
    try{const handle=await window.showSaveFilePicker({suggestedName:'fallback.bin'}),writer=await handle.createWritable();await writer.write(new Uint8Array(bytes.fallback));await writer.close();result.textContent+='; saved'}catch(error){result.textContent+='; rejected '+error.name}
  }else{download('fallback');result.textContent='Application selected Blob download; trusted '+event.isTrusted}
};
document.querySelector('#opfs').onclick=async event=>{
  const result=document.querySelector('#storage-result');
  try{const root=await navigator.storage.getDirectory(),handle=await root.getFileHandle('private.bin',{create:true}),writer=await handle.createWritable();await writer.write(new Uint8Array([0,1,128,255]));await writer.close();const file=await handle.getFile();result.textContent='OPFS read '+[...new Uint8Array(await file.arrayBuffer())].join(',')+'; trusted '+event.isTrusted;await root.removeEntry('private.bin')}catch(error){result.textContent='OPFS failed '+error.name}
};
document.querySelector('#upload').onchange=async event=>{const file=event.target.files[0];document.querySelector('#upload-result').textContent='Reimport '+file.name+' '+[...new Uint8Array(await file.arrayBuffer())].join(',')};
</script>`;

async function fixture(){
  const root=await mkdtemp('/private/tmp/wt-save-'),projectPath=join(root,'project'),directory=join(projectPath,'session');
  const previousState=process.env.WALKTHROUGH_STATE_ROOT;
  process.env.WALKTHROUGH_STATE_ROOT=join(root,'state');
  await mkdir(projectPath,{mode:0o700});
  const server=createServer((request,response)=>{
    if(request.url==='/download'){response.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="http.bin"'});response.end(payloads.http);}
    else{response.setHeader('content-type','text/html');response.end(html);}
  });
  let runtime:SessionRuntime|undefined;
  async function close(){
    try{await runtime?.close();}
    finally{
      await new Promise<void>(resolve=>server.close(()=>resolve()));
      if(previousState===undefined)delete process.env.WALKTHROUGH_STATE_ROOT;else process.env.WALKTHROUGH_STATE_ROOT=previousState;
      await rm(root,{recursive:true,force:true});
    }
  }
  try{
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();assert.ok(address&&typeof address==='object');
    const origin=`http://127.0.0.1:${address.port}`;
    const config:SessionConfig={directory,projectPath,projectId:'save-capability',startUrl:origin,allowedOrigins:[origin],uploadRoots:[],network:'loopback-only',mediaReview:'agent-reviewable-synthetic',headless:true,pacing:{minimumApproachMs:30,distanceMsPerPixel:0,targetDwellMs:0,keyDelayMs:0}};
    const now=new Date().toISOString();
    const info:SessionInfo={version:1,sessionId:'save-capability',projectId:config.projectId,projectPath,directory,status:'starting',createdAt:now,updatedAt:now,captureActive:false,socketPath:join(root,'unused.sock'),profileDirectory:join(root,'state','profiles','save-capability'),workerToken:'local-save-capability-test'};
    runtime=await SessionRuntime.open(config,info);
    return {runtime,close};
  }catch(error){await close();throw error;}
}

function target(observation:Observation,name:string){
  const ref=observation.refs.find(ref=>ref.name===name);assert.ok(ref,`Missing control ${name}`);return {ref:ref.ref};
}
async function click(runtime:SessionRuntime,actionId:string,name:string){
  const observation=await runtime.observe({screenshot:false});
  const result=await runtime.dispatch({actionId,action:{kind:'click',target:target(observation,name)}});
  assert.equal(result.status,'input-completed',JSON.stringify(result.error));
}
async function observed(runtime:SessionRuntime,pattern:RegExp){
  let observation=await runtime.observe({screenshot:false});
  for(let attempt=0;attempt<100&&!pattern.test(observation.text);attempt++){await delay(25);observation=await runtime.observe({screenshot:false});}
  assert.match(observation.text,pattern);return observation;
}
async function artifact(runtime:SessionRuntime,filename:string){
  let event=runtime.events.find(event=>event.kind==='download'&&event.detail.filename===filename);
  for(let attempt=0;attempt<100&&event?.detail.status!=='retained';attempt++){await delay(25);event=runtime.events.find(event=>event.kind==='download'&&event.detail.filename===filename);}
  assert.equal(event?.detail.status,'retained',JSON.stringify(event));return event!;
}

test('qualified headless Chromium advertises a native save picker that aborts after trusted input',async t=>{
  // Launch the same real runtime with only the production capability correction
  // removed. No page API, application handler, input or download is mocked.
  const launch=chromium.launchPersistentContext.bind(chromium);
  t.mock.method(chromium,'launchPersistentContext',(...[profile,options]:Parameters<typeof chromium.launchPersistentContext>)=>launch(profile,{...options,args:options?.args?.filter(arg=>arg!==disableLocalFileSystem)}));
  const session=await fixture();
  try{
    assert.match((await session.runtime.observe({screenshot:false})).text,/Capabilities \{"save":true,"open":true,"directory":true,"opfs":true\}/);
    await click(session.runtime,'native-picker','Native save picker');
    await observed(session.runtime,/Picker called; trusted true; active true; rejected AbortError/);
    assert.equal(session.runtime.events.filter(event=>event.kind==='download'||event.kind==='dialog').length,0);
    await click(session.runtime,'native-application-save','Application save');
    await observed(session.runtime,/Application selected native picker; trusted true; rejected AbortError/);
    assert.equal(session.runtime.events.filter(event=>event.kind==='download'||event.kind==='dialog').length,0);
  }finally{await session.close();}
});

test('session capabilities select native application downloads while preserving HTTP, Blob, OPFS and exact reimport',async()=>{
  const session=await fixture(),runtime=session.runtime;
  try{
    assert.match((await runtime.observe({screenshot:false})).text,/Capabilities \{"save":false,"open":false,"directory":false,"opfs":true\}/);
    for(const [kind,name] of [['http','HTTP download'],['blob','Blob download'],['fallback','Application save']] as const){
      await click(runtime,`download-${kind}`,name);
      await observed(runtime,kind==='fallback'?/Application selected Blob download; trusted true/:new RegExp(`${kind==='http'?'HTTP':'Blob'} requested; trusted true`));
      const retained=await artifact(runtime,`${kind}.bin`),expected=payloads[kind];
      assert.deepEqual(await readFile(String(retained.detail.path)),expected);
      assert.equal(retained.detail.bytes,expected.length);
      assert.equal(retained.detail.sha256,createHash('sha256').update(expected).digest('hex'));
      const observation=await runtime.observe({screenshot:false});
      const result=await runtime.dispatch({actionId:`reimport-${kind}`,action:{kind:'upload',target:target(observation,'Reimport retained file'),artifactIds:[String(retained.detail.artifactId)]}});
      assert.equal(result.status,'input-completed',JSON.stringify(result.error));
      await observed(runtime,new RegExp(`Reimport ${kind}\\.bin ${[...expected].join(',')}$`));
    }
    await click(runtime,'private-storage','Private storage');
    await observed(runtime,/OPFS read 0,1,128,255; trusted true/);
    assert.equal(runtime.events.filter(event=>event.kind==='download').length,3);
    assert.equal(runtime.events.filter(event=>event.kind==='dialog').length,0);
  }finally{await session.close();}
});

test('headed and headless launches configure the same bounded native-file capability',async t=>{
  const launches:Array<Parameters<typeof chromium.launchPersistentContext>[1]>=[],stop=new Error('launch inspected');
  t.mock.method(chromium,'launchPersistentContext',async(...[_profile,options]:Parameters<typeof chromium.launchPersistentContext>)=>{launches.push(options);throw stop;});
  for(const headless of [false,true])await assert.rejects(openSessionBrowser({profileDirectory:'/unused-save-capability-profile',headless,network:'loopback-only'}),error=>error===stop);
  assert.deepEqual(launches.map(options=>options?.headless),[false,true]);
  for(const options of launches){
    assert.ok(options?.args?.includes(disableLocalFileSystem));
    assert.equal(options?.acceptDownloads,true);
    assert.ok(!options?.args?.some(arg=>arg.includes('FileSystemAccessOriginPrivate')));
  }
});
