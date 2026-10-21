import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnOwnedStage, releaseOwnedStage } from "../core/stage-process.ts";
import { LOUDNESS_POLICY, deliveryLoudnormFilter, loudnessAcceptance, loudnormFilter, parseLoudnormReport } from "./loudness.ts";

export interface MediaStream {
  codec_type?: string; codec_name?: string; width?: number; height?: number;
  avg_frame_rate?: string; r_frame_rate?: string; nb_frames?: string;
  duration?: string; start_time?: string; time_base?: string; pix_fmt?: string; sample_rate?: string; channels?: number;
  color_space?: string; color_primaries?: string; color_transfer?: string;
}
export interface MediaProbe { streams: MediaStream[]; format: { duration?: string; size?: string; format_name?:string; tags?:Record<string,string> } }

type LocalProcessFailureCode = 'render:local_process_launch_failed'|'render:local_process_timeout'|'render:local_process_failed'|'render:cancelled';
type ObservedProcessExit = {exitCode:number|null;signal:NodeJS.Signals|null};

export interface FfmpegProgress {
  frame?: number;
  outTimeUs?: number;
  status: 'continue' | 'end';
}

export interface LocalProcessActivity {
  /** Reserve stdout for FFmpeg's -progress pipe:1 protocol, never media bytes. */
  ffmpeg?: true;
  /** Monotonically increasing work, not a heartbeat or observation timestamp.
   * Reads are serialized; a missing, rejected or hanging read adds no activity. */
  read?: () => Promise<number | undefined>;
  onProgress?: (progress: FfmpegProgress) => void;
}

/** Keep only the bounded current line and two counters. Unknown/chattering
 * output is drained without retaining a second copy of the process log. */
function ffmpegProgressReader(observe: (progress: FfmpegProgress) => void) {
  const maximumLineLength = 512;
  let line = '', dropping = false;
  let frame: number | undefined, outTimeUs: number | undefined;
  const acceptLine = () => {
    const match = /^(frame|out_time_us)=\s*(\d+)\s*$/.exec(line);
    if (match) {
      const value = Number(match[2]);
      if (Number.isSafeInteger(value)) {
        if (match[1] === 'frame') frame = value; else outTimeUs = value;
      }
    } else if (line === 'progress=continue' || line === 'progress=end') {
      observe({ ...(frame === undefined ? {} : { frame }), ...(outTimeUs === undefined ? {} : { outTimeUs }), status: line === 'progress=end' ? 'end' : 'continue' });
      frame = outTimeUs = undefined;
    }
    line = '';
  };
  return (chunk: Buffer) => {
    // Pipe chunks are bounded by Node. Do not concatenate an unterminated log.
    const text = chunk.toString('utf8');
    for (let start = 0; start < text.length;) {
      const newline = text.indexOf('\n', start);
      const end = newline < 0 ? text.length : newline;
      if (!dropping) {
        if (line.length + end - start > maximumLineLength) { line = ''; dropping = true; }
        else line += text.slice(start, end);
      }
      if (newline < 0) return;
      if (!dropping) { if (line.endsWith('\r')) line = line.slice(0, -1); acceptLine(); }
      else { line = ''; dropping = false; }
      start = newline + 1;
    }
  };
}

/** Only observed process metadata crosses the boundary; output stays in its log. */
export class LocalProcessFailure extends Error {
  readonly code:LocalProcessFailureCode;
  readonly diagnosticPath:string;
  readonly child?:ObservedProcessExit;
  constructor(code:LocalProcessFailureCode,diagnosticPath:string,child?:ObservedProcessExit){
    super(code);this.name='LocalProcessFailure';this.code=code;this.diagnosticPath=diagnosticPath;this.child=child;
  }
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try { process.kill(-pid, signal); }
  catch (error) {
    // Darwin can report EPERM while an already-exiting group is being reaped.
    // This is not settlement: requireGroupSettled still demands observed ESRCH.
    if (!["ESRCH","EPERM"].includes((error as NodeJS.ErrnoException).code??"")) throw new Error("render:process_group_stop_failed");
  }
}

