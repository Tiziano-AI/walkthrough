import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { executeLocal, executeFfmpeg, LocalProcessFailure, requireConformantVideo, requireConformantMaster, type FfmpegProgress, type MediaProbe } from "../src/render/media.ts";
import { loudnormFilter, parseLoudnormReport } from '../src/render/loudness.ts';
import {resolveLocalTools} from '../src/core/toolchain.ts';

test("media conformance needs exact output frames, not only a nominal frame rate", () => {
  const probe = { streams: [{ codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "60/1", nb_frames: "120", start_time:'0.000000',duration:'2.000000' }], format: {} };
  assert.equal(requireConformantVideo(probe, 120).nb_frames, "120");
  assert.throws(() => requireConformantVideo(probe, 119), /nonconformant/);
  assert.throws(() => requireConformantVideo({ ...probe, streams: [{ ...probe.streams[0], nb_frames: undefined }] }, 120), /nonconformant/);
  for(const change of [{start_time:'0.001000'},{duration:'2.001000'},{duration:undefined}])assert.throws(()=>requireConformantVideo({...probe,streams:[{...probe.streams[0],...change}]},120),/video_timing_nonconformant/);
});

test('master conformance rejects another codec, chroma depth, container or clock before finishing',()=>{
  const master:MediaProbe={streams:[
    {codec_type:'video',codec_name:'h264',width:1920,height:1080,avg_frame_rate:'60/1',nb_frames:'120',start_time:'0.000000',duration:'2.000000',pix_fmt:'yuv444p10le',time_base:'1/90000',color_space:'bt709',color_primaries:'bt709',color_transfer:'bt709'},
    {codec_type:'audio',codec_name:'pcm_s16le',sample_rate:'48000'},
  ],format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2',tags:{major_brand:'qt  '}}};
  assert.equal(requireConformantMaster(master,120).video,master.streams[0]);
  for(const change of [{codec_name:'prores'},{pix_fmt:'yuv420p'},{pix_fmt:'yuv444p'},{time_base:'1/1000'},{color_space:'unknown'}]){
    assert.throws(()=>requireConformantMaster({...master,streams:[{...master.streams[0],...change},master.streams[1]]},120),/master_video_nonconformant/);
  }
  for(const format of [{format_name:'matroska,webm'},{format_name:master.format.format_name,tags:{major_brand:'isom'}},{}]){
    assert.throws(()=>requireConformantMaster({...master,format},120),/master_container_nonconformant/);
  }
  for(const change of [{codec_name:'aac'},{sample_rate:'44100'}]){
    assert.throws(()=>requireConformantMaster({...master,streams:[master.streams[0],{...master.streams[1],...change}]},120),/master_audio_nonconformant/);
  }
  assert.throws(()=>requireConformantMaster({...master,streams:[master.streams[0]]},120),/master_audio_nonconformant/);
  assert.throws(()=>requireConformantMaster(master,121),/output_video_nonconformant/);
});

test("renderer process preserves private logs and refuses to overwrite them", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "walkthrough-render-test-"));
  const log = path.join(directory, "child.log");
  await executeLocal(process.execPath, ["-e", "console.log('stdout retained'); console.error('stderr retained')"], log);
  assert.match(await fs.readFile(log, "utf8"), /stdout retained\nstderr retained/);
  assert.equal((await fs.stat(log)).mode & 0o777, 0o600);
  await assert.rejects(executeLocal(process.execPath, ["-e", ""], log), /EEXIST/);
});

test("renderer launch failure retains its log without inventing a child exit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "walkthrough-render-test-"));
  const log=path.join(directory,"missing.log");
  await assert.rejects(executeLocal("/nonexistent/walkthrough-process", ['private argument'], log), error=>{
    assert.ok(error instanceof LocalProcessFailure);assert.equal(error.code,'render:local_process_launch_failed');
    assert.equal(error.diagnosticPath,log);assert.equal(error.child,undefined);
    assert.equal(JSON.stringify(error).includes('private argument'),false);return true;
  });
  assert.equal(await fs.readFile(log,'utf8'),'');
});

test("renderer cancellation is observed before launch and terminates a live process", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "walkthrough-render-test-"));
  const before = AbortSignal.abort();
  await assert.rejects(executeLocal(process.execPath, [], path.join(directory, "before.log"), 1000, undefined, before), /cancelled/);
  await assert.rejects(fs.access(path.join(directory, "before.log")));
  const controller = new AbortController();
  const pending = executeLocal(process.execPath, ["-e", "setInterval(()=>{},1000)"], path.join(directory, "cancel.log"), 10000, undefined, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, error=>{
    assert.ok(error instanceof LocalProcessFailure);assert.equal(error.code,'render:cancelled');
    assert.equal(error.diagnosticPath,path.join(directory,'cancel.log'));
    assert.deepEqual(error.child,{exitCode:null,signal:'SIGTERM'});return true;
  });
});

