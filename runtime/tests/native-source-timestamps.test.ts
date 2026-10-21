import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {analyzeTake} from '../src/capture/take.ts';
import {summarizeSourceCadence} from '../src/core/quality.ts';
import {resolveLocalTools} from '../src/core/toolchain.ts';

const {ffmpegPath,ffprobePath}=resolveLocalTools();

test('native zero-duration fMP4 startup samples survive analysis without FFmpeg timestamp fill-in',{skip:![ffmpegPath,ffprobePath].every(existsSync)},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-native-timestamps-'));
  try{
    const sourcePath=join(directory,'source.mp4');
    // Purely synthetic opaque rasters: four zero-duration flush samples,
    // followed by two held calibration slates and a distinguishable gray subject.
    // Vary encoder durations to force a per-sample-duration trun, then set the
    // intended native clock explicitly. No browser or retained footage is used.
    execFileSync(ffmpegPath,['-v','error','-nostdin','-n','-f','lavfi','-i','color=c=black:s=3200x1800:r=60',
      '-vf',"drawbox=color=white:t=fill:enable='eq(n,1)+eq(n,3)+eq(n,6)+eq(n,12)',drawbox=color=0x777777:t=fill:enable='eq(n,8)+eq(n,14)',drawbox=color=0x505050:t=fill:enable='eq(n,9)+eq(n,10)',settb=1/60000,setpts=N*(N+1)*500",
      '-frames:v','15','-fps_mode','passthrough','-enc_time_base','1:60000','-c:v','libx264','-preset','ultrafast','-qp','0','-bf','0',
      '-video_track_timescale','60000','-movflags','empty_moov+frag_keyframe+default_base_moof',sourcePath],{stdio:['ignore','pipe','pipe']});
    const bytes=await readFile(sourcePath);
    const trun=bytes.indexOf(Buffer.from('trun'));
    assert.ok(trun>0);
    assert.equal(bytes.indexOf(Buffer.from('trun'),trun+4),-1,'the synthetic fixture has exactly one fragment run');
    assert.equal(bytes.readUInt32BE(trun+4),0x305,'version 0; data offset, first-sample flags, durations and sizes');
    assert.equal(bytes.readUInt32BE(trun+8),15);
    const durations=[0,0,0,0,629,...Array(10).fill(15000)];
    durations.forEach((duration,i)=>bytes.writeUInt32BE(duration,trun+20+i*8));
    await writeFile(sourcePath,bytes);
    const probe=(args:string[])=>JSON.parse(execFileSync(ffprobePath,['-v','error',...args,'-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',sourcePath],{encoding:'utf8'})).frames.map((frame:{best_effort_timestamp_time:string})=>frame.best_effort_timestamp_time);
    const inferred=probe([]);
    assert.deepEqual(inferred.slice(0,6),['0.000000','0.010483','0.020967','0.031450','0.000000','0.010483'],'default demux fill-in must reproduce the false backwards transition');
    assert.throws(()=>summarizeSourceCadence(inferred.map(Number)),/invalid_source_timestamps/);
    const native=probe(['-fflags','+nofillin']);
    const expected=['0.000000','0.000000','0.000000','0.000000','0.000000','0.010483','0.260483','0.510483','0.760483','1.010483','1.260483','1.510483','1.760483','2.010483','2.260483'];
    assert.deepEqual(native,expected,'native PTS are the hand-specified cumulative trun durations at 1/60000');
    assert.equal(summarizeSourceCadence(native.map(Number)).intervalBins.nonpositive,4);
    await writeFile(join(directory,'capture-clock.json'),JSON.stringify({start:{beforeMs:260.483,afterMs:260.483},end:{beforeMs:1760.483,afterMs:1760.483}}));
    const map=await analyzeTake({nodePath:process.execPath,browserPath:'/unused',ffmpegPath,ffprobePath},directory);
    assert.equal(map.frameCount,15);
    assert.ok(map.driftSeconds<1e-9);
    assert.deepEqual(map.usableRasterRange,{startSeconds:1.010483,endSeconds:1.510483});
    const analysis=JSON.parse(await readFile(join(directory,'capture-analysis.json'),'utf8'));
    assert.deepEqual(analysis.probe.frames.map((frame:{best_effort_timestamp_time:string})=>frame.best_effort_timestamp_time),expected);
    assert.deepEqual(analysis.markerFrames,[6,12],'zero-duration white flushes cannot substitute for held authored slates');
    assert.deepEqual(await readFile(sourcePath),bytes,'analysis never rewrites the original source clock or media');
  }finally{await rm(directory,{recursive:true,force:true});}
});
