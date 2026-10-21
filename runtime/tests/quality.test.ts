import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {evaluateCameraFrames,measureCameraPair,qualifyTemporalVideo,summarizeSourceCadence} from '../src/core/quality.ts';
import {executeLocal} from '../src/render/media.ts';
import {captionOverlayBoxesAtFrame} from '../src/render/captions.ts';
import type {Timeline} from '../src/render/timeline.ts';
import {resolveLocalTools} from '../src/core/toolchain.ts';

const timeline:Timeline={sourceWidth:3200,sourceHeight:1800,sources:{source:{pointer:[]}},narration:[],segments:[{id:'synthetic',sourceId:'source',kind:'live',transition:'cut',sourceStartSeconds:0,sourceEndSeconds:1,outputStartSeconds:0,durationSeconds:1,zoom:1,target:null}]};
const texture=(offset=0)=>Uint8Array.from({length:320*180},(_,i)=>((Math.floor((i%320+offset)/3)+Math.floor(i/320/3))%2)*180+30);
const moving=()=>Array.from({length:10},(_,i)=>texture(i));
const frozen=()=>Array.from({length:10},()=>texture());

test('damage-driven cadence describes timestamps without an FPS verdict',()=>{
  const summary=summarizeSourceCadence([0,1/60,2/60,3/60,2,2+1/60]);
  assert.equal(summary.acceptance,'descriptive-only');assert.equal(summary.intervalBins.over100ms,1);
  assert.equal(summary.burstsOfAtLeastThreeFastIntervals,1);assert.equal(summary.maxConsecutiveFastIntervals,3);
  assert.throws(()=>summarizeSourceCadence([1,0]),/invalid_source/);
});
test('frozen output fails against changing source under a static camera',()=>{
  assert.equal(evaluateCameraFrames(timeline,frozen(),moving()).summary.status,'fail');
  assert.equal(evaluateCameraFrames(timeline,moving(),moving()).summary.status,'pass');
  const isolated=moving();isolated[3]=isolated[2];
  assert.equal(evaluateCameraFrames(timeline,isolated,moving()).summary.status,'pass');
});
test('motion below the retired caption area is included in freeze detection',()=>{
  const lowerMotion=moving().map(frame=>frame.map((value,index)=>index<320*150?0:value));
  const lowerFrozen=lowerMotion.map(()=>lowerMotion[0]);
  assert.equal(evaluateCameraFrames(timeline,lowerFrozen,lowerMotion).summary.status,'fail');
  assert.equal(evaluateCameraFrames(timeline,lowerMotion,lowerMotion).summary.status,'pass');
});
test('editorial camera movement cannot establish application movement',()=>{
  const movingCamera:Timeline={...timeline,segments:[{...timeline.segments[0],cameraMove:{startSeconds:0,durationSeconds:1,zoom:1.5,target:null}}]};
  // Output changes here, but the changing framing alone could explain all of it.
  const summary=evaluateCameraFrames(movingCamera,moving(),moving()).summary;
  assert.equal(summary.status,'not-assessed');
  assert.equal(summary.testedPairs,0);
  assert.equal(summary.changingCameraPairs,9);
  assert.equal(summary.assessmentScope,'static-framing-live-sample-pairs');
});
test('static live portions remain assessed after a camera move without claiming the move',()=>{
  const movingCamera:Timeline={...timeline,segments:[{...timeline.segments[0],cameraMove:{startSeconds:0,durationSeconds:.3,zoom:1.5,target:null}}]};
  const failure=evaluateCameraFrames(movingCamera,frozen(),moving()).summary;
  assert.equal(failure.status,'fail');assert.equal(failure.changingCameraPairs,3);assert.equal(failure.testedPairs,6);
  const pass=evaluateCameraFrames(movingCamera,moving(),moving()).summary;
  assert.equal(pass.status,'pass');assert.equal(pass.changingCameraPairs,3);assert.equal(pass.testedPairs,6);
});
test('changing visible captions mask both endpoints and cannot hide frozen product footage',()=>{
  const captions:Timeline={...timeline,narration:[{id:'voice',outputStartSeconds:0,durationSeconds:1,captions:[{text:'W'.repeat(64),startSeconds:0,endSeconds:1}]}],
    segments:Array.from({length:10},(_,i)=>({...timeline.segments[0],id:`part-${i}`,transition:i?'continuous':'cut',sourceStartSeconds:i/10,sourceEndSeconds:(i+1)/10,outputStartSeconds:i/10,durationSeconds:.1,captionPlacement:{x:0,y:i%2?360:0,width:1920}}))};
  const output=frozen().map((frame,sample)=>{
    for(const box of captionOverlayBoxesAtFrame(captions,sample*6))for(let y=Math.floor(box.y/6);y<Math.ceil((box.y+box.height)/6);y++)for(let x=Math.floor(box.x/6);x<Math.ceil((box.x+box.width)/6);x++)frame[y*320+x]=sample%2?70:220;
    return frame;
  });
  const result=evaluateCameraFrames(captions,output,moving());
  assert.equal(result.summary.status,'fail');assert.equal(result.summary.captionMaskedPairs,9);
  const both=measureCameraPair(captions,0,6,output[0],output[1],texture(),texture(1));
  const firstOnly=measureCameraPair(captions,0,0,output[0],output[1],texture(),texture(1));
  assert.ok(both.captionMaskedTiles>firstOnly.captionMaskedTiles,'moved captions mask their old and new positions');
  // This deliberately large moving overlay defeats unmasked output-pixel QA.
  assert.notEqual(evaluateCameraFrames(captions,output,moving(),'full-frame-subtitles').summary.status,'fail');
});
test('caption silence and historical external subtitles do not mask product pixels',()=>{
  const captioned:Timeline={...timeline,narration:[{id:'voice',outputStartSeconds:0,durationSeconds:1,captions:[{text:'A visible caption.',startSeconds:0,endSeconds:.2}]}]};
  assert.ok(measureCameraPair(captioned,0,6,texture(),texture(),texture(),texture(1)).captionMaskedTiles>0);
  assert.equal(measureCameraPair(captioned,30,36,texture(),texture(),texture(),texture(1)).captionMaskedTiles,0);
  assert.equal(measureCameraPair(captioned,0,6,texture(),texture(),texture(),texture(1),'full-frame-subtitles').captionMaskedTiles,0);
});
test('static or missing source and explicit holds never establish frozen live footage',()=>{
  assert.equal(evaluateCameraFrames(timeline,frozen(),frozen()).summary.status,'not-assessed');
  assert.equal(evaluateCameraFrames(timeline,frozen()).summary.status,'not-assessed');
  const hold:Timeline={...timeline,segments:[{...timeline.segments[0],kind:'hold',sourceEndSeconds:0}]};
  assert.equal(evaluateCameraFrames(hold,frozen(),moving()).summary.status,'not-assessed');
  const cut:Timeline={...timeline,sources:{...timeline.sources,other:{pointer:[]}},segments:[{...timeline.segments[0],durationSeconds:.5,sourceEndSeconds:.5},{...timeline.segments[0],id:'other',sourceId:'other',outputStartSeconds:.5,durationSeconds:.5,sourceEndSeconds:.5}]};
  assert.equal(measureCameraPair(cut,24,30,texture(),texture(),texture(),texture(1)).tested,false);
});
test('missing samples cannot produce acceptance',()=>{
  assert.throws(()=>evaluateCameraFrames(timeline,[texture()]),/frame_count_mismatch/);
  assert.throws(()=>evaluateCameraFrames(timeline,frozen(),[texture()]),/source_frame_count_mismatch/);
});

