import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { executeLocal, probeMedia } from "../src/render/media.ts";
import { stageRenderSource } from "../src/render/source-staging.ts";
import { resolveLocalTools } from "../src/core/toolchain.ts";

const {ffmpegPath:ffmpeg,ffprobePath:ffprobe} = resolveLocalTools();
const available = [ffmpeg,ffprobe].every(existsSync);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const require = createRequire(import.meta.url);
const oneWindow = (sourceStartFrame: number, frameCount: number) => [{sourceStartFrame,frameCount,stagedStartFrame:0}];

async function fixture(directory: string, start = 0, pixelFormat = "yuv420p", range = "tv", lateTransition = 25020) {
  const sourcePath = join(directory,"vfr.mp4");
  // Independent, deliberately off-grid transitions: red -> green -> blue ->
  // black calibration. Blue is still presented at 25/60, before black at .417.
  const stamps = [0,2460,7860,lateTransition,lateTransition+6000].map(value => value + start * 60000);
  const pts = `if(eq(N,0),${stamps[0]},if(eq(N,1),${stamps[1]},if(eq(N,2),${stamps[2]},if(eq(N,3),${stamps[3]},${stamps[4]}))))`;
  await executeLocal(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-n","-copyts","-f","lavfi","-i","color=c=red:s=128x72:r=60",
    "-vf",`drawbox=color=lime:t=fill:enable='eq(n,1)',drawbox=color=blue:t=fill:enable='eq(n,2)',drawbox=color=black:t=fill:enable='gte(n,3)',settb=1/60000,setpts='${pts}'`,
    "-frames:v","5","-fps_mode","passthrough","-enc_time_base","1:60000","-c:v","libx264","-preset","ultrafast","-qp","0","-bf","0",
    "-pix_fmt",pixelFormat,"-color_range",range,"-colorspace","bt709","-color_primaries","bt709","-color_trc","iec61966-2-1",
    "-video_track_timescale","60000","-movie_timescale","60000","-avoid_negative_ts","disabled",sourcePath],join(directory,"fixture.log"));
  return sourcePath;
}

function decodedFrames(file: string) {
  // '+' preserves each decoder's native pixel representation, including range.
  const bytes = execFileSync(ffmpeg,["-v","error","-i",file,"-map","0:v:0","-fps_mode","passthrough","-pix_fmt","+","-f","rawvideo","pipe:1"],{maxBuffer:8*1024*1024});
  return bytes;
}

function frameTimes(file: string): number[] {
  return JSON.parse(execFileSync(ffprobe,["-v","error","-select_streams","v:0","-show_frames","-show_entries","frame=best_effort_timestamp_time","-of","json",file],{encoding:"utf8"})).frames.map((frame:{best_effort_timestamp_time:string})=>Number(frame.best_effort_timestamp_time));
}

async function stage(directory: string, sourcePath: string, sourceStartFrame = 0, frameCount = 33) {
  const outputPath = join(directory,"staged.mp4");
  const metadata = await stageRenderSource({sourcePath,outputPath,logPath:join(directory,"stage.log"),ffmpegPath:ffmpeg,ffprobePath:ffprobe,windows:oneWindow(sourceStartFrame,frameCount),frameCount});
  return {outputPath,metadata};
}

