import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { executeFfmpeg, probeMedia, type MediaStream, type FfmpegProgress } from "./media.ts";
import { OUTPUT_FPS } from "./timeline.ts";
import type { RenderSourcePlan } from "./source-plan.ts";

async function digest(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

type TimedVideo = MediaStream & { start_time?: string; color_range?: string };

const colorFields = {color_range: "-color_range", color_space: "-colorspace", color_primaries: "-color_primaries", color_transfer: "-color_trc"} as const;
const pixelLayout = (format: string | undefined) => format?.replace(/^yuvj/, "yuv");

/**
 * Remotion's frame extractor may choose a VFR successor before its PTS. Give
 * it an exact output-rate grid instead: a decoded sample first appears at the
 * first grid point at or after its timestamp, then holds until its successor.
 * Resample on the original clock before selecting its integer frame windows.
 * Decode from the origin so a predecessor held across the window survives;
 * selected intervals alone are packed onto a zero-based grid. This is a lossless render
 * derivative, not new capture-cadence evidence.
 */
export async function stageRenderSource(options: {
  sourcePath: string;
  outputPath: string;
  logPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: FfmpegProgress) => void;
} & RenderSourcePlan) {
  if (options.signal?.aborted) throw new Error("render:cancelled");
  const { windows, frameCount } = options;
  let expectedOffset = 0, previousEnd = -1;
  for (const window of windows) {
    if (!Number.isSafeInteger(window.sourceStartFrame) || window.sourceStartFrame < 0 || !Number.isSafeInteger(window.frameCount) || window.frameCount <= 0
      || !Number.isSafeInteger(window.sourceStartFrame + window.frameCount) || window.sourceStartFrame <= previousEnd || window.stagedStartFrame !== expectedOffset) throw new Error("render:source_staging_invalid_window");
    previousEnd = window.sourceStartFrame + window.frameCount;
    expectedOffset += window.frameCount;
  }
  if (!windows.length || !Number.isSafeInteger(frameCount) || frameCount !== expectedOffset) throw new Error("render:source_staging_invalid_window");
  try {
    await lstat(options.outputPath);
    throw new Error("render:source_staging_output_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const source = await probeMedia(options.ffprobePath, options.sourcePath);
  const video = source.streams.find(stream => stream.codec_type === "video") as TimedVideo | undefined;
  if (!video?.pix_fmt || !video.width || !video.height) throw new Error("render:source_staging_nonconformant");
  const sourceSha256 = await digest(options.sourcePath);
  // fps gives PTS the 1/OUTPUT_FPS time base. Trim by absolute PTS, not by
  // decoded frame index, which would shift sources with a nonzero origin.
  const selection = windows.map(window => `between(pts,${window.sourceStartFrame},${window.sourceStartFrame + window.frameCount - 1})`).join('+');
  const filter = `fps=${OUTPUT_FPS}:round=up,trim=start_pts=${windows[0].sourceStartFrame}:end_pts=${previousEnd},select='${selection}',setpts=N`;
  const colorArguments = Object.entries(colorFields).flatMap(([key, flag]) => {
    const value = video[key as keyof typeof colorFields];
    return value && value !== "unknown" ? [flag, value] : [];
  });
  await executeFfmpeg(options.ffmpegPath, [
    // Read the same native clock as capture qualification, without inventing
    // timestamps for zero-duration startup samples before causal resampling.
    "-hide_banner", "-loglevel", "warning", "-nostdin", "-n", "-copyts", "-fflags", "+nofillin", "-i", options.sourcePath,
    "-map", "0:v:0", "-an", "-vf", filter, "-frames:v", String(frameCount), "-fps_mode", "passthrough",
    "-c:v", "libx264", "-preset", "veryfast", "-qp", "0", "-bf", "0",
    // '+' rejects automatic pixel-format conversion rather than making a lossy
    // derivative when the installed encoder cannot preserve the source format.
    "-pix_fmt", `+${video.pix_fmt}`, "-enc_time_base", `1:${OUTPUT_FPS}`,
    ...colorArguments,
    "-video_track_timescale", "60000", "-movie_timescale", "60000",
    "-avoid_negative_ts", "disabled", "-movflags", "+faststart", options.outputPath
  ], options.logPath, options.timeoutMs ?? 1_200_000, undefined, options.signal, undefined, options.onProgress);
  const staged = await probeMedia(options.ffprobePath, options.outputPath);
  const output = staged.streams.find(stream => stream.codec_type === "video") as TimedVideo | undefined;
  // FFmpeg reports full-range H.264 as yuvj420p even when an AV1 decoder reports
  // the same layout as yuv420p + pc. Accept that alias only with equal range.
  const samePixels = output && pixelLayout(output.pix_fmt) === pixelLayout(video.pix_fmt)
    && (output.pix_fmt === video.pix_fmt || output.color_range === "pc" && video.color_range === "pc");
  const sameColors = output && Object.keys(colorFields).every(key => {
    const field = key as keyof typeof colorFields;
    return !video[field] || video[field] === "unknown" || output[field] === video[field];
  });
  if (!output || output.codec_name !== "h264" || !samePixels || !sameColors || output.width !== video.width || output.height !== video.height || output.avg_frame_rate !== `${OUTPUT_FPS}/1`
    || Number(output.start_time) !== 0 || Number(output.nb_frames) !== frameCount) {
    throw new Error("render:source_staging_nonconformant");
  }
  if (await digest(options.sourcePath) !== sourceSha256) throw new Error("render:source_changed_during_staging");
  return {
    sourceSha256,
    stagedSha256: await digest(options.outputPath),
    method: "causal-sample-and-hold" as const,
    filter,
    codec: "h264-lossless" as const,
    pixelFormat: video.pix_fmt,
    stagedPixelFormat: output.pix_fmt,
    color: Object.fromEntries(Object.keys(colorFields).map(key => [key, video[key as keyof typeof colorFields] ?? null])),
    width: video.width,
    height: video.height,
    timestampOrigin: "source-clock-selected-and-packed" as const,
    sourceStartSeconds: Number(video.start_time ?? 0),
    windows,
    frameCount: Number(output.nb_frames),
    stagedStartSeconds: Number(output.start_time ?? 0),
    outputFps: OUTPUT_FPS,
    sourceCadenceAcceptance: "owned-by-capture-qualification" as const
  };
}
