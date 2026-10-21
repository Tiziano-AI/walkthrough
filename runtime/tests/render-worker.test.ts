import assert from 'node:assert/strict';
import test from 'node:test';
import {masterFfmpegOverride,masterRenderOptions,requireStreamingEncoding} from '../src/render/worker.ts';

test('the one master lane requires native streaming H.264 10-bit 4:4:4 and PCM in MOV',()=>{
  const {onStart,ffmpegOverride,...options}=masterRenderOptions('/private/render');
  assert.deepEqual(options,{
    outputLocation:'/private/render/master.mov',codec:'h264',crf:1,pixelFormat:'yuv444p10le',
    imageFormat:'png',colorSpace:'bt709',audioCodec:'pcm-16',sampleRate:48000,enforceAudioTrack:true,
    concurrency:1,overwrite:false,hardwareAcceleration:'disable',repro:false,disallowParallelEncoding:false,
  });
  assert.equal(onStart,requireStreamingEncoding);
  assert.equal(ffmpegOverride,masterFfmpegOverride);
  assert.doesNotThrow(()=>onStart({parallelEncoding:true}));
  for(const parallelEncoding of [false,undefined,null]){
    assert.throws(()=>onStart({parallelEncoding} as any),/render:streaming_encoding_required/,'memory refusal must fail rather than render a PNG spool');
  }
});

test('native pre-stitcher keeps its exact intermediate path and clock while forcing a MOV container',()=>{
  const args=['-r','60','-f','image2pipe','-vcodec','png','-i','-','-c:v','libx264','-pix_fmt','yuv444p10le','-video_track_timescale','90000','-crf','1','-y','/private/pre-encode.mkv'];
  const original=[...args],result=masterFfmpegOverride({type:'pre-stitcher',args});
  assert.deepEqual(result,[...args.slice(0,-1),'-f','mov','/private/pre-encode.mkv']);
  assert.deepEqual(args,original,'the callback does not mutate native arguments');
  assert.equal(result.filter(value=>value==='-video_track_timescale').length,1);
  assert.equal(result.at(-1),args.at(-1),'Remotion must later open the same owned file');
});

test('native final mux copies the encoded picture and PCM without losing its exact frame clock',()=>{
  const args=['-i','/private/pre-encode.mkv','-i','/private/audio.wav','-c:a','copy','-c:v','copy','-map_metadata','-1','/private/master.mov'];
  assert.deepEqual(masterFfmpegOverride({type:'stitcher',args}),[...args.slice(0,-1),'-video_track_timescale','90000','/private/master.mov']);
  const alreadyClocked=[...args.slice(0,-1),'-video_track_timescale','90000',args.at(-1)!];
  assert.deepEqual(masterFfmpegOverride({type:'stitcher',args:alreadyClocked}),alreadyClocked);
});

test('changed native clock or missing output cannot silently enter the master lane',()=>{
  for(const type of ['pre-stitcher','stitcher'] as const){
    assert.throws(()=>masterFfmpegOverride({type,args:[]}),/master_ffmpeg_output_missing/);
    assert.throws(()=>masterFfmpegOverride({type,args:['-video_track_timescale','1000','/private/output.mov']}),/master_ffmpeg_clock_changed/);
  }
  assert.throws(()=>masterFfmpegOverride({type:'pre-stitcher',args:['-i','-','/private/pre-encode.mkv']}),/master_ffmpeg_clock_missing/);
});
