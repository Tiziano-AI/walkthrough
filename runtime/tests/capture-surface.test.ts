import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwright';
import {startRecordingOnSession,type RecordingSession} from '../src/capture/chromium.ts';
import {asCaptureSurface,installSlateCover,pageCaptureSurface,type CaptureSurface} from '../src/capture/surface.ts';
import {beginTake} from '../src/capture/take.ts';
import {createSessionCapture} from '../src/project/capture.ts';
import {createProject} from '../src/project/store.ts';

const tools={nodePath:process.execPath,browserPath:'/unused',ffmpegPath:'/unused',ffprobePath:'/unused'};

test('a target-scoped recording session retains its own stream and detaches once',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-scoped-recording-'));
  const commands:Array<{name:string;params?:unknown}>=[];
  const session={
    async send(name:string,params?:unknown){
      commands.push({name,params});
      if(name==='Page.startScreenRecording')return {stream:'initial-target-stream'};
      if(name==='Page.stopScreenRecording')return {stream:'final-target-stream'};
      if(name==='IO.read')return {data:Buffer.from('native stream bytes').toString('base64'),base64Encoded:true,eof:true};
      return {};
    },
    async detach(){commands.push({name:'detach'});},
  } as RecordingSession;
  try{
    const destination=join(directory,'source.mp4'),recording=await startRecordingOnSession(session,destination);
    const timing=await recording.stop();
    assert.equal(timing.destination,destination);
    assert.equal(await readFile(destination,'utf8'),'native stream bytes');
    assert.deepEqual(commands,[
      {name:'Page.startScreenRecording',params:{audio:false,maxWidth:3200,maxHeight:1800,frameRate:60}},
      {name:'Page.stopScreenRecording',params:undefined},
      {name:'IO.read',params:{handle:'final-target-stream',size:1024*1024}},
      {name:'IO.close',params:{handle:'final-target-stream'}},
      {name:'detach'},
    ]);
    await assert.rejects(recording.stop(),/Recording already stopped/);
    assert.equal(commands.length,5);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('the Page surface retains native screenshot options and idempotent slate removal',async()=>{
  const colors:string[]=[];let removals=0,disposals=0;
  const raster=Buffer.from('native raster');
  const overlay={async color(value:string){colors.push(value);},remove(){removals++;}};
  const page={
    async evaluateHandle(callback:unknown){
      assert.equal(callback,installSlateCover);
      return {
        async evaluate(callback:(value:typeof overlay,arg?:string)=>unknown,arg?:string){return callback(overlay,arg);},
        async dispose(){disposals++;},
      };
    },
    async screenshot(options:unknown){assert.deepEqual(options,{animations:'allow',caret:'initial',scale:'device'});return raster;},
  } as unknown as Page;
  const surface=pageCaptureSurface(page);
  assert.equal(asCaptureSurface(surface),surface);
  assert.equal(await surface.screenshot(),raster);
  const cover=await surface.cover();await cover.color('#fff');await cover.remove();await cover.remove();
  assert.deepEqual(colors,['#fff']);assert.equal(removals,1);assert.equal(disposals,1);
});

function surfaceFixture(){
  const calls:string[]=[];let covers=0,screenshots=0;
  const closingError=new Error('target closing slate unavailable');
  const surface:CaptureSurface={
    async cover(){
      if(++covers===2)throw closingError;
      calls.push('cover');let removed=false;
      return {
        async color(value){calls.push(value);},
        async remove(){if(!removed){removed=true;calls.push('remove');}},
      };
    },
    async startRecording(destination){
      calls.push('start');
      return {
        clock:'node-performance-ms',requestedStartIntervalMs:[0,0],
        async stop(){calls.push('stop');await writeFile(destination,'retained target bytes');return {destination,requestedStartIntervalMs:[0,0],requestedStopIntervalMs:[1,1]};},
      };
    },
    async screenshot(){screenshots++;return Buffer.from('unchanged native raster');},
  };
  return {surface,calls,closingError,screenshots:()=>screenshots};
}

test('a non-Page surface follows the same cover and single-stop custody',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-surface-take-')),f=surfaceFixture();
  try{
    const take=await beginTake(f.surface,tools,directory);
    assert.deepEqual(f.calls,['cover','start','#fff','#000','#777','remove']);
    await assert.rejects(take.finish(),error=>error===f.closingError);
    await take.abort();await take.abort();
    assert.equal(f.calls.filter(call=>call==='stop').length,1);
    assert.equal(await readFile(take.sourcePath,'utf8'),'retained target bytes');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('session capture uses surface screenshots for settlement and keeps geometry and failed-stop truth',async()=>{
  const root=await mkdtemp(join(tmpdir(),'walkthrough-surface-project-')),f=surfaceFixture();
  const {directory:projectPath}=await createProject(join(root,'project'),{
    title:'Capture surface test',brief:'Exercise the capture adapter without a browser.',audience:'Test',
    mandate:{applicationUrl:'http://127.0.0.1/',navigationOrigins:['http://127.0.0.1'],network:'loopback-only',allowedEffects:'No browser actions.',dataDescription:'Synthetic unit-test bytes',inputRoots:[],mediaReview:'agent-reviewable-synthetic',delivery:'local'},
  });
  const capture=createSessionCapture({projectPath,sessionId:'surface-session',page:f.surface,pageId:'native-target',tools,events:[]});
  try{
    await capture.start();let verified=0;
    const mark=await capture.mark({id:'settled',title:'Settled target',settled:true,verifyTarget:async()=>{verified++;}});
    assert.equal(mark.settled,true);assert.equal(f.screenshots(),4);assert.equal(verified,1);
    await assert.rejects(capture.mark({title:'Outside viewport',target:{x:1599,y:0,width:2,height:1}}),(error:any)=>error.code==='MARK_TARGET_INVALID');
    await assert.rejects(capture.stop(),error=>error===f.closingError);
    const take=await capture.stop();
    assert.equal(take.state,'failed');assert.equal(take.pageId,'native-target');assert.equal(take.source,undefined);
    assert.equal(f.calls.filter(call=>call==='stop').length,1);
    const retained=JSON.parse(await readFile(join(projectPath,'takes',take.id,'raw-marks.json'),'utf8'));
    assert.deepEqual(retained.map((value:{id:string})=>value.id),['settled']);
  }finally{await capture.stop().catch(()=>{});await rm(root,{recursive:true,force:true});}
});
