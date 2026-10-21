import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRenderProgressWriter,inspectRenderProgress,readRenderWorkCounter,remotionProgress,type RenderProgressRecord} from '../src/render/progress.ts';

const recordedAt='2026-10-01T09:00:00.000Z';
const sample:RenderProgressRecord={schemaVersion:1,kind:'render-progress',recordedAt,phase:'rendering-and-encoding',frames:{rendered:120,total:600}};
const manifest={status:'running',stage:'rendering'};
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){
  const directory=await mkdtemp(join(await realpath(tmpdir()),'walkthrough-render-progress-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const render=join(directory,'render');await mkdir(render);return {directory,render};
}

test('streaming observations expose real rendered frames, never the weighted encode/mux aggregate or estimate',()=>{
  const observed={renderedFrames:120,encodedFrames:96,renderedDoneIn:null,encodedDoneIn:null,renderEstimatedTime:9000,progress:0.14,stitchStage:'encoding' as const};
  assert.deepEqual(remotionProgress(observed,600),{phase:'rendering-and-encoding',frames:{rendered:120,total:600}});
  assert.deepEqual(remotionProgress({...observed,renderedFrames:600,encodedFrames:400},600),{phase:'encoding',frames:{rendered:600,total:600}},'encoder drain begins after the last picture, before renderedDoneIn is set');
  assert.deepEqual(remotionProgress({...observed,renderedFrames:600,renderedDoneIn:100,encodedFrames:540,stitchStage:'muxing'},600),{phase:'muxing',frames:{rendered:600,total:600}});
});

test('frame callbacks coalesce into bounded writes and final flush retains the latest event timestamp',async()=>{
  let now=Date.parse(recordedAt);const writes:RenderProgressRecord[]=[];
  const writer=createRenderProgressWriter('/unused',{now:()=>now,write:async record=>{writes.push(record);}});
  writer.record(sample);await writer.flush();assert.equal(writes.length,1);
  now+=100;
  for(let rendered=121;rendered<=450;rendered++)writer.record({phase:'rendering-and-encoding',frames:{rendered,total:600}});
  await Promise.resolve();assert.equal(writes.length,1,'no write for every frame');
  now+=900;writer.record({phase:'rendering-and-encoding',frames:{rendered:451,total:600}});await writer.flush();
  assert.equal(writes.length,2);assert.equal(writes[1].frames?.rendered,451);
  now+=10;writer.record({phase:'rendering-and-encoding',frames:{rendered:452,total:600}});
  now+=100;await writer.flush();
  assert.equal(writes.length,3);assert.equal(writes[2].frames?.rendered,452);
  assert.equal(writes[2].recordedAt,new Date(Date.parse(recordedAt)+1010).toISOString(),'flush must not renew observation time');
  writer.record({phase:'encoding',frames:{rendered:600,total:600}});await writer.flush();
  assert.equal(writes.length,4,'a phase change is retained without waiting for the interval');
});

test('a slow writer has one in-flight write and one pending latest observation',async()=>{
  const writes:RenderProgressRecord[]=[];let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});let active=0,maximumActive=0;
  const writer=createRenderProgressWriter('/unused',{now:()=>Date.parse(recordedAt),write:async record=>{
    active++;maximumActive=Math.max(maximumActive,active);writes.push(record);await blocked;active--;
  }});
  writer.record({phase:'rendering-and-encoding',frames:{rendered:0,total:600}});
  for(let rendered=1;rendered<=600;rendered++)writer.record({phase:'rendering-and-encoding',frames:{rendered,total:600}});
  assert.equal(writes.length,1);const flushed=writer.flush();release();await flushed;
  assert.equal(maximumActive,1);assert.equal(writes.length,2);assert.equal(writes[1].frames?.rendered,600);
});

test('reporting failure is bounded and cannot create a media result or throw from the render callback',async()=>{
  const warnings:string[]=[];let attempts=0;
  const writer=createRenderProgressWriter('/unused',{write:async()=>{attempts++;throw Error('unwritable');},warn:message=>warnings.push(message)});
  writer.record(sample);await writer.flush();
  writer.record({phase:'finishing-media'});await writer.flush();
  assert.equal(attempts,1);assert.equal(warnings.length,1);assert.match(warnings[0],/composition status remains authoritative/);
});

test('invalid callback counts are not clamped into a plausible successful record',async()=>{
  const writes:RenderProgressRecord[]=[],warnings:string[]=[];
  const writer=createRenderProgressWriter('/unused',{write:async record=>{writes.push(record);},warn:message=>warnings.push(message)});
  writer.record({phase:'encoding',frames:{rendered:601,total:600}});await writer.flush();
  assert.equal(writes.length,0);assert.equal(warnings.length,1);
});