for (const [pixelFormat,range] of [["yuv420p","tv"],["yuv444p","pc"]]) {
  test(`render staging holds VFR samples causally and losslessly (${pixelFormat}, ${range})`,{skip:!available,timeout:60000},async()=>{
    const directory = await mkdtemp(join(tmpdir(),"walkthrough-source-staging-"));
    const sourcePath = await fixture(directory,0,pixelFormat,range);
    const original = await readFile(sourcePath);
    const {outputPath,metadata} = await stage(directory,sourcePath);
    assert.deepEqual(await readFile(sourcePath),original,"sealed source remains unchanged");
    assert.equal(metadata.sourceSha256,sha256(original));
    assert.equal(metadata.stagedSha256,sha256(await readFile(outputPath)));
    assert.equal(metadata.sourceCadenceAcceptance,"owned-by-capture-qualification");
    assert.equal(metadata.color.color_range,range);
    const sourcePixels = decodedFrames(sourcePath), stagedPixels = decodedFrames(outputPath);
    const frameBytes = 128*72*(pixelFormat === "yuv420p" ? 1.5 : 3);
    assert.equal(sourcePixels.length,frameBytes*5);
    const times = frameTimes(outputPath);
    assert.equal(stagedPixels.length,times.length*frameBytes);
    const transitions = [0,.041,.131,.417,.517];
    for (const [index,time] of times.entries()) {
      assert.ok(Math.abs(time-index/60)<.000001,"60 Hz grid stays on the original timestamp origin");
      const expected = transitions.findLastIndex(boundary=>boundary<=index/60);
      assert.ok(stagedPixels.subarray(index*frameBytes,(index+1)*frameBytes).equals(sourcePixels.subarray(expected*frameBytes,(expected+1)*frameBytes)),`output frame ${index} must hold the latest source sample, without interpolation or future state`);
    }
    // These boundaries distinguish ceil (causal) from nearest/floor rounding.
    assert.ok(stagedPixels.subarray(2*frameBytes,3*frameBytes).equals(sourcePixels.subarray(0,frameBytes)),"state before a .041 click cannot show its successor");
    assert.ok(stagedPixels.subarray(25*frameBytes,26*frameBytes).equals(sourcePixels.subarray(2*frameBytes,3*frameBytes)),"final product hold cannot show future black calibration");
    const unchanged = await readFile(outputPath);
    await assert.rejects(stageRenderSource({sourcePath,outputPath,logPath:join(directory,"no-overwrite.log"),ffmpegPath:ffmpeg,ffprobePath:ffprobe,windows:oneWindow(0,33),frameCount:33}),/render:source_staging_output_exists/);
    assert.deepEqual(await readFile(outputPath),unchanged,"an existing derivative is not overwritten");
  });
}

test("render staging selects absolute frames with a nonzero timestamp origin, then rebases",{skip:!available,timeout:60000},async()=>{
  const directory = await mkdtemp(join(tmpdir(),"walkthrough-source-origin-"));
  const sourcePath = await fixture(directory,.2);
  const {outputPath,metadata} = await stage(directory,sourcePath,12);
  assert.equal(metadata.sourceStartSeconds,.2);
  assert.deepEqual(metadata.windows,oneWindow(12,33));
  assert.equal(metadata.stagedStartSeconds,0);
  assert.equal(frameTimes(outputPath)[0],0,"only the derivative is explicitly rebased");
  const boundedPath=join(directory,'bounded.mp4'),frameBytes=128*72*1.5;
  await stageRenderSource({sourcePath,outputPath:boundedPath,logPath:join(directory,'bounded.log'),ffmpegPath:ffmpeg,ffprobePath:ffprobe,windows:oneWindow(20,18),frameCount:18});
  assert.ok(decodedFrames(boundedPath).equals(decodedFrames(outputPath).subarray(8*frameBytes,26*frameBytes)),"absolute window is independent of the first decoded frame's origin");
});

test("a distant window decodes its long-held predecessor without inventing a new origin",{skip:!available,timeout:60000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"walkthrough-source-long-hold-"));
  const sourcePath=await fixture(directory,0,'yuv420p','tv',600020);
  const outputPath=join(directory,'bounded.mp4'),frameBytes=128*72*1.5;
  const metadata=await stageRenderSource({sourcePath,outputPath,logPath:join(directory,'bounded.log'),ffmpegPath:ffmpeg,ffprobePath:ffprobe,windows:oneWindow(595,7),frameCount:7});
  const sourcePixels=decodedFrames(sourcePath),boundedPixels=decodedFrames(outputPath);
  assert.equal(metadata.frameCount,7);
  for(let index=0;index<7;index++){
    const expected=index<6?2:3;
    assert.ok(boundedPixels.subarray(index*frameBytes,(index+1)*frameBytes).equals(sourcePixels.subarray(expected*frameBytes,(expected+1)*frameBytes)),`window frame ${index} holds the original causal sample`);
  }
});

