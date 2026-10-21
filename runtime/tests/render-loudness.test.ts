import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {finishMedia,executeLocal,measureLoudness,probeMedia} from '../src/render/media.ts';
import {LOUDNESS_POLICY,deliveryLoudnormFilter,loudnessAcceptance,loudnormFilter,parseLoudnormReport} from '../src/render/loudness.ts';
import {resolveLocalTools} from '../src/core/toolchain.ts';

const report={input_i:'-29.14',input_tp:'-20.22',input_lra:'3.20',input_thresh:'-39.20',output_i:'-16.05',output_tp:'-7.08',output_lra:'3.10',output_thresh:'-26.10',normalization_type:'linear',target_offset:'0.05'};

test('loudnorm parsing keeps encoded-input and hypothetical normalized-output measurements distinct',()=>{
  const parsed=parseLoudnormReport(`FFmpeg local diagnostic\n${JSON.stringify(report)}\n`);
  assert.deepEqual(parsed.input,{integratedLufs:-29.14,truePeakDbtp:-20.22,loudnessRangeLu:3.2,thresholdLufs:-39.2});
  assert.equal(parsed.output.integratedLufs,-16.05);
  assert.equal(parsed.normalizationType,'linear');
  assert.equal(parsed.targetOffsetDb,.05);
  assert.equal(loudnessAcceptance(parsed.input).passed,false);
  assert.equal(loudnessAcceptance(parsed.output).passed,true);
});

test('missing, malformed, multiple and nonfinite reports cannot become valid measurements',()=>{
  for(const value of ['',JSON.stringify({...report,input_i:null}),JSON.stringify({...report,input_tp:'NaN'}),JSON.stringify({...report,input_lra:''}),JSON.stringify({...report,normalization_type:'none'}),JSON.stringify(report)+JSON.stringify(report)]){
    assert.throws(()=>parseLoudnormReport(value),/audio_loudness_report_invalid/);
  }
  for(const key of ['input_i','input_tp','output_i','target_offset'])assert.throws(()=>parseLoudnormReport(JSON.stringify({...report,[key]:'-inf'})),/audio_loudness_unmeasurable/);
});

test('the second pass carries all measured native settings and fixed AAC headroom',()=>{
  assert.equal(loudnormFilter(),'loudnorm=I=-16:TP=-2:LRA=50:print_format=json');
  assert.equal(loudnormFilter(parseLoudnormReport(JSON.stringify(report))),
    'loudnorm=I=-16:TP=-2:LRA=50:measured_I=-29.14:measured_TP=-20.22:measured_LRA=3.2:measured_thresh=-39.2:offset=0.05:linear=true:print_format=json');
  assert.equal(deliveryLoudnormFilter(parseLoudnormReport(JSON.stringify(report))),
    'loudnorm=I=-16:TP=-2:LRA=50:measured_I=-29.14:measured_TP=-20.22:measured_LRA=3.2:measured_thresh=-39.2:offset=0.05:linear=true:print_format=json,aresample=48000,asetpts=N/SR/TB');
  for(const value of [Infinity,NaN,-100,1])assert.throws(()=>loudnormFilter({...parseLoudnormReport(JSON.stringify(report)),input:{...parseLoudnormReport(JSON.stringify(report)).input,integratedLufs:value}}),/unmeasurable/);
});

test('delivery acceptance applies the explicit LU tolerance but no peak-ceiling tolerance',()=>{
  const measurement=parseLoudnormReport(JSON.stringify(report)).output;
  for(const integratedLufs of [-16.5,-15.5])assert.equal(loudnessAcceptance({...measurement,integratedLufs,truePeakDbtp:-1}).passed,true);
  for(const integratedLufs of [-16.51,-15.49,Infinity,NaN])assert.equal(loudnessAcceptance({...measurement,integratedLufs}).passed,false);
  for(const truePeakDbtp of [-.99,0,Infinity,NaN])assert.equal(loudnessAcceptance({...measurement,truePeakDbtp}).passed,false);
});

