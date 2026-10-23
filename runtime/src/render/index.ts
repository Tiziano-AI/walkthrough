import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeFfmpeg, executeLocal, finishMedia, probeMedia } from "./media.ts";
import { validateTimeline, type Timeline } from "./timeline.ts";
import { verifyBrowserCustodyPatch } from "./browser-custody.ts";
import { verifyFrameTransportPatch } from "./frame-transport.ts";
import { verifyStreamingEncodingStrategy } from "./memory-admission.ts";
import { stageRenderSource } from "./source-staging.ts";
import { createRenderProgressWriter, readRenderWorkCounter } from "./progress.ts";
import { planRenderSources, type RenderSourceFile } from "./source-plan.ts";

export interface RenderWalkthroughOptions {
  timeline: Timeline;
  sourcePaths: Record<string, string>;
  /** A NEW directory inside the caller's run. Existing outputs are never overwritten. */
  directory: string;
  browserPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Inclusive absolute composition frames. Never rebase the picture/audio clock. */
  frameRange?: [number,number];
}

/** One local Remotion production lane. Caller owns authority, license eligibility and capture qualification. */
export async function renderWalkthrough(options: RenderWalkthroughOptions) {
  const metadata = validateTimeline(options.timeline);
  const frameRange=options.frameRange;
  if(frameRange&&(!frameRange.every(Number.isSafeInteger)||frameRange[0]<0||frameRange[1]<frameRange[0]||frameRange[1]>=metadata.durationInFrames))throw new Error('render:invalid_frame_range');
  const outputFrames=frameRange?frameRange[1]-frameRange[0]+1:metadata.durationInFrames;
  if (options.signal?.aborted) throw new Error("render:cancelled");
  await verifyBrowserCustodyPatch();
  await verifyFrameTransportPatch();
  await verifyStreamingEncodingStrategy();
  const sourceWindows = planRenderSources(options.timeline, frameRange);
  const usedSourceIds = Object.keys(sourceWindows);
  if (usedSourceIds.some(id => !Object.hasOwn(options.sourcePaths,id))) throw new Error("render:source_path_missing");
  for (const file of [...usedSourceIds.map(id => options.sourcePaths[id]), options.browserPath, options.ffmpegPath, options.ffprobePath]) {
    if (!path.isAbsolute(file) || !(await fs.stat(file)).isFile()) throw new Error("render:dependency_not_provisioned");
  }
  if (!path.isAbsolute(options.directory)) throw new Error("render:absolute_output_required");
  if (process.platform !== "darwin") throw new Error("render:local_network_boundary_unavailable");
  for (const id of usedSourceIds) {
    const source = await probeMedia(options.ffprobePath, options.sourcePaths[id]);
    const video = source.streams.find(stream => stream.codec_type === "video");
    if (!video || video.width !== options.timeline.sourceWidth || video.height !== options.timeline.sourceHeight) throw new Error("render:source_nonconformant");
    // Capture owns cadence qualification; average VFR rate is not a verdict.
    const sourceDuration = Number(video.duration ?? source.format.duration);
    const windows = sourceWindows[id].windows;
    if (!Number.isFinite(sourceDuration) || windows.some(window => (window.sourceStartFrame + window.frameCount) / 60 > Number(video.start_time ?? 0) + sourceDuration + 0.001)) throw new Error("render:source_trim_out_of_bounds");
  }
  const audioFiles: Record<string, string> = {};
  for (const [index, segment] of options.timeline.narration.entries()) {
    if (!segment.wavPath || !path.isAbsolute(segment.wavPath)) throw new Error("render:beat_audio_missing");
    const audio = await probeMedia(options.ffprobePath, segment.wavPath);
    const stream = audio.streams.find((item) => item.codec_type === "audio");
    const duration = Number(audio.format.duration ?? stream?.duration);
    if (!stream || !stream.codec_name?.startsWith("pcm_") || !Number.isFinite(duration) || duration <= 0 || duration > segment.durationSeconds + 1 / 60) throw new Error("render:beat_audio_nonconformant");
    audioFiles[segment.id] = `beat-${index}.wav`;
  }
  await fs.mkdir(options.directory, { recursive: false, mode: 0o700 });
  const progress = createRenderProgressWriter(options.directory);
  progress.record({phase:'staging-sources'});await progress.flush();
  const publicDirectory = path.join(options.directory, "assets");
  await fs.mkdir(publicDirectory, { mode: 0o700 });
  const sourceFiles: Record<string,RenderSourceFile> = {};
  const sourceStaging: Record<string, Awaited<ReturnType<typeof stageRenderSource>>> = {};
  for (const [index,id] of usedSourceIds.entries()) {
    sourceFiles[id] = { file: `source-${index}.mp4`, windows: sourceWindows[id].windows };
    progress.record({phase:'staging-sources',source:{index:index+1,total:usedSourceIds.length,stagedFrames:0,selectedFrames:sourceWindows[id].frameCount}});
    sourceStaging[id] = await stageRenderSource({ ...sourceWindows[id], sourcePath: options.sourcePaths[id], outputPath: path.join(publicDirectory,sourceFiles[id].file),
      logPath: path.join(options.directory,`source-${index}.log`), ffmpegPath: options.ffmpegPath, ffprobePath: options.ffprobePath,
      signal: options.signal, timeoutMs: options.timeoutMs,
      onProgress: update => progress.record({phase:'staging-sources',source:{index:index+1,total:usedSourceIds.length,stagedFrames:Math.min(sourceWindows[id].frameCount,update.frame ?? 0),selectedFrames:sourceWindows[id].frameCount}}) });
  }
  await fs.writeFile(path.join(options.directory,"source-staging.json"),JSON.stringify({schemaVersion:3,sources:sourceStaging},null,2),{flag:"wx",mode:0o600});
  progress.record({phase:'staging-audio'});await progress.flush();
  for (const [index, segment] of options.timeline.narration.entries()) await executeFfmpeg(options.ffmpegPath,
    ["-hide_banner", "-loglevel", "warning", "-nostdin", "-n", "-i", segment.wavPath!, "-map", "0:a:0", "-c:a", "pcm_s16le", "-ar", "48000", path.join(publicDirectory, audioFiles[segment.id])],
    path.join(options.directory, `audio-${index}.log`), 120_000, undefined, options.signal);
  const timeline = { ...options.timeline, narration: options.timeline.narration.map(({ wavPath: _wavPath, ...narration }) => narration) };
  const configPath = path.join(options.directory, "render-input.json");
  await fs.writeFile(configPath, JSON.stringify({ directory: options.directory, publicDirectory, browserPath: options.browserPath,...(frameRange?{frameRange}:{}), inputProps: { presentation: 'full-frame-visible-captions', timeline, sourceFiles, audioFiles,...(frameRange?{frameRange}:{}) } }, null, 2), { flag: "wx", mode: 0o600 });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  // Public production already inherits this OS profile. Standalone diagnostics
  // apply it once here; nesting the same profile adds no containment.
  const workerArgs=[path.join(root, "src/render/worker.ts"),configPath];
  const supervised=process.env.WALKTHROUGH_STAGE_CUSTODY==='fd3-v1';
  await executeLocal(supervised?process.execPath:"/usr/bin/sandbox-exec", supervised?workerArgs:["-f", path.join(root, "scripts/loopback-only.sb"), process.execPath,...workerArgs], path.join(options.directory, "renderer.log"), options.timeoutMs ?? 7_200_000,
    { PATH: "/usr/bin:/bin", HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: "en_US.UTF-8", PUPPETEER_SKIP_DOWNLOAD: "true", REMOTION_BROWSER_EXECUTABLE: options.browserPath }, options.signal, root,
    {read:()=>readRenderWorkCounter(options.directory)});
  progress.record({phase:'finishing-media'});await progress.flush();
  const hasNarration=options.timeline.narration.some(phrase=>!frameRange||(phrase.outputStartSeconds*60<=frameRange[1]&&(phrase.outputStartSeconds+phrase.durationSeconds)*60>frameRange[0]));
  return finishMedia({ directory: options.directory, masterPath: path.join(options.directory, "master.mov"), ffmpegPath: options.ffmpegPath, ffprobePath: options.ffprobePath, durationInFrames: outputFrames, hasNarration, purpose: frameRange ? 'preview' : 'delivery', signal: options.signal });
}
