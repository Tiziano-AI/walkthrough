import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {EventEmitter,once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openSession,observeSession,dispatchSession,listSessionArtifacts,closeSession} from '../src/session/index.ts';
import type {SessionAction,SessionConfig} from '../src/session/contracts.ts';
import {createProject,ownedDirectory,retainFile,saveSourceSet,loadSourceSet} from '../src/project/store.ts';

// A synthetic 1x1 PNG, unrelated to any author project or retained film.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const sha256=createHash('sha256').update(png).digest('hex');
const filename='Board export.PNG';
const html=`<!doctype html><a href="/download" download="${filename}">Download PNG</a>
<input type="file" aria-label="Upload" hidden><button>Choose upload</button><pre>No file</pre>
<script>
async function receive(input){
 const file=input.files[0],bytes=await file.arrayBuffer();
 const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
 const receipt={name:file.name,type:file.type,size:file.size,sha256};
 document.querySelector('pre').textContent=JSON.stringify(receipt);
 await fetch('/received',{method:'POST',body:JSON.stringify(receipt)});
}
document.querySelector('input').onchange=event=>receive(event.target);
document.querySelector('button').onclick=()=>{
 const input=document.createElement('input');input.type='file';input.onchange=()=>receive(input);input.click();
};
</script>`;

test('public download and reimport preserve filename, meaningful MIME and exact bytes',async t=>{
 const root=await mkdtemp('/private/tmp/wts-mime-'),projectPath=join(root,'project'),inputs=join(root,'inputs');
 await mkdir(inputs);await writeFile(join(inputs,filename),png);
 const receipts=new EventEmitter();
 const server=createServer(async(request,response)=>{
  if(request.url==='/download'){
   // Filename inference must work even when a server labels its download generically.
   response.writeHead(200,{'content-type':'application/octet-stream','content-disposition':`attachment; filename="${filename}"`});response.end(png);
  }else if(request.url==='/received'){
   const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
   response.end('received');receipts.emit('file',JSON.parse(Buffer.concat(chunks).toString()));
  }else{response.setHeader('content-type','text/html');response.end(html);}
 });
 const previousState=process.env.WALKTHROUGH_STATE_ROOT;process.env.WALKTHROUGH_STATE_ROOT=join(root,'state');
 let directory:string|undefined;
 t.after(async()=>{
  try{if(directory)await closeSession(directory);}finally{
   await new Promise<void>(resolve=>server.close(()=>resolve()));
   if(previousState===undefined)delete process.env.WALKTHROUGH_STATE_ROOT;else process.env.WALKTHROUGH_STATE_ROOT=previousState;
   await rm(root,{recursive:true,force:true});
  }
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
 const {project}=await createProject(projectPath,{title:'Artifact MIME test',brief:'Exercise synthetic download and exact-file upload.',audience:'Test',mandate:{applicationUrl:origin,navigationOrigins:[origin],network:'loopback-only',allowedEffects:'Synthetic local downloads and file input.',dataDescription:'Synthetic one-pixel image',inputRoots:[inputs],mediaReview:'agent-reviewable-synthetic',delivery:'local'}});
 directory=join(projectPath,'sessions','mime');
 const config:SessionConfig={directory,projectPath,projectId:project.id,startUrl:origin,allowedOrigins:[origin],uploadRoots:[inputs],network:'loopback-only',mediaReview:'agent-reviewable-synthetic',headless:true,pacing:{minimumApproachMs:0,distanceMsPerPixel:0,targetDwellMs:0,keyDelayMs:0}};
 await openSession(config);
 const target=async(name:string)=>{
  const observation=await observeSession(config.directory,{screenshot:false}),ref=observation.refs.find(ref=>ref.name===name);assert.ok(ref,name);return {ref:ref.ref};
 };
 const clicked=await dispatchSession(directory,{actionId:'download',action:{kind:'click',target:await target('Download PNG')}});
 assert.equal(clicked.status,'input-completed',JSON.stringify(clicked.error));
 let artifact:Record<string,unknown>|undefined;
 for(let attempt=0;attempt<100;attempt++){
  artifact=(await listSessionArtifacts(directory)).find(item=>item.status==='retained');if(artifact)break;await delay(20);
 }
 assert.ok(artifact,'The original download must finish retention before reimport');
 assert.equal(artifact.filename,filename);assert.equal(artifact.bytes,png.length);assert.equal(artifact.sha256,sha256);
 await t.test('new retained download identifies the original named PNG',()=>{assert.equal(artifact.mediaType,'image/png');});

 async function upload(actionId:string,source:Pick<Extract<SessionAction,{kind:'upload'}>,'paths'|'artifactIds'|'sourceArtifacts'>,control:string,name:string,type:string){
  const receipt=once(receipts,'file',{signal:AbortSignal.timeout(10000)});
  const result=await dispatchSession(config.directory,{actionId,action:{kind:'upload',target:await target(control),...source}});
  const [received]=await receipt;
  assert.equal(result.status,'input-completed',JSON.stringify(result.error));
  assert.deepEqual(received,{name,type,size:png.length,sha256});
 }
 await t.test('same-session artifact reaches the input-backed chooser with its original name and MIME',async()=>{
  await upload('reimport-current',{artifactIds:[String(artifact.artifactId)]},'Choose upload',filename,'image/png');
 });

 const retainedRoot=await ownedDirectory(projectPath,'sources','old-generic'),media=await retainFile(join(inputs,filename),retainedRoot,'source.bin');
 const retained=await retainFile(join(inputs,filename),retainedRoot,'artifacts/original');
 const sealed=await saveSourceSet(projectPath,{schemaVersion:1,kind:'source-set',id:'old-generic',projectId:project.id,createdAt:'2026-10-01',state:'sealed',mediaReview:'agent-reviewable-synthetic',sources:[{id:'source',media,width:3200,height:1800,durationSeconds:1,frameCount:60,clock:{offsetSeconds:0,uncertaintySeconds:0,driftSeconds:0},pointer:[],usableRange:{startSeconds:0,endSeconds:1}}],marks:[],artifacts:[
  {...retained,id:'old-png',title:'Earlier generic PNG',filename,mediaType:'application/octet-stream',role:'source'},
  {...retained,id:'explicit-type',title:'Explicit media type',filename,mediaType:'application/x-preserved-test',role:'source'},
  {...retained,id:'unknown-type',title:'Unknown filename',filename:'original.unrecognized-walkthrough-test',mediaType:'application/octet-stream',role:'source'},
 ]});
 const manifestBefore=await readFile(sealed.path),bytesBefore=await readFile(join(retainedRoot,retained.relativePath));
 await t.test('already-retained generic PNG is corrected only in the chooser payload',async()=>{
  await upload('reimport-old',{sourceArtifacts:[{sourceSetId:'old-generic',artifactId:'old-png'}]},'Choose upload',filename,'image/png');
 });
 await t.test('specific retained MIME wins over filename inference',async()=>{
  await upload('reimport-specific',{sourceArtifacts:[{sourceSetId:'old-generic',artifactId:'explicit-type'}]},'Upload',filename,'application/x-preserved-test');
 });
 await t.test('unresolved filename remains generic',async()=>{
  await upload('reimport-unknown',{sourceArtifacts:[{sourceSetId:'old-generic',artifactId:'unknown-type'}]},'Upload','original.unrecognized-walkthrough-test','application/octet-stream');
 });
 await t.test('admitted path uses its actual filename and meaningful MIME',async()=>{
  await upload('upload-path',{paths:[join(inputs,filename)]},'Upload',filename,'image/png');
 });
 assert.deepEqual(await readFile(sealed.path),manifestBefore,'Reimport must not rewrite the old immutable manifest');
 assert.deepEqual(await readFile(join(retainedRoot,retained.relativePath)),bytesBefore,'Reimport must not rewrite retained bytes');
 assert.equal((await loadSourceSet(projectPath,'old-generic')).sha256,sealed.sha256);
});