test('temporal QA reads native source timestamps without changing final delivery reads',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-quality-native-input-'));
  try{
    const toolPath=join(directory,'media-tool.mjs');
    await writeFile(toolPath,`#!${process.execPath}
      import assert from 'node:assert/strict';
      import {appendFileSync,writeFileSync} from 'node:fs';
      const args=process.argv.slice(2),probe=args.includes('-show_entries');
      const input=probe?args.at(-1):args[args.indexOf('-i')+1];
      assert.ok(input==='source.mp4'||input==='final.mp4');
      if(input==='source.mp4'){
        assert.equal(args[args.indexOf('-fflags')+1],'+nofillin');
        assert.ok(args.indexOf('-fflags')+1<(probe?args.length-1:args.indexOf('-i')),'native timestamp policy precedes the source input');
      }else assert.equal(args.includes('-fflags'),false,'final delivery clock reads are unchanged');
      appendFileSync(new URL('calls.jsonl',import.meta.url),JSON.stringify({input,probe})+'\\n');
      if(probe)process.stdout.write(JSON.stringify(input==='source.mp4'?{frames:[{best_effort_timestamp_time:'0.000000'},{best_effort_timestamp_time:'0.000000'},{best_effort_timestamp_time:'1.000000'}]}:{streams:[{width:1920,height:1080,avg_frame_rate:'60/1',nb_frames:'60'}]}));
      else writeFileSync(args.at(-1),Buffer.alloc(10*320*180,80));
    `,{mode:0o700});
    const result=await qualifyTemporalVideo({finalMP4:'final.mp4',sourceMP4s:{source:'source.mp4'},timeline,ffmpegPath:toolPath,ffprobePath:toolPath,directory:join(directory,'qa')});
    assert.equal(result.sourceCadence.source.intervalBins.nonpositive,1,'equal native timestamps remain cadence evidence');
    const calls=(await readFile(join(directory,'calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(calls,[{input:'source.mp4',probe:true},{input:'final.mp4',probe:true},{input:'final.mp4',probe:false},{input:'source.mp4',probe:false}]);
  }finally{await rm(directory,{recursive:true,force:true});}
});

const {ffmpegPath:ffmpeg,ffprobePath:ffprobe}=resolveLocalTools();
test('reference sampling retains the prior VFR state until its actual timestamp',{skip:!existsSync(ffmpeg)||!existsSync(ffprobe),timeout:120000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-quality-causal-'));
  const source=join(directory,'source.mp4'),output=join(directory,'output.mp4');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','color=c=red:s=3200x1800:r=60',
    '-vf',"drawbox=color=lime:t=fill:enable='gte(n,1)',settb=1/60000,setpts='if(eq(N,0),0,if(eq(N,1),12060,if(eq(N,2),24060,if(eq(N,3),48060,60060))))'",
    '-frames:v','5','-fps_mode','passthrough','-enc_time_base','1:60000','-c:v','libx264','-preset','ultrafast','-qp','0','-bf','0','-video_track_timescale','60000',source],join(directory,'source.log'),120000);
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',source,'-vf','fps=60:round=up,scale=1920:1080','-frames:v','60','-c:v','libx264','-preset','ultrafast','-crf','18',output],join(directory,'output.log'),120000);
  const qaDirectory=join(directory,'qa');
  const result=await qualifyTemporalVideo({finalMP4:output,sourceMP4s:{source},timeline,ffmpegPath:ffmpeg,ffprobePath:ffprobe,directory:qaDirectory});
  const reference=await readFile(join(qaDirectory,'source-0-samples.gray'));
  const pixel=(sample:number)=>reference[sample*320*180+90*320+160];
  assert.equal(pixel(2),pixel(0),'at .200 seconds the red state is still presented; green begins at .201');
  assert.ok(pixel(3)>pixel(2)+50,'the later .300-second sample must contain the observed green state');
  assert.equal(result.sourceCadence.source.samples,5,'cadence must describe original VFR samples, not the 60 Hz derivative');
});