async function mediaFixture(deliveryChanges:Record<string,unknown>={},deliveryDuration='6.000000',inputChanges:Record<string,unknown>={},durationInFrames=360){
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-loudness-contract-'));
  const toolPath=join(directory,'media-tool.mjs'),masterPath=join(directory,'master.mov');
  const duration=(durationInFrames/60).toFixed(6);
  const video={codec_type:'video',width:1920,height:1080,avg_frame_rate:'60/1',nb_frames:String(durationInFrames),duration,start_time:'0.000000'};
  const audio={codec_type:'audio',sample_rate:'48000',channels:2,duration,start_time:'0.000000'};
  const master={streams:[{...video,codec_name:'h264',pix_fmt:'yuv444p10le',time_base:'1/90000',color_space:'bt709',color_primaries:'bt709',color_transfer:'bt709'},{...audio,codec_name:'pcm_s16le'}],format:{duration,format_name:'mov,mp4,m4a,3gp,3g2,mj2',tags:{major_brand:'qt  '}}};
  const delivery={streams:[{...video,codec_name:'h264',pix_fmt:'yuv420p',color_space:'bt709'},{...audio,codec_name:'aac',duration:deliveryDuration}],format:{duration:deliveryDuration}};
  const deliveredReport={...report,input_i:'-16.10',input_tp:'-1.13',input_lra:'3.20',input_thresh:'-26.20',...deliveryChanges};
  const inputReport={...report,...inputChanges};
  await writeFile(masterPath,'the one original master');
  await writeFile(toolPath,`#!${process.execPath}
import {appendFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2),input=args[args.indexOf('-i')+1];
appendFileSync(${JSON.stringify(join(directory,'calls.jsonl'))},JSON.stringify(args)+'\\n');
if(args.includes('-show_streams'))console.log(JSON.stringify(args.at(-1)===${JSON.stringify(masterPath)}?${JSON.stringify(master)}:${JSON.stringify(delivery)}));
else if(args.includes('-af')){
  console.error(JSON.stringify(args.includes('null')&&input!==${JSON.stringify(masterPath)}?${JSON.stringify(deliveredReport)}:${JSON.stringify(inputReport)}));
  if(!args.includes('null'))writeFileSync(args.at(-1),'encoded delivery');
}else writeFileSync(args.at(-1),'silent delivery or poster');
`,{mode:0o700});
  return {directory,masterPath,ffmpegPath:toolPath,ffprobePath:toolPath,durationInFrames,hasNarration:true,purpose:'delivery' as const};
}

