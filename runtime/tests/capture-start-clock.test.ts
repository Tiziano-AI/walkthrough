import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {performance} from 'node:perf_hooks';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beginTake} from '../src/capture/take.ts';
import type {CaptureSurface} from '../src/capture/surface.ts';
import {Failure} from '../src/core/contracts.ts';
import {createSessionCapture} from '../src/project/capture.ts';
import {createProject} from '../src/project/store.ts';

const tools={nodePath:process.execPath,browserPath:'/unused',ffmpegPath:'/unused',ffprobePath:'/unused'};

function fixture(t:TestContext,widthMs:number,stopError?:Error){
  let now=0;
  t.mock.method(performance,'now',()=>now);
  const events:string[]=[];
  const surface:CaptureSurface={
    async cover(){
      events.push('cover');let removed=false;
      return {
        async color(value){events.push(value);if(value==='#fff')now=widthMs;},
        async remove(){if(!removed){removed=true;events.push('remove');}},
      };
    },
    async startRecording(destination){
      events.push('start');
      return {
        clock:'node-performance-ms',requestedStartIntervalMs:[0,0],
        async stop(){
          events.push('stop');
          if(stopError)throw stopError;
          await writeFile(destination,'retained synthetic recording bytes');
          return {destination,requestedStartIntervalMs:[0,0],requestedStopIntervalMs:[widthMs+1,widthMs+2]};
        },
      };
    },
    async screenshot(){assert.fail('opening calibration must not request a screenshot');},
  };
  return {surface,events};
}

for(const widthMs of [66.666,200/3])test(`opening paint bracket ${widthMs} ms still permits a take`,async t=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-start-clock-')),f=fixture(t,widthMs);
  try{
    const take=await beginTake(f.surface,tools,directory);
    assert.equal(f.events.includes('remove'),true);
    assert.equal(f.events.includes('stop'),false,'an admissible start is not rejected');
    assert.deepEqual(await readdir(directory),[],'successful startup needs no failure diagnostic');
    await take.abort();
    assert.equal(f.events.filter(event=>event==='stop').length,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});

for(const [widthMs,minimumUncertaintySeconds] of [[66.6668,0.05000006666666666],[146.340750,0.08983704166666667]])test(`opening paint bracket ${widthMs} ms rejects before product capture and retains evidence`,async t=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-start-clock-')),f=fixture(t,widthMs);
  try{
    await assert.rejects(beginTake(f.surface,tools,directory),(error:unknown)=>error instanceof Failure&&error.code==='CAPTURE_CLOCK_UNCERTAIN');
    assert.equal(f.events.filter(event=>event==='start').length,1,'no automatic retry');
    assert.equal(f.events.filter(event=>event==='stop').length,1);
    assert.ok(f.events.indexOf('stop')<f.events.indexOf('remove'),'the cover remains until recorder settlement');
    assert.equal(await readFile(join(directory,'source.mp4'),'utf8'),'retained synthetic recording bytes');
    assert.deepEqual((await readdir(directory)).sort(),['capture-start-failure.json','source.mp4'],'no invented ending anchor, accepted map or analysis');
    const diagnostic=JSON.parse(await readFile(join(directory,'capture-start-failure.json'),'utf8'));
    assert.deepEqual(diagnostic.start,{beforeMs:0,afterMs:widthMs});
    assert.ok(Math.abs(diagnostic.minimumUncertaintySeconds-minimumUncertaintySeconds)<1e-12);
    assert.equal(diagnostic.maximumUncertaintySeconds,0.05);
    assert.equal(diagnostic.recorderSettlement,'stopped');
    assert.deepEqual(diagnostic.timing,{destination:join(directory,'source.mp4'),requestedStartIntervalMs:[0,0],requestedStopIntervalMs:[widthMs+1,widthMs+2]});
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('rejected opening clock retains its bracket and cover when recorder stop is uncertain',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-start-clock-')),stopError=new Error('stop outcome unknown'),f=fixture(t,100,stopError);
  try{
    await assert.rejects(beginTake(f.surface,tools,directory),(error:unknown)=>error instanceof AggregateError&&error.message==='CAPTURE_CLEANUP_FAILED'&&error.errors[0] instanceof Failure&&error.errors[0].code==='CAPTURE_CLOCK_UNCERTAIN'&&error.errors[1]===stopError);
    assert.equal(f.events.filter(event=>event==='stop').length,1);
    assert.equal(f.events.includes('remove'),false,'an uncertain stop must not uncover the application');
    const diagnostic=JSON.parse(await readFile(join(directory,'capture-start-failure.json'),'utf8'));
    assert.deepEqual(diagnostic.start,{beforeMs:0,afterMs:100});
    assert.equal(diagnostic.recorderSettlement,'uncertain');
    assert.deepEqual(diagnostic.timing,{requestedStartIntervalMs:[0,0]},'do not invent a completed stop interval');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('failed rejection diagnostics do not skip recorder settlement or erase the clock failure',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-start-clock-')),f=fixture(t,100);
  await mkdir(join(directory,'capture-start-failure.json'));
  try{
    await assert.rejects(beginTake(f.surface,tools,directory),(error:unknown)=>error instanceof AggregateError&&error.message==='CAPTURE_CLEANUP_FAILED'&&error.errors[0] instanceof Failure&&error.errors[0].code==='CAPTURE_CLOCK_UNCERTAIN');
    assert.equal(f.events.filter(event=>event==='stop').length,1);
    assert.ok(f.events.indexOf('stop')<f.events.indexOf('remove'));
    assert.equal(await readFile(join(directory,'source.mp4'),'utf8'),'retained synthetic recording bytes');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('session startup persists the specific clock rejection and remains idle',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-start-clock-')),f=fixture(t,100);
  const {directory:projectPath}=await createProject(join(directory,'project'),{
    title:'Rejected opening clock',brief:'Exercise start rejection without a browser.',audience:'Test',
    mandate:{applicationUrl:'http://127.0.0.1/',navigationOrigins:['http://127.0.0.1'],network:'loopback-only',allowedEffects:'No browser actions.',dataDescription:'Synthetic unit-test bytes',inputRoots:[],mediaReview:'agent-reviewable-synthetic',delivery:'local'},
  });
  const capture=createSessionCapture({projectPath,sessionId:'clock-session',page:f.surface,pageId:'clock-page',tools,events:[]});
  try{
    let failure:Failure|undefined;
    await assert.rejects(capture.start(),(error:unknown)=>{if(error instanceof Failure){failure=error;return error.code==='CAPTURE_CLOCK_UNCERTAIN';}return false;});
    const status=capture.inspect();
    assert.equal(status.state,'idle');assert.equal(status.take?.state,'failed');
    assert.equal(status.take?.source,undefined);
    const record=JSON.parse(await readFile(join(projectPath,'takes',status.take!.id,'take.json'),'utf8'));
    assert.deepEqual(record.error,{code:'CAPTURE_CLOCK_UNCERTAIN',recovery:failure!.recovery});
    assert.equal(f.events.filter(event=>event==='stop').length,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});