test('real decoding selects each live source and excludes editorial holds',{skip:!existsSync(ffmpeg)||!existsSync(ffprobe),timeout:120000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-quality-'));
  const source=join(directory,'source.mp4'),output=join(directory,'frozen.mp4'),movingOutput=join(directory,'moving.mp4');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=3200x1800:rate=60:duration=1','-frames:v','60','-c:v','libx264','-preset','ultrafast','-crf','18',source],join(directory,'source.log'),120000);
  const framing='scale=1920:1080';
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',source,'-vf',`${framing},loop=loop=-1:size=1:start=0`,'-frames:v','60','-c:v','libx264','-preset','ultrafast','-crf','18',output],join(directory,'frozen.log'),120000);
  const result=await qualifyTemporalVideo({finalMP4:output,sourceMP4s:{source},timeline,ffmpegPath:ffmpeg,ffprobePath:ffprobe,directory:join(directory,'qa')});
  assert.equal(result.sourceCadence.source.samples,60);
  assert.equal(result.frozenCamera.status,'fail');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',source,'-vf',framing,'-frames:v','60','-c:v','libx264','-preset','ultrafast','-crf','18',movingOutput],join(directory,'moving.log'),120000);
  const movingResult=await qualifyTemporalVideo({finalMP4:movingOutput,sourceMP4s:{source},timeline,ffmpegPath:ffmpeg,ffprobePath:ffprobe,directory:join(directory,'moving-qa')});
  assert.equal(movingResult.frozenCamera.status,'pass','full-frame live motion matches its source rather than masking a crop mismatch');
});

