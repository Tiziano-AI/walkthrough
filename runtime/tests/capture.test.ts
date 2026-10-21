import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {analyzeTake,calibrationMarkers,decodeCalibrationFrames} from '../src/capture/take.ts';
import {resolveLocalTools} from '../src/core/toolchain.ts';

test('compressed opening black still anchors held white and return black slates',()=>{
  const pixels=new Uint8Array([0,255,0,80,0,255,0,0]);
  const pts=[0,0.066017,0.332667,0.599317,4.049117,4.315750,4.582400,4.849050];
  assert.deepEqual(calibrationMarkers(pixels,pts),[1,5]);
});

test('calibration excludes zero-PTS startup flushes without fitting the expected clock',()=>{
  const pixels=new Uint8Array([0,255,0,255,0,244,255,0,255,0,0]);
  const pts=[0,0,0,0.227167,0.560483,0.810483,65.723567,65.740217,65.9902,66.240183,66.490183];
  assert.deepEqual(calibrationMarkers(pixels,pts),[3,8]);
});
test('damage-driven held samples and repeated white and black frames qualify equally',()=>{
  assert.deepEqual(calibrationMarkers(new Uint8Array([0,0,255,255,0,0,80]),[0,0.05,0.066017,0.1,0.332667,0.4,0.599317]),[2]);
  assert.deepEqual(calibrationMarkers(new Uint8Array([0,255,0,80]),[0,0.066017,0.332667,0.599317]),[1]);
});
test('short white flash and unbounded terminal white are not authored slates',()=>{
  assert.deepEqual(calibrationMarkers(new Uint8Array([0,255,0,80]),[0,0.25,0.26,0.51]),[]);
  assert.deepEqual(calibrationMarkers(new Uint8Array([0,255]),[0,0.25]),[]);
});
test('short return black and an unbounded terminal black sample cannot qualify a held white',()=>{
  assert.deepEqual(calibrationMarkers(new Uint8Array([0,255,0,80]),[0,0.25,0.5,0.6]),[]);
  assert.deepEqual(calibrationMarkers(new Uint8Array([0,255,0]),[0,0.25,0.5]),[]);
  assert.deepEqual(calibrationMarkers(new Uint8Array([0,255,0,0]),[0,0.25,0.5,0.75]),[1]);
});
test('held white must return to black rather than directly revealing the product',()=>{
  assert.deepEqual(calibrationMarkers(new Uint8Array([0,255,80,0,0]),[0,0.25,0.5,0.75,1]),[]);
});

const {ffmpegPath,ffprobePath}=resolveLocalTools();
test('real decoding distinguishes a bright nonuniform application frame from the two calibration slates',{skip:![ffmpegPath,ffprobePath].every(existsSync)},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-clock-luminance-'));
  try{
    // Ten known frames surround a sparse bright application with the authored
    // black/white/black/gray covers. The small 100x100 subject on white has a
    // mean above the old white threshold, but is not a full-screen slate.
    execFileSync(ffmpegPath,['-v','error','-nostdin','-n','-f','lavfi','-i','color=c=white:s=3200x1800:r=4:d=2.5',
      '-vf',"drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='eq(n,0)+eq(n,2)+eq(n,5)+eq(n,7)',drawbox=x=0:y=0:w=iw:h=ih:color=0x777777:t=fill:enable='eq(n,3)+gte(n,8)',drawbox=x=0:y=0:w=100:h=100:color=black:t=fill:enable='eq(n,4)'",
      '-frames:v','10','-c:v','libx264','-preset','ultrafast','-crf','0','-pix_fmt','yuv420p',join(directory,'source.mp4')],{stdio:['ignore','pipe','pipe']});
    const samples=await decodeCalibrationFrames(ffmpegPath,join(directory,'source.mp4'),10);
    assert.ok(samples[4].mean>=253,'this sparse application reproduces the former scalar-mean false slate');
    assert.ok(samples[4].min<253,'the subject remains distinct in the spatial samples');
    for(const frame of [1,6])assert.ok(samples[frame].min>=253,'real white slates must remain white across the raster');
    for(const frame of [0,2,5,7])assert.ok(samples[frame].max<=5,'real black slates must remain black across the raster');
    await writeFile(join(directory,'capture-clock.json'),JSON.stringify({start:{beforeMs:245,afterMs:255},end:{beforeMs:1495,afterMs:1505}}));
    const map=await analyzeTake({nodePath:process.execPath,browserPath:'/unused',ffmpegPath,ffprobePath},directory);
    const analysis=JSON.parse(await readFile(join(directory,'capture-analysis.json'),'utf8'));
    assert.deepEqual(analysis.markerFrames,[1,6]);
    assert.equal(map.frameCount,10);
    assert.equal(map.offsetSeconds,0);
    assert.equal(map.driftSeconds,0);
    assert.deepEqual(map.usableRasterRange,{startSeconds:1,endSeconds:1.25});
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('capture acceptance rejects a third qualifying marker instead of choosing two to fit the clock',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-clock-acceptance-'));
  try{
    const pixels=[0,255,0,80,0,255,0,80,0,255,0,0];
    const pts=[0,0.25,0.5,0.75,2,2.25,2.5,2.75,4,4.25,4.5,4.75];
    assert.deepEqual(calibrationMarkers(new Uint8Array(pixels),pts),[1,5,9]);
    // Decoded frame samples are controlled here; real decoding and recording
    // are exercised by capture-page and the headed/headless journey tests.
    const toolPath=join(directory,'decoded-fixture.mjs');
    const probe={streams:[{width:3200,height:1800,duration:4.75}]};
    await writeFile(toolPath,`#!${process.execPath}\nprocess.stdout.write(process.argv.includes('-show_streams')?${JSON.stringify(JSON.stringify(probe))}:process.argv.includes('-show_entries')?${JSON.stringify(pts.map(pts=>`best_effort_timestamp_time=${pts}\n`).join(''))}:Buffer.concat(${JSON.stringify(pixels)}.map(value=>Buffer.alloc(32*18,value))));\n`,{mode:0o700});
    await writeFile(join(directory,'capture-clock.json'),JSON.stringify({start:{beforeMs:245,afterMs:255},end:{beforeMs:4245,afterMs:4255}}));
    await assert.rejects(analyzeTake({nodePath:process.execPath,browserPath:'/unused',ffmpegPath:toolPath,ffprobePath:toolPath},directory),(error:any)=>error.code==='CAPTURE_CLOCK_MARKER_AMBIGUOUS');
    const analysis=JSON.parse(await readFile(join(directory,'capture-analysis.json'),'utf8'));
    assert.deepEqual(analysis.markerFrames,[1,5,9],'failed qualification retains the actual ambiguous candidates for offline diagnosis');
    assert.equal(analysis.calibrationSamples.length,pts.length);
  }finally{await rm(directory,{recursive:true,force:true});}
});