test("bounded staging selects the original grid before rebasing, including a held predecessor",{skip:!available,timeout:60000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"walkthrough-source-window-"));
  const sourcePath=await fixture(directory);
  const {outputPath:fullPath}=await stage(directory,sourcePath);
  const fullPixels=decodedFrames(fullPath),frameBytes=128*72*1.5;
  for(const [sourceStartFrame,frameCount] of [[2,7],[20,5],[25,2],[32,1]]){
    const outputPath=join(directory,`bounded-${sourceStartFrame}.mp4`);
    const metadata=await stageRenderSource({sourcePath,outputPath,logPath:join(directory,`bounded-${sourceStartFrame}.log`),ffmpegPath:ffmpeg,ffprobePath:ffprobe,windows:oneWindow(sourceStartFrame,frameCount),frameCount});
    const boundedPixels=decodedFrames(outputPath);
    assert.equal(boundedPixels.length,frameCount*frameBytes,"only requested source frames are staged");
    assert.ok(boundedPixels.equals(fullPixels.subarray(sourceStartFrame*frameBytes,(sourceStartFrame+frameCount)*frameBytes)),"bounded decoded pixels must exactly equal the selected full-stage pixels");
    assert.deepEqual(metadata.windows,oneWindow(sourceStartFrame,frameCount));
    assert.equal(metadata.frameCount,frameCount);
    assert.equal(metadata.stagedStartSeconds,0);
    assert.deepEqual(frameTimes(outputPath),Array.from({length:frameCount},(_,index)=>Number((index/60).toFixed(6))));
  }
});

for (const origin of [0,.2]) {
  test(`disjoint staging packs only selected causal pixels on one continuous clock (origin ${origin})`,{skip:!available,timeout:60000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),"walkthrough-source-disjoint-"));
    const sourcePath=await fixture(directory,origin);
    const sourcePixels=decodedFrames(sourcePath),frameBytes=128*72*1.5,originFrame=origin*60;
    // The first three intervals cross different off-grid transitions. The
    // holes must disappear without moving those transitions onto a new grid.
    const windows=[
      {sourceStartFrame:originFrame+2,frameCount:2,stagedStartFrame:0},
      {sourceStartFrame:originFrame+7,frameCount:2,stagedStartFrame:2},
      {sourceStartFrame:originFrame+25,frameCount:2,stagedStartFrame:4},
      {sourceStartFrame:originFrame+32,frameCount:1,stagedStartFrame:6},
    ];
    const outputPath=join(directory,'packed.mp4');
    const metadata=await stageRenderSource({sourcePath,outputPath,logPath:join(directory,'packed.log'),ffmpegPath:ffmpeg,ffprobePath:ffprobe,windows,frameCount:7});
    const packedPixels=decodedFrames(outputPath);
    const expectedSampleIndices=[0,1,1,2,2,3,4];
    assert.equal(packedPixels.length,7*frameBytes,'neither omitted gaps nor duplicate boundary frames are encoded');
    for(const [index,sample] of expectedSampleIndices.entries()){
      assert.ok(packedPixels.subarray(index*frameBytes,(index+1)*frameBytes).equals(sourcePixels.subarray(sample*frameBytes,(sample+1)*frameBytes)),`packed frame ${index} preserves original causal sample ${sample} byte for byte`);
    }
    assert.deepEqual(metadata.windows,windows);
    assert.equal(metadata.frameCount,7);
    assert.deepEqual(frameTimes(outputPath),Array.from({length:7},(_,index)=>Number((index/60).toFixed(6))),'the packed media clock contains no timestamps for omitted gaps');
  });
}