test('increasing FFmpeg counters survive the initial deadline and preserve exact stderr', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'walkthrough-progress-test-'));
  const log = path.join(directory, 'progress.log');
  const observations: FfmpegProgress[] = [];
  const diagnostic = 'exact stderr diagnostic\n';
  const result = await executeLocal(process.execPath, ['-e', `
    process.stderr.write(${JSON.stringify(diagnostic)});
    let frame = 0;
    const timer = setInterval(() => {
      ++frame;
      // Split the protocol across writes, including a split key and CRLF.
      process.stdout.write('fra');
      process.stdout.write('me= ' + frame + '\\r\\nout_time_us=' + frame * 1000 + '\\nprogress=' + (frame === 40 ? 'end' : 'continue') + '\\n');
      if (frame === 40) clearInterval(timer);
    }, 40);
  `], log, 600, undefined, undefined, undefined, { ffmpeg: true, onProgress: progress => observations.push(progress) });
  assert.equal(result, undefined, 'successful execution retains its existing result contract');
  assert.equal(observations.length, 40);
  assert.deepEqual(observations.at(-1), { frame: 40, outTimeUs: 40_000, status: 'end' });
  assert.equal(await fs.readFile(log, 'utf8'), diagnostic, 'progress never contaminates diagnostic stderr');
});

test('repeated or regressing FFmpeg counters and oversized chatter cannot renew a stalled child', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'walkthrough-progress-test-'));
  const log = path.join(directory, 'stalled.log');
  const observations: FfmpegProgress[] = [];
  await assert.rejects(executeLocal(process.execPath, ['-e', `
    process.stderr.write('stalled diagnostic\\n');
    let tick = 0;
    const timer = setInterval(() => {
      ++tick;
      process.stdout.write('x'.repeat(100000) + 'frame=999999\\n');
      process.stdout.write('frame=' + (tick % 2 ? 8 : 7) + '\\nout_time_us=' + (tick % 2 ? 8000 : 7000) + '\\nprogress=continue\\n');
    }, 40);
    setTimeout(() => clearInterval(timer), 2400);
  `], log, 600, undefined, undefined, undefined, { ffmpeg: true, onProgress: progress => observations.push(progress) }), error => {
    assert.ok(error instanceof LocalProcessFailure);
    assert.equal(error.code, 'render:local_process_timeout');
    assert.equal(error.diagnosticPath, log);
    assert.deepEqual(error.child, { exitCode: null, signal: 'SIGTERM' });
    return true;
  });
  assert.deepEqual(observations, [{ frame: 8, outTimeUs: 8000, status: 'continue' }]);
  assert.equal(await fs.readFile(log, 'utf8'), 'stalled diagnostic\n');
});

test('ordinary local execution retains its wall deadline even when stdout looks active', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'walkthrough-progress-test-'));
  const log = path.join(directory, 'wall-deadline.log');
  await assert.rejects(executeLocal(process.execPath, ['-e', `
    let frame = 0;
    const timer = setInterval(() => process.stdout.write('frame=' + ++frame + '\\nprogress=continue\\n'), 40);
    setTimeout(() => clearInterval(timer), 2400);
  `], log, 600), /render:local_process_timeout/);
  assert.match(await fs.readFile(log, 'utf8'), /frame=\d+\nprogress=continue/);
});

test('monotonic file observations extend activity while reads stay serialized', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'walkthrough-progress-test-'));
  const progressPath = path.join(directory, 'work-counter');
  let reading = false, observed = 0;
  await executeLocal(process.execPath, ['-e', `
    const fs = require('node:fs');
    let count = 0;
    const timer = setInterval(() => {
      fs.writeFileSync(${JSON.stringify(progressPath)}, String(++count));
      if (count === 40) clearInterval(timer);
    }, 40);
  `], path.join(directory, 'polled.log'), 600, undefined, undefined, undefined, { read: async () => {
    assert.equal(reading, false);
    reading = true;
    try {
      const count = Number(await fs.readFile(progressPath, 'utf8'));
      observed = Math.max(observed, count);
      return count;
    } finally { reading = false; }
  } });
  assert.ok(observed > 15, 'the child continued beyond the initial deadline');
});