test('atomic replacement retains a bounded private JSON record, without a frame log or temporary files',async t=>{
  const f=await fixture(t),writer=createRenderProgressWriter(f.render);
  writer.record(sample);await writer.flush();
  const observations:Promise<Awaited<ReturnType<typeof inspectRenderProgress>>>[]=[];
  for(let rendered=121;rendered<=128;rendered++){
    writer.record({phase:'rendering-and-encoding',frames:{rendered,total:600}});
    observations.push(inspectRenderProgress(f.directory,manifest));await writer.flush();
  }
  for(const observation of await Promise.all(observations))assert.equal(observation.state,'recorded');
  const retained=JSON.parse(await readFile(join(f.render,'progress.json'),'utf8'));
  assert.deepEqual(retained.frames,{rendered:128,total:600});assert.deepEqual(await readdir(f.render),['progress.json']);
  const info=await stat(join(f.render,'progress.json'));assert.ok(info.size<4096);assert.equal(info.mode&0o777,0o600);
});

test('old observations remain recorded-only; a later or failed composition stage makes them historical',async t=>{
  const f=await fixture(t);await writeFile(join(f.render,'progress.json'),JSON.stringify(sample));
  for(const [status,stage,historical] of [['running','rendering',false],['running','temporal-qa',true],['failed','rendering',true],['awaiting-human-review','complete-bundle-awaiting-review',true]] as const){
    const result=await inspectRenderProgress(f.directory,{status,stage});
    assert.equal(result.state,'recorded');assert.equal(result.historical,historical);assert.equal(result.processLiveness,'not-observed');
    assert.equal(result.statusBasis,'last-recorded-render-progress');assert.deepEqual(result.record,sample);
  }
});

test('old compositions with no progress and malformed records remain inspectable without invented counts',async t=>{
  const f=await fixture(t);
  assert.equal((await inspectRenderProgress(f.directory,manifest)).state,'not-recorded');
  for(const value of ['{','x'.repeat(4097),JSON.stringify({...sample,phase:'complete'}),JSON.stringify({...sample,frames:{rendered:-1,encoded:0,total:600}}),JSON.stringify({...sample,frames:{rendered:601,encoded:0,total:600}}),JSON.stringify({...sample,recordedAt:'now'})]){
    await writeFile(join(f.render,'progress.json'),value);const result=await inspectRenderProgress(f.directory,manifest);
    assert.equal(result.state,'invalid');assert.equal(result.record,null);
  }
  await rm(f.render,{recursive:true});assert.equal((await inspectRenderProgress(f.directory,manifest)).state,'not-recorded');
});

test('inspection refuses redirected progress and strips unrelated fields from a valid record',async t=>{
  const f=await fixture(t),outside=join(f.directory,'outside.json');await writeFile(outside,JSON.stringify({...sample,frames:{...sample.frames,encoded:96},secret:'do not expose'}));
  await symlink(outside,join(f.render,'progress.json'));
  assert.equal((await inspectRenderProgress(f.directory,manifest)).state,'unsafe');
  await rm(join(f.render,'progress.json'));await writeFile(join(f.render,'progress.json'),await readFile(outside));
  assert.deepEqual((await inspectRenderProgress(f.directory,manifest)).record,sample);
  await rm(f.render,{recursive:true});await mkdir(join(f.directory,'other'));await symlink(join(f.directory,'other'),f.render);
  assert.equal((await inspectRenderProgress(f.directory,manifest)).state,'unsafe');
});

test('source preparation exposes selected frames separately from rendered film frames',async t=>{
  const f=await fixture(t),writer=createRenderProgressWriter(f.render);
  writer.record({phase:'staging-sources',source:{index:2,total:3,stagedFrames:11,selectedFrames:90}});await writer.flush();
  const record=(await inspectRenderProgress(f.directory,manifest)).record!;
  assert.deepEqual(record.source,{index:2,total:3,stagedFrames:11,selectedFrames:90});
  assert.equal(record.frames,undefined);
});

test('render watchdog counter advances with frames and phases but never observation timestamps',async t=>{
  const f=await fixture(t),destination=join(f.render,'progress.json');
  const save=async(record:RenderProgressRecord)=>{await writeFile(destination,JSON.stringify(record));return readRenderWorkCounter(f.render);};
  const initial=(await save(sample))!;
  assert.equal(await save({...sample,recordedAt:'2026-10-02T09:00:00.000Z'}),initial);
  const advanced=(await save({...sample,frames:{rendered:121,total:600}}))!;
  assert.ok(advanced>initial);
  assert.ok((await save({...sample,phase:'encoding',frames:{rendered:600,total:600}}))!>advanced);
  await writeFile(destination,'x'.repeat(4097));assert.equal(await readRenderWorkCounter(f.render),undefined);
});