test("installed Remotion cold seeks see the held product state, not the next VFR sample",{skip:!available,timeout:60000},async()=>{
  const directory = await mkdtemp(join(tmpdir(),"walkthrough-source-decoder-"));
  const sourcePath = await fixture(directory);
  const {outputPath} = await stage(directory,sourcePath,2,25);
  const rendererDist = dirname(require.resolve("@remotion/renderer"));
  const {makeLazyCompositor} = require(join(rendererDist,"compositor/compositor.js")) as {
    makeLazyCompositor(options:object):{executeCommand(name:string,payload:object):Promise<Uint8Array>;shutDownOrKill():Promise<void>}
  };
  for (const [frame,color] of [[2,"red"],[3,"green"],[7,"green"],[8,"blue"],[25,"blue"],[26,"black"]] as const) {
    // Each seek starts cold: an earlier decode can mask the VFR successor bug.
    const compositor = makeLazyCompositor({extraThreads:1,maximumFrameCacheItemsInBytes:null,logLevel:"error",indent:false,binariesDirectory:null});
    try {
      const bitmap = await compositor.executeCommand("ExtractFrame",{src:outputPath,original_src:outputPath,time:(frame-2)/60,transparent:false,tone_mapped:true});
      const pixel = execFileSync(ffmpeg,["-v","error","-i","pipe:0","-vf","scale=1:1","-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","pipe:1"],{input:bitmap});
      const [r,g,b] = pixel;
      assert.ok(color==="red" ? r>180&&g<80&&b<80 : color==="green" ? g>180&&r<80&&b<80 : color==="blue" ? b>180&&r<80&&g<80 : r<20&&g<20&&b<20,`cold seek ${frame}/60 must be ${color}, got ${[r,g,b]}`);
    } finally { await compositor.shutDownOrKill(); }
  }
  const output = await probeMedia(ffprobe,outputPath);
  assert.equal(output.streams[0].avg_frame_rate,"60/1");
  const holdPath=join(directory,'one-frame-hold.mp4');
  await stageRenderSource({sourcePath,outputPath:holdPath,logPath:join(directory,'one-frame-hold.log'),ffmpegPath:ffmpeg,ffprobePath:ffprobe,windows:oneWindow(25,1),frameCount:1});
  const compositor=makeLazyCompositor({extraThreads:1,maximumFrameCacheItemsInBytes:null,logLevel:"error",indent:false,binariesDirectory:null});
  try{
    const bitmap=await compositor.executeCommand("ExtractFrame",{src:holdPath,original_src:holdPath,time:0,transparent:false,tone_mapped:true});
    const [r,g,b]=execFileSync(ffmpeg,["-v","error","-i","pipe:0","-vf","scale=1:1","-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","pipe:1"],{input:bitmap});
    assert.ok(b>180&&r<80&&g<80,'a one-frame derivative cold seek preserves the selected blue hold');
  }finally{await compositor.shutDownOrKill();}
});