test('unchanged observations and a hanging progress read do not defeat the inactivity deadline', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'walkthrough-progress-test-'));
  let reads = 0;
  await assert.rejects(executeLocal(process.execPath, ['-e', 'setTimeout(()=>{},2400)'], path.join(directory, 'unchanged.log'), 600, undefined, undefined, undefined,
    { read: async () => { ++reads; return 1; } }), /render:local_process_timeout/);
  assert.ok(reads > 1);
  let hangingReads = 0;
  await assert.rejects(executeLocal(process.execPath, ['-e', 'setTimeout(()=>{},2400)'], path.join(directory, 'hanging.log'), 600, undefined, undefined, undefined,
    { read: () => { ++hangingReads; return new Promise<number>(() => {}); } }), /render:local_process_timeout/);
  assert.equal(hangingReads, 1, 'never accumulate unresolved progress readers');
});

test('cancellation stops a child whose progress is advancing and settles its exact group', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'walkthrough-progress-test-'));
  const controller = new AbortController();
  const pidPath = path.join(directory, 'pid');
  await assert.rejects(executeLocal(process.execPath, ['-e', `
    require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    let frame = 0;
    setInterval(() => process.stdout.write('frame=' + ++frame + '\\nprogress=continue\\n'), 40);
  `], path.join(directory, 'cancel-active.log'), 600, undefined, controller.signal, undefined,
    { ffmpeg: true, onProgress: progress => { if (progress.frame === 3) controller.abort(); } }), error => {
    assert.ok(error instanceof LocalProcessFailure);
    assert.equal(error.code, 'render:cancelled');
    assert.deepEqual(error.child, { exitCode: null, signal: 'SIGTERM' });
    return true;
  });
  const pid = Number(await fs.readFile(pidPath, 'utf8'));
  for (const target of [pid, -pid]) assert.throws(() => process.kill(target, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
});

test('FFmpeg wrapper observes native audio progress without losing the final loudnorm report', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'walkthrough-progress-test-'));
  const log = path.join(directory, 'loudnorm.log');
  const observations: FfmpegProgress[] = [];
  await executeFfmpeg(resolveLocalTools().ffmpegPath, ['-hide_banner', '-loglevel', 'info', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000:duration=1', '-af', loudnormFilter(), '-f', 'null', '-'],
    log, 30_000, undefined, undefined, undefined, progress => observations.push(progress));
  const diagnostic = await fs.readFile(log, 'utf8');
  assert.equal(parseLoudnormReport(diagnostic).normalizationType, 'linear');
  assert.ok(observations.some(progress => (progress.outTimeUs ?? 0) > 0));
  assert.equal(observations.at(-1)?.status, 'end');
  assert.doesNotMatch(diagnostic, /^(?:out_time_us|progress)=/m);
});

test('public supervisor and fd3 stage gate preserve progress stdout and settled ownership', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walkthrough-progress-custody-')));
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const name of ['bin', 'src/core', 'scripts']) await fs.mkdir(path.join(directory, name), { recursive: true });
  // Exact production supervisor and gate; only the coordinator is synthetic.
  for (const name of ['bin/walkthrough.mjs', 'src/core/runtime-paths.ts', 'scripts/loopback-only.sb']) await fs.copyFile(path.join(root, name), path.join(directory, name));
  const stage = `
    require('node:fs').writeFileSync('stage-pid', String(process.pid));
    process.stderr.write('supervised diagnostic\\n');
    let frame = 0;
    const timer = setInterval(() => {
      process.stdout.write('frame=' + ++frame + '\\nprogress=' + (frame === 60 ? 'end' : 'continue') + '\\n');
      if (frame === 60) clearInterval(timer);
    }, 40);
  `;
  await fs.writeFile(path.join(directory, 'src/cli.ts'), `
    import {executeLocal} from ${JSON.stringify(path.join(root, 'src/render/media.ts'))};
    let frame;
    await executeLocal(process.execPath, ['-e', ${JSON.stringify(stage)}], 'stage.log', 1000, undefined, undefined, undefined,
      {ffmpeg:true,onProgress:progress=>{frame=progress.frame;}});
    console.log(JSON.stringify({schemaVersion:1,status:'completed',frame,custody:process.env.WALKTHROUGH_STAGE_CUSTODY}));
  `);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(directory, 'bin/walkthrough.mjs'), 'doctor', '--json'], {
    cwd: directory, timeout: 15_000, maxBuffer: 64_000,
    env: { ...process.env, WALKTHROUGH_STATE_ROOT: path.join(directory, 'state'), WALKTHROUGH_CONFIG_ROOT: path.join(directory, 'settings') },
  });
  assert.deepEqual(JSON.parse(stdout), { schemaVersion: 1, status: 'completed', frame: 60, custody: 'fd3-v1' });
  assert.equal(stderr, '');
  assert.equal(await fs.readFile(path.join(directory, 'stage.log'), 'utf8'), 'supervised diagnostic\n');
  const pid = Number(await fs.readFile(path.join(directory, 'stage-pid'), 'utf8'));
  for (const target of [pid, -pid]) assert.throws(() => process.kill(target, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
});