test('real decoding supports odd-height editorial crops without subsampled padding errors',{skip:!existsSync(ffmpeg)||!existsSync(ffprobe),timeout:120000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-quality-odd-crop-'));
  const source=join(directory,'source.mp4');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=3200x1800:rate=60:duration=1','-frames:v','60','-c:v','libx264','-preset','ultrafast','-crf','18',source],join(directory,'source.log'),120000);
  const cropped:Timeline={...timeline,segments:[{...timeline.segments[0],zoom:1.025,target:{x:100,y:900,width:3000,height:900}}]};
  // Hand-computed framing: .615 scale, x=-24, y=-27. Crop before encoding
  // supplies an independent output fixture instead of repeating the QA filter.
  const framing='format=rgb24,scale=1968:1107,crop=1920:1080:24:27,format=yuv420p';
  for(const frozenOutput of [false,true]){
    const label=frozenOutput?'frozen':'moving',output=join(directory,`${label}.mp4`);
    await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',source,'-vf',framing+(frozenOutput?',loop=loop=-1:size=1:start=0':''),'-frames:v','60','-c:v','libx264','-preset','ultrafast','-crf','18',output],join(directory,`${label}.log`),120000);
    const result=await qualifyTemporalVideo({finalMP4:output,sourceMP4s:{source},timeline:cropped,ffmpegPath:ffmpeg,ffprobePath:ffprobe,directory:join(directory,`${label}-qa`)});
    assert.equal(result.frozenCamera.status,frozenOutput?'fail':'pass');
  }
});

test('real decoding uses the settled post-move crop and leaves camera movement unassessed',{skip:!existsSync(ffmpeg)||!existsSync(ffprobe),timeout:120000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-quality-post-camera-'));
  const source=join(directory,'source.mp4');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=3200x1800:rate=60:duration=1','-frames:v','60','-c:v','libx264','-preset','ultrafast','-crf','18',source],join(directory,'source.log'),120000);
  const camera:Timeline={...timeline,segments:[{...timeline.segments[0],cameraMove:{startSeconds:0,durationSeconds:.3,zoom:1.5,target:null}}]};
  // This fixture only supplies the final static framing. The declared moving
  // portion intentionally carries no QA claim; an encode cannot be qualified
  // there by output-pixel differences alone. The settled crop is hand-computed.
  for(const frozenOutput of [false,true]){
    const label=frozenOutput?'frozen':'moving',output=join(directory,`${label}.mp4`),qa=join(directory,`${label}-qa`);
    await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',source,'-vf','format=rgb24,scale=2880:1620,crop=1920:1080:480:270,format=yuv420p'+(frozenOutput?',loop=loop=-1:size=1:start=0':''),'-frames:v','60','-c:v','libx264','-preset','ultrafast','-crf','18',output],join(directory,`${label}.log`),120000);
    const result=await qualifyTemporalVideo({finalMP4:output,sourceMP4s:{source},timeline:camera,ffmpegPath:ffmpeg,ffprobePath:ffprobe,directory:qa});
    assert.equal(result.frozenCamera.status,frozenOutput?'fail':'pass');
    assert.equal(result.frozenCamera.changingCameraPairs,3);
    assert.equal(result.frozenCamera.testedPairs,6);
    if(!frozenOutput){
      const reference=await readFile(join(qa,'source-0-samples.gray')),outputFrames=await readFile(join(qa,'camera-samples.gray'));
      assert.equal(reference.length,7*320*180,'moving-camera samples are not decoded as if they used a fixed initial crop');
      const difference=reference.reduce((sum,value,index)=>sum+Math.abs(value-outputFrames[3*320*180+index]),0)/reference.length;
      assert.ok(difference<2,'the reference uses the independently encoded final framing, not the initial segment framing');
    }
  }
});