test("invalid source windows start no staging and an incomplete window fails closed",{skip:!available,timeout:60000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"walkthrough-source-invalid-window-"));
  const sourcePath=await fixture(directory);
  for(const [index,[sourceStartFrame,frameCount]] of [[-1,1],[.5,1],[0,0],[0,1.5],[Number.MAX_SAFE_INTEGER,2]].entries()){
    const outputPath=join(directory,`invalid-${index}.mp4`),logPath=join(directory,`invalid-${index}.log`);
    await assert.rejects(stageRenderSource({sourcePath,outputPath,logPath,ffmpegPath:ffmpeg,ffprobePath:ffprobe,windows:oneWindow(sourceStartFrame,frameCount),frameCount}),/render:source_staging_invalid_window/);
    assert.equal(existsSync(outputPath),false);assert.equal(existsSync(logPath),false);
  }
  const invalidPlans=[
    {windows:[],frameCount:1},
    {windows:oneWindow(2,2),frameCount:3},
    {windows:[{sourceStartFrame:2,frameCount:2,stagedStartFrame:1}],frameCount:2},
    {windows:[{sourceStartFrame:2,frameCount:2,stagedStartFrame:0},{sourceStartFrame:8,frameCount:2,stagedStartFrame:3}],frameCount:4},
    {windows:[{sourceStartFrame:2,frameCount:2,stagedStartFrame:0},{sourceStartFrame:3,frameCount:2,stagedStartFrame:2}],frameCount:4},
    {windows:[{sourceStartFrame:8,frameCount:2,stagedStartFrame:0},{sourceStartFrame:2,frameCount:2,stagedStartFrame:2}],frameCount:4},
  ];
  for(const [index,plan] of invalidPlans.entries()){
    const outputPath=join(directory,`invalid-plan-${index}.mp4`),logPath=join(directory,`invalid-plan-${index}.log`);
    await assert.rejects(stageRenderSource({sourcePath,outputPath,logPath,ffmpegPath:ffmpeg,ffprobePath:ffprobe,...plan}),/render:source_staging_invalid_window/);
    assert.equal(existsSync(outputPath),false);assert.equal(existsSync(logPath),false);
  }
  await assert.rejects(stageRenderSource({sourcePath,outputPath:join(directory,'short.mp4'),logPath:join(directory,'short.log'),ffmpegPath:ffmpeg,ffprobePath:ffprobe,windows:oneWindow(32,2),frameCount:2}),/render:source_staging_nonconformant/);
});

test("cancelled staging starts no local process",async()=>{
  const directory = await mkdtemp(join(tmpdir(),"walkthrough-source-cancel-"));
  const logPath = join(directory,"stage.log"), outputPath = join(directory,"staged.mp4");
  await assert.rejects(stageRenderSource({sourcePath:join(directory,"absent.mp4"),outputPath,logPath,ffmpegPath:ffmpeg,ffprobePath:ffprobe,windows:oneWindow(0,1),frameCount:1,signal:AbortSignal.abort()}),/render:cancelled/);
  assert.equal(existsSync(logPath),false);
  assert.equal(existsSync(outputPath),false);
});

test("source staging applies native timestamp policy before the original input",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"walkthrough-staging-native-input-"));
  try{
    const sourcePath=join(directory,"source.mp4"),outputPath=join(directory,"staged.mp4"),toolPath=join(directory,"media-tool.mjs");
    await writeFile(sourcePath,"synthetic original bytes");
    await writeFile(toolPath,`#!${process.execPath}
      import assert from 'node:assert/strict';
      import {writeFileSync} from 'node:fs';
      const args=process.argv.slice(2);
      if(args.includes('-show_streams'))process.stdout.write(JSON.stringify({streams:[{codec_type:'video',codec_name:'h264',pix_fmt:'yuv420p',width:128,height:72,avg_frame_rate:'60/1',start_time:'0',nb_frames:'1'}]}));
      else{
        assert.equal(args[args.indexOf('-fflags')+1],'+nofillin');
        assert.ok(args.indexOf('-fflags')<args.indexOf('-i'),'native timestamp policy is an input option');
        assert.equal(args[args.indexOf('-i')+1],${JSON.stringify(sourcePath)});
        assert.ok(args.includes('-copyts'));
        assert.equal(args.includes('-ss'),false,'input seeks could drop a long-held predecessor');
        const filter=args[args.indexOf('-vf')+1];
        assert.ok(filter.startsWith('fps=60:round=up,'),'causal resampling precedes interval selection');
        assert.ok(filter.endsWith(',setpts=N'),'only selected frames are put on the packed zero-based clock');
        writeFileSync(args.at(-1),'synthetic staged bytes');
      }
    `,{mode:0o700});
    await stageRenderSource({sourcePath,outputPath,logPath:join(directory,'stage.log'),ffmpegPath:toolPath,ffprobePath:toolPath,windows:oneWindow(25,1),frameCount:1});
    assert.equal(await readFile(sourcePath,'utf8'),'synthetic original bytes');
    assert.equal(await readFile(outputPath,'utf8'),'synthetic staged bytes');
  }finally{await rm(directory,{recursive:true,force:true});}
});