async function calls(directory:string):Promise<string[][]>{
  return (await readFile(join(directory,'calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
}

test('finishing measures the master, normalizes once during delivery and measures final AAC',async()=>{
  const options=await mediaFixture();
  const result=await finishMedia(options),commands=await calls(options.directory);
  const encode=commands.find(args=>args.at(-1)?.endsWith('walkthrough.mp4')&&args.includes('-c:v'))!;
  assert.equal(encode[encode.indexOf('-af')+1],deliveryLoudnormFilter(parseLoudnormReport(JSON.stringify(report))));
  assert.equal(encode[encode.indexOf('-i')+1],options.masterPath);
  assert.equal(encode[encode.indexOf('-fps_mode')+1],'passthrough');
  assert.equal(encode[encode.indexOf('-ar')+1],'48000');
  for(const flag of ['-t','-shortest','-r','-frames:v'])assert.equal(encode.includes(flag),false,'finishing must not retime or truncate the picture');
  assert.equal(commands.filter(args=>args.includes('libx264')).length,1);
  assert.equal(commands.filter(args=>args.includes('null')).length,2);
  assert.deepEqual(commands.filter(args=>args.includes('null')).map(args=>args[args.indexOf('-i')+1]),[options.masterPath,result.videoPath]);
  assert.equal(await readFile(options.masterPath,'utf8'),'the one original master');
  assert.equal(result.metrics.audioLoudness.status,'passed');
  assert.equal(result.metrics.audioLoudness.delivered?.integratedLufs,-16.1);
  assert.equal(result.metrics.audioLoudness.normalization?.report?.normalizationType,'linear');
  assert.equal(result.metrics.audioTiming.passed,true);
  assert.equal(result.metrics.viewerAcceptance,'not-established');
  assert.deepEqual(JSON.parse(await readFile(join(options.directory,'media-metrics.json'),'utf8')),result.metrics);
});

test('a silent timeline skips loudness passes and explicitly skips their acceptance',async()=>{
  const options=await mediaFixture();
  const result=await finishMedia({...options,hasNarration:false}),commands=await calls(options.directory);
  assert.equal(commands.some(args=>args.includes('-af')),false);
  assert.equal(commands.some(args=>args.includes('null')),false);
  assert.equal(result.metrics.audioLoudness.status,'skipped-silent');
  for(const field of ['input','normalization','delivered','acceptance'] as const)assert.equal(result.metrics.audioLoudness[field],null);
  assert.equal(result.metrics.audioTiming.passed,true);
});

test('silent and narrated previews keep their original gain without claiming loudness acceptance',async()=>{
  for(const hasNarration of [false,true])for(const frames of [1,360]){
    const options=await mediaFixture({},(frames/60).toFixed(6),{input_i:'-inf',input_tp:'-18.06',target_offset:'inf'},frames);
    const result=await finishMedia({...options,purpose:'preview',hasNarration}),commands=await calls(options.directory);
    assert.equal(result.metrics.audioLoudness.status,'not-evaluated-preview');
    for(const field of ['input','normalization','delivered','acceptance'] as const)assert.equal(result.metrics.audioLoudness[field],null);
    assert.equal(commands.some(args=>args.includes('-af')),false,'a preview never applies excerpt-dependent gain');
    assert.equal(commands.some(args=>args.includes('null')),false,'preview loudness is not a failed measurement fallback');
    assert.equal(commands.filter(args=>args.includes('libx264')).length,1);
    assert.equal(result.metrics.audioTiming.passed,true);
    assert.equal(result.metrics.expectedFrames,frames);
    assert.equal(result.metrics.viewerAcceptance,'not-established');
    assert.equal(await readFile(options.masterPath,'utf8'),'the one original master');
  }
});

test('preview purpose does not bypass delivery audio timing checks',async()=>{
  const options=await mediaFixture({},'0.100000',{},1);
  await assert.rejects(finishMedia({...options,purpose:'preview'}),/delivery_audio_timing_nonconformant/);
  const metrics=JSON.parse(await readFile(join(options.directory,'media-metrics.json'),'utf8'));
  assert.equal(metrics.audioLoudness.status,'not-evaluated-preview');
  assert.equal(metrics.audioTiming.passed,false);
  assert.equal(existsSync(join(options.directory,'poster.png')),false);
});

test('finishing requires an explicit valid purpose before opening media',async()=>{
  const options=await mediaFixture();
  for(const purpose of [undefined,'anything-else'])await assert.rejects(finishMedia({...options,purpose} as any),/render:finishing_purpose_required/);
  assert.equal(existsSync(join(options.directory,'calls.jsonl')),false);
});

test('declared narration that measures as silence fails before the delivery encode',async()=>{
  const options=await mediaFixture({},'6.000000',{input_i:'-inf',input_tp:'-inf'});
  await assert.rejects(finishMedia(options),/audio_loudness_unmeasurable/);
  assert.equal((await calls(options.directory)).some(args=>args.includes('libx264')),false);
  assert.match(await readFile(join(options.directory,'finish-loudness-input.log'),'utf8'),/-inf/);
});

test('a one-frame final delivery with measurable peak but unavailable LUFS still fails',async()=>{
  const options=await mediaFixture({},'0.016667',{input_i:'-inf',input_tp:'-18.06',target_offset:'inf'},1);
  await assert.rejects(finishMedia(options),/audio_loudness_unmeasurable/);
  assert.equal((await calls(options.directory)).some(args=>args.includes('libx264')),false);
});

test('AAC overshoot or wrong delivered loudness fails with metrics retained and no retry',async()=>{
  for(const changes of [{input_tp:'-0.99'},{input_i:'-18.00'}]){
    const options=await mediaFixture(changes);
    await assert.rejects(finishMedia(options),/delivery_audio_loudness_nonconformant/);
    const metrics=JSON.parse(await readFile(join(options.directory,'media-metrics.json'),'utf8'));
    assert.equal(metrics.audioLoudness.status,'failed');
    assert.equal(metrics.audioLoudness.acceptance.passed,false);
    assert.equal((await calls(options.directory)).filter(args=>args.includes('libx264')).length,1);
    assert.equal(existsSync(join(options.directory,'poster.png')),false);
  }
});

test('changed delivery audio duration is not hidden by conformant video frames',async()=>{
  const options=await mediaFixture({},'6.050000');
  await assert.rejects(finishMedia(options),/delivery_audio_timing_nonconformant/);
  const metrics=JSON.parse(await readFile(join(options.directory,'media-metrics.json'),'utf8'));
  assert.equal(metrics.expectedFrames,360);
  assert.equal(metrics.audioTiming.passed,false);
});

test('pre-cancelled finishing launches neither probes nor normalization',async()=>{
  const options=await mediaFixture();
  await assert.rejects(finishMedia({...options,signal:AbortSignal.abort()}),/render:cancelled/);
  assert.equal(existsSync(join(options.directory,'calls.jsonl')),false);
});

const {ffmpegPath:ffmpeg,ffprobePath:ffprobe}=resolveLocalTools();
test('native one-frame silent and audible previews survive unavailable integrated loudness',{skip:![ffmpeg,ffprobe].every(existsSync),timeout:60000},async()=>{
  for(const hasNarration of [false,true]){
    const directory=await mkdtemp(join(tmpdir(),'walkthrough-preview-native-')),masterPath=join(directory,'master.mov');
    const source=hasNarration?'sine=frequency=440:sample_rate=48000:duration=0.016666666667':'anullsrc=r=48000:cl=mono:d=0.016666666667';
    // Real codec/container behavior for exactly one picture frame and 800
    // source samples, without Chromium, a speech model or application footage.
    await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','color=c=black:s=1920x1080:r=60:d=0.016666666667','-f','lavfi','-i',source,'-map','0:v:0','-map','1:a:0','-c:v','libx264','-crf','1','-pix_fmt','yuv444p10le','-video_track_timescale','90000','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-threads','1','-c:a','pcm_s16le','-ar','48000',masterPath],join(directory,'fixture.log'));
    const originalBytes=await readFile(masterPath);
    await assert.rejects(measureLoudness({ffmpegPath:ffmpeg,mediaPath:masterPath,logPath:join(directory,'input.log')}),/audio_loudness_unmeasurable/);
    const result=await finishMedia({directory,masterPath,ffmpegPath:ffmpeg,ffprobePath:ffprobe,durationInFrames:1,hasNarration,purpose:'preview'});
    assert.equal(result.metrics.audioLoudness.status,'not-evaluated-preview');
    assert.equal(result.metrics.audioLoudness.normalization,null);
    assert.equal(result.metrics.audioLoudness.acceptance,null);
    assert.equal(result.metrics.audioTiming.passed,true);
    assert.equal(result.metrics.delivery.streams.find(stream=>stream.codec_type==='video')?.nb_frames,'1');
    assert.deepEqual(await readFile(masterPath),originalBytes);
    assert.equal(existsSync(join(directory,'finish-loudness-input.log')),false);
    const raw=join(directory,'decoded.f32');
    await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',result.videoPath,'-map','0:a:0','-c:a','pcm_f32le','-f','f32le',raw],join(directory,'decode.log'));
    const decoded=await readFile(raw);let peak=0;
    for(let sample=0;sample<decoded.length;sample+=4)peak=Math.max(peak,Math.abs(decoded.readFloatLE(sample)));
    assert.ok(decoded.length>0,'even the shortest preview retains its audio track');
    if(hasNarration)assert.ok(peak>.04&&peak<.25,'the audible tone remains near its original 0.125 peak, not normalized toward the delivery target');
    else assert.ok(peak<.000001,'the silent excerpt remains silent');
  }
});

test('native audio-only two-pass AAC keeps sample-clock placement and measured delivery limits',{skip:![ffmpeg,ffprobe].every(existsSync),timeout:60000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-loudness-native-'));
  const original=join(directory,'original.wav'),delivery=join(directory,'delivery.m4a');
  // The silent opening, internal gap and ending expose retiming independently
  // of the filter's own loudness report. No speech model or picture renderer.
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i',"aevalsrc=if(between(t\\,1\\,2.5)+between(t\\,3\\,5)\\,0.015*sin(2*PI*700*t)\\,0):s=48000:d=6",'-c:a','pcm_s16le',original],join(directory,'fixture.log'));
  const originalBytes=await readFile(original);
  const input=await measureLoudness({ffmpegPath:ffmpeg,mediaPath:original,logPath:join(directory,'input.log')});
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','info','-nostats','-nostdin','-n','-i',original,'-map','0:a:0','-af',deliveryLoudnormFilter(input),'-c:a','aac','-b:a','192k','-ar','48000',delivery],join(directory,'normalize.log'));
  const normalized=parseLoudnormReport(await readFile(join(directory,'normalize.log'),'utf8'));
  const measured=await measureLoudness({ffmpegPath:ffmpeg,mediaPath:delivery,logPath:join(directory,'delivery.log')});
  assert.ok(input.input.integratedLufs<-30);
  assert.equal(normalized.normalizationType,'linear');
  assert.deepEqual(loudnessAcceptance(measured.input),{passed:true,integratedLoudness:true,truePeak:true});
  assert.ok(measured.input.truePeakDbtp<=LOUDNESS_POLICY.maximumTruePeakDbtp);
  assert.deepEqual(await readFile(original),originalBytes);
  const probe=await probeMedia(ffprobe,delivery),audio=probe.streams.find(stream=>stream.codec_type==='audio')!;
  assert.equal(Number(audio.start_time),0);
  assert.ok(Math.abs(Number(audio.duration)-6)<=1024/48000);
  const raw=join(directory,'decoded.f32');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',delivery,'-map','0:a:0','-c:a','pcm_f32le','-f','f32le',raw],join(directory,'decode.log'));
  const decoded=await readFile(raw);
  const rms=(start:number,end:number)=>{
    let square=0,count=0;
    for(let sample=Math.round(start*48000);sample<Math.round(end*48000);sample++){square+=decoded.readFloatLE(sample*4)**2;count++;}
    return Math.sqrt(square/count);
  };
  for(const [start,end] of [[0,.95],[2.55,2.95],[5.05,5.95]])assert.ok(rms(start,end)<.00001,'declared gaps remain at their original clock positions');
  for(const [start,end] of [[1.02,1.1],[2.4,2.48],[3.02,3.1],[4.9,4.98]])assert.ok(rms(start,end)>.03,'audible samples stay inside their original intervals');
});

test('native dynamic fallback is measured, not assumed to reach its requested target',{skip:![ffmpeg,ffprobe].every(existsSync),timeout:60000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-loudness-dynamic-'));
  const original=join(directory,'original.wav'),delivery=join(directory,'delivery.m4a');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i',"aevalsrc=if(between(t\\,1\\,2.5)+between(t\\,3\\,5)\\,if(between(t\\,3.4\\,3.45)\\,0.8\\,0.015)*sin(2*PI*700*t)\\,0):s=48000:d=6",'-c:a','pcm_s16le',original],join(directory,'fixture.log'));
  const input=await measureLoudness({ffmpegPath:ffmpeg,mediaPath:original,logPath:join(directory,'input.log')});
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','info','-nostats','-nostdin','-n','-i',original,'-map','0:a:0','-af',deliveryLoudnormFilter(input),'-c:a','aac','-b:a','192k','-ar','48000',delivery],join(directory,'normalize.log'));
  const normalized=parseLoudnormReport(await readFile(join(directory,'normalize.log'),'utf8'));
  const delivered=(await measureLoudness({ffmpegPath:ffmpeg,mediaPath:delivery,logPath:join(directory,'delivery.log')})).input;
  assert.equal(normalized.normalizationType,'dynamic');
  // This deliberately unusual sparse transient does not land within 0.5 LU
  // under the qualified filter. A clean process exit is not acceptance.
  assert.equal(loudnessAcceptance(delivered).passed,false);
  assert.equal(loudnessAcceptance(delivered).integratedLoudness,false);
  assert.equal(loudnessAcceptance(delivered).truePeak,true);
  const audio=(await probeMedia(ffprobe,delivery)).streams.find(stream=>stream.codec_type==='audio')!;
  assert.equal(Number(audio.start_time),0);
  assert.ok(Math.abs(Number(audio.duration)-6)<=1024/48000);
});

test('native dynamic finishing preserves a non-block-aligned ending without stretching AAC timestamps',{skip:![ffmpeg,ffprobe].every(existsSync),timeout:60000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-loudness-clock-'));
  const original=join(directory,'original.wav'),delivery=join(directory,'delivery.m4a');
  // Exactly 405 picture frames. The isolated transient forces dynamic mode;
  // the ending lands between the filter's internal processing boundaries.
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i',"aevalsrc=if(between(t\\,3.4\\,3.40125)\\,0.8\\,0.015)*sin(2*PI*700*t):s=48000:d=6.75",'-c:a','pcm_s16le',original],join(directory,'fixture.log'));
  const input=await measureLoudness({ffmpegPath:ffmpeg,mediaPath:original,logPath:join(directory,'input.log')});
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','info','-nostats','-nostdin','-n','-i',original,'-map','0:a:0','-af',deliveryLoudnormFilter(input),'-c:a','aac','-b:a','192k','-ar','48000',delivery],join(directory,'normalize.log'));
  assert.equal(parseLoudnormReport(await readFile(join(directory,'normalize.log'),'utf8')).normalizationType,'dynamic');
  const audio=(await probeMedia(ffprobe,delivery)).streams.find(stream=>stream.codec_type==='audio')!;
  assert.equal(Number(audio.start_time),0);
  assert.ok(Math.abs(Number(audio.duration)-6.75)<=1/48000,`dynamic finishing must preserve the sample clock, observed ${audio.duration}`);
});