async function requireGroupSettled(pid: number | undefined) {
  if (!pid) return;
  const deadline = Date.now() + 5000;
  while (true) {
    try { process.kill(-pid, 0); }
    catch (error) {
      const code=(error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      // EPERM can occur during Darwin group teardown. As in the supervisor,
      // treat it as "still present", never settled. Keep the
      // bounded observation until ESRCH; persistent denial still fails below.
      if (code !== "EPERM") throw new Error("render:process_group_observation_failed");
    }
    if (Date.now() >= deadline) throw new Error("render:process_group_not_settled");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Child logs remain local; failures retain their exact log and observed exit.
 * Without activity this is a wall deadline; with activity it is an inactivity
 * budget. Retain the conservative budget: input decoding before a selected
 * source window can legitimately produce no output counters yet. */
export async function executeLocal(executable: string, args: string[], logPath: string, timeoutMs = 1_200_000, env?: NodeJS.ProcessEnv, signal?: AbortSignal, cwd?: string, activity?: LocalProcessActivity) {
  if (signal?.aborted) throw new Error("render:cancelled");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("render:invalid_timeout");
  const diagnosticPath=path.resolve(logPath);
  const log = await fs.open(diagnosticPath,"wx",0o600);
  const child = spawnOwnedStage(executable,args,{stdio:["ignore",activity?.ffmpeg ? "pipe" : log.fd,log.fd],env:env || {PATH:"/usr/bin:/bin",LANG:"en_US.UTF-8"},detached:true,...(cwd?{cwd}:{})});
  let timedOut = false;
  let cancelled = false;
  const terminate = () => signalGroup(child.pid, "SIGTERM");
  const kill = () => signalGroup(child.pid, "SIGKILL");
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) {
      stopping = (async () => { terminate(); await new Promise((resolve) => setTimeout(resolve, 3000)); kill(); })();
      // Preserve a stop error for the finally block without an unhandled rejection.
      void stopping.catch(() => {});
    }
  };
  const abort = () => { cancelled = true; stop(); };
  signal?.addEventListener("abort",abort,{once:true});
  if (signal?.aborted) abort();
  let finished = false;
  const timeout = () => { timedOut=true; stop(); };
  let timer = setTimeout(timeout,timeoutMs);
  const advance = () => {
    if (finished || timedOut || cancelled) return;
    clearTimeout(timer);
    timer = setTimeout(timeout,timeoutMs);
  };
  let maximumFrame = 0, maximumOutTimeUs = 0;
  if (activity?.ffmpeg) child.stdout!.on('data', ffmpegProgressReader(progress => {
    if (finished || timedOut || cancelled) return;
    const advanced = (progress.frame ?? 0) > maximumFrame || (progress.outTimeUs ?? 0) > maximumOutTimeUs;
    maximumFrame = Math.max(maximumFrame, progress.frame ?? 0);
    maximumOutTimeUs = Math.max(maximumOutTimeUs, progress.outTimeUs ?? 0);
    if (advanced) advance();
    // Reports are observation only. A reporter cannot break child custody or
    // turn a successful encoder into an unobserved process exception.
    if (advanced || progress.status === 'end') {
      try { activity.onProgress?.(progress); } catch { /* no child outcome inferred */ }
    }
  }));
  let polling = false, maximumActivity = 0;
  const poll = async () => {
    if (!activity?.read || polling || finished || timedOut || cancelled) return;
    polling = true;
    try {
      const value = await activity.read();
      if (!finished && !timedOut && !cancelled && typeof value === 'number' && Number.isFinite(value) && value > maximumActivity) {
        maximumActivity = value; advance();
      }
    } catch { /* A missing/partial progress file is not evidence of activity. */ }
    finally { polling = false; }
  };
  const pollTimer = activity?.read ? setInterval(() => { void poll(); }, Math.max(1, Math.min(500, timeoutMs / 4))) : undefined;
  if (activity?.read) void poll();
  const observedExit = await new Promise<ObservedProcessExit>((resolve,reject) => {
    child.once("error",() => reject(new LocalProcessFailure("render:local_process_launch_failed",diagnosticPath)));
    child.once("close",(exitCode,signal) => resolve({exitCode,signal}));
  }).finally(async () => {
    finished = true;
    clearTimeout(timer);
    clearInterval(pollTimer);
    signal?.removeEventListener("abort",abort);
    try {
      if (stopping) await stopping;
      // A worker can exit while its Chromium helpers remain. Settle the exact
      // already-owned group on success, failure and cancellation, not just PID.
      kill();
      await requireGroupSettled(child.pid);
      releaseOwnedStage(child.pid);
    } finally { await log.close(); }
  });
  if (cancelled) throw new LocalProcessFailure("render:cancelled",diagnosticPath,observedExit);
  if (timedOut) throw new LocalProcessFailure("render:local_process_timeout",diagnosticPath,observedExit);
  if (observedExit.exitCode !== 0) throw new LocalProcessFailure("render:local_process_failed",diagnosticPath,observedExit);
}

/** stdout belongs only to FFmpeg progress; exact diagnostic/loudnorm stderr
 * remains in logPath. File/null outputs only, never a stdout media output. */
export async function executeFfmpeg(executable: string, args: string[], logPath: string, timeoutMs = 1_200_000, env?: NodeJS.ProcessEnv, signal?: AbortSignal, cwd?: string, onProgress?: (progress: FfmpegProgress) => void) {
  await executeLocal(executable, ['-progress', 'pipe:1', '-nostats', ...args], logPath, timeoutMs, env, signal, cwd, { ffmpeg: true, onProgress });
}

export async function probeMedia(ffprobePath: string, mediaPath: string): Promise<MediaProbe> {
  return new Promise((resolve,reject) => {
    const child=spawn(ffprobePath,["-v","error","-show_streams","-show_format","-of","json",mediaPath],{stdio:["ignore","pipe","ignore"],env:{PATH:"/usr/bin:/bin"}});
    const timer=setTimeout(()=>child.kill("SIGKILL"),30000);
    let text="";
    child.stdout.on("data",(chunk:Buffer) => { text+=chunk.toString(); if(text.length>1_000_000) child.kill(); });
    child.once("error",()=>{clearTimeout(timer);reject(new Error("render:probe_launch_failed"));});
    child.once("close",(code) => {
      clearTimeout(timer);
      if(code!==0) return reject(new Error("render:probe_failed"));
      try { resolve(JSON.parse(text) as MediaProbe); } catch { reject(new Error("render:probe_invalid")); }
    });
  });
}

export function requireConformantVideo(probe: MediaProbe, frames: number) {
  const video=probe.streams.find((stream) => stream.codec_type==="video");
  if (!video || video.width!==1920 || video.height!==1080 || video.avg_frame_rate!=="60/1" || Number(video.nb_frames)!==frames) throw new Error("render:output_video_nonconformant");
  const start=Number(video.start_time),duration=Number(video.duration);
  if(!Number.isFinite(start)||!Number.isFinite(duration)||Math.abs(start)>1/90000||Math.abs(duration-frames/60)>1/90000)throw new Error('render:output_video_timing_nonconformant');
  return video;
}

export function requireConformantMaster(probe:MediaProbe,frames:number){
  const video=requireConformantVideo(probe,frames);
  if(video.codec_name!=='h264'||video.pix_fmt!=='yuv444p10le'||video.time_base!=='1/90000'
    ||video.color_space!=='bt709')throw new Error('render:master_video_nonconformant');
  if(!probe.format.format_name?.split(',').includes('mov')||probe.format.tags?.major_brand!=='qt  ')throw new Error('render:master_container_nonconformant');
  const audio=probe.streams.find(stream=>stream.codec_type==='audio');
  if(!audio||audio.codec_name!=='pcm_s16le'||audio.sample_rate!=='48000')throw new Error('render:master_audio_nonconformant');
  return {video,audio};
}

/** Decode only audio for measurement; no second master or picture render. */
export async function measureLoudness({ffmpegPath,mediaPath,logPath,signal}:{ffmpegPath:string;mediaPath:string;logPath:string;signal?:AbortSignal}) {
  await executeFfmpeg(ffmpegPath,["-hide_banner","-loglevel","info","-nostdin","-i",mediaPath,"-map","0:a:0","-vn","-af",loudnormFilter(),"-ar","48000","-f","null","-"],logPath,1_200_000,undefined,signal);
  return parseLoudnormReport(await fs.readFile(logPath,"utf8"));
}

function audioTiming(master: MediaStream, delivered: MediaStream, durationInFrames: number) {
  const masterStartSeconds=Number(master.start_time), deliveredStartSeconds=Number(delivered.start_time);
  const masterDurationSeconds=Number(master.duration), deliveredDurationSeconds=Number(delivered.duration);
  // AAC has 1024-sample packets. Container trimming may leave less than one
  // packet at the end; a shifted beginning or a longer tail is not accepted.
  const durationToleranceSeconds=1024/48000, startToleranceSeconds=1/48000;
  const passed=[masterStartSeconds,deliveredStartSeconds,masterDurationSeconds,deliveredDurationSeconds].every(Number.isFinite)
    && Math.abs(masterStartSeconds)<=startToleranceSeconds && Math.abs(deliveredStartSeconds-masterStartSeconds)<=startToleranceSeconds
    && Math.abs(masterDurationSeconds-durationInFrames/60)<=durationToleranceSeconds
    && Math.abs(deliveredDurationSeconds-masterDurationSeconds)<=durationToleranceSeconds;
  return {passed,masterStartSeconds,deliveredStartSeconds,masterDurationSeconds,deliveredDurationSeconds,startToleranceSeconds,durationToleranceSeconds};
}

export async function finishMedia({directory,masterPath,ffmpegPath,ffprobePath,durationInFrames,hasNarration,purpose,signal}:{directory:string;masterPath:string;ffmpegPath:string;ffprobePath:string;durationInFrames:number;hasNarration:boolean;purpose:'delivery'|'preview';signal?:AbortSignal}) {
  if (signal?.aborted) throw new Error("render:cancelled");
  if(purpose!=="delivery"&&purpose!=="preview")throw new Error("render:finishing_purpose_required");
  if (typeof hasNarration!=="boolean") throw new Error("render:narration_presence_required");
  const master=await probeMedia(ffprobePath,masterPath);
  const {audio:masterAudio}=requireConformantMaster(master,durationInFrames);
  // An editorial excerpt retains source gain. Its integrated loudness may not
  // be measurable, and normalizing each crop would change the listening level
  // with the chosen range. Only the full delivery is mastered and accepted.
  const normalizeNarration=purpose==="delivery"&&hasNarration;
  const inputLoudness=normalizeNarration?await measureLoudness({ffmpegPath,mediaPath:masterPath,logPath:path.join(directory,"finish-loudness-input.log"),signal}):null;
  const audioFilter=inputLoudness?deliveryLoudnormFilter(inputLoudness):null;
  const videoPath=path.join(directory,"walkthrough.mp4");
  await executeFfmpeg(ffmpegPath,["-hide_banner","-loglevel",normalizeNarration?"info":"warning","-nostdin","-n","-i",masterPath,"-map","0:v:0","-map","0:a:0","-c:v","libx264","-preset","slow","-crf","14","-profile:v","high","-pix_fmt","yuv420p","-fps_mode","passthrough","-colorspace","bt709","-color_primaries","bt709","-color_trc","bt709",...(audioFilter?["-af",audioFilter]:[]),"-c:a","aac","-b:a","192k","-ar","48000","-movflags","+faststart",videoPath],path.join(directory,"finish.log"),1_200_000,undefined,signal);
  const delivery=await probeMedia(ffprobePath,videoPath);
  const deliveryVideo=requireConformantVideo(delivery,durationInFrames);
  const deliveryAudio=delivery.streams.find((stream)=>stream.codec_type==="audio");
  if(deliveryVideo.codec_name!=="h264" || deliveryVideo.pix_fmt!=="yuv420p" || deliveryVideo.color_space!=="bt709" || deliveryAudio?.codec_name!=="aac" || deliveryAudio.sample_rate!=="48000") throw new Error("render:delivery_nonconformant");
  const timing=audioTiming(masterAudio,deliveryAudio,durationInFrames);
  const normalizationReport=normalizeNarration?parseLoudnormReport(await fs.readFile(path.join(directory,"finish.log"),"utf8")):null;
  const deliveredLoudness=normalizeNarration?(await measureLoudness({ffmpegPath,mediaPath:videoPath,logPath:path.join(directory,"finish-loudness-delivery.log"),signal})).input:null;
  const acceptance=deliveredLoudness?loudnessAcceptance(deliveredLoudness):null;
  const audioLoudness={status:purpose==="preview"?"not-evaluated-preview":acceptance?(acceptance.passed?"passed":"failed"):"skipped-silent",policy:LOUDNESS_POLICY,
    input:inputLoudness?.input??null,normalization:audioFilter?{passes:2,filter:audioFilter,report:normalizationReport}:null,delivered:deliveredLoudness,acceptance};
  const metrics={master,delivery,expectedFrames:durationInFrames,audioTiming:timing,audioLoudness,viewerAcceptance:"not-established",sourceCadenceAcceptance:"owned-by-capture-qualification"};
  await fs.writeFile(path.join(directory,"media-metrics.json"),JSON.stringify(metrics,null,2),{flag:"wx",mode:0o600});
  if(!timing.passed)throw new Error("render:delivery_audio_timing_nonconformant");
  if(acceptance&&!acceptance.passed)throw new Error("render:delivery_audio_loudness_nonconformant");
  const posterPath=path.join(directory,"poster.png");
  await executeFfmpeg(ffmpegPath,["-hide_banner","-loglevel","warning","-nostdin","-n","-ss",String(Math.min(1.2,(durationInFrames-1)/60)),"-i",videoPath,"-frames:v","1",posterPath],path.join(directory,"poster.log"),120_000,undefined,signal);
  return {videoPath,masterPath,posterPath,metrics};
}
