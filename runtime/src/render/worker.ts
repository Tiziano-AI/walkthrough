import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import type { FfmpegOverrideFn, OnStartData } from "@remotion/renderer";
import type { CompositionProps } from "./composition.ts";
import { enableBrowserGroupCustody, loadCustodiedRenderer } from "./browser-custody.ts";
import { verifyFrameTransportPatch } from "./frame-transport.ts";
import { verifyStreamingEncodingStrategy, requireStreamingMemory } from "./memory-admission.ts";
import { createRenderProgressWriter, remotionProgress } from "./progress.ts";

/** Remotion chooses .mkv for its H.264/PCM intermediate even when the final
 * output is MOV. Preserve its exact path, but retain the 90 kHz picture clock
 * in a MOV container rather than quantizing 60 fps timestamps in Matroska. */
export const masterFfmpegOverride:FfmpegOverrideFn=({type,args})=>{
  const output=args.at(-1);
  if(!output||output.startsWith('-'))throw new Error('render:master_ffmpeg_output_missing');
  const timescale=args.indexOf('-video_track_timescale');
  if(timescale>=0&&args[timescale+1]!=='90000')throw new Error('render:master_ffmpeg_clock_changed');
  if(type==='pre-stitcher'){
    if(timescale<0)throw new Error('render:master_ffmpeg_clock_missing');
    return [...args.slice(0,-1),'-f','mov',output];
  }
  return timescale<0?[...args.slice(0,-1),'-video_track_timescale','90000',output]:args;
};

export function requireStreamingEncoding({parallelEncoding}:Pick<OnStartData,'parallelEncoding'>){
  // Codec/encoder support can disable parallel encoding. onStart runs before
  // the frame loop: refuse that all-frame PNG spool, never fall back.
  if(parallelEncoding!==true){
    // Remotion has already begun creating its page pool. Its cleanup may emit
    // a secondary Target closed rejection, so retain the refusal first.
    process.stderr.write('render:streaming_encoding_required\n');
    throw new Error('render:streaming_encoding_required');
  }
}

export function masterRenderOptions(directory:string){
  return {outputLocation:path.join(directory,'master.mov'),codec:'h264' as const,crf:1,
    pixelFormat:'yuv444p10le' as const,imageFormat:'png' as const,colorSpace:'bt709' as const,
    audioCodec:'pcm-16' as const,sampleRate:48000,enforceAudioTrack:true,concurrency:1,
    overwrite:false,hardwareAcceleration:'disable' as const,repro:false,disallowParallelEncoding:false,
    onStart:requireStreamingEncoding,ffmpegOverride:masterFfmpegOverride};
}

type WorkerConfig={
  directory: string; publicDirectory: string; browserPath: string; inputProps: CompositionProps;frameRange?:[number,number];
};

async function runWorker(configPath:string){
  // Invoked only by renderWalkthrough in a network-contained process group.
  await verifyFrameTransportPatch();
  await verifyStreamingEncodingStrategy();
  const { selectComposition, renderMedia } = await loadCustodiedRenderer();
  // executeLocal creates this worker's private process group before executing it.
  // The patched launch owner joins Chromium to that group before readiness awaits.
  await enableBrowserGroupCustody();
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as WorkerConfig;
  const progress = createRenderProgressWriter(config.directory);
  progress.record({phase:'bundling-renderer'});await progress.flush();
  const serveUrl = await bundle({ entryPoint: path.join(path.dirname(fileURLToPath(import.meta.url)), "composition.ts"), outDir: path.join(config.directory, "bundle"), publicDir: config.publicDirectory, enableCaching: false, gitSource: null });
  // Remotion records failed-resource errorText/status at warn. Keep that cause
  // in renderer.log rather than only OffthreadVideo's generic fetch error.
  const common = { serveUrl, browserExecutable: config.browserPath, inputProps: config.inputProps, chromeMode: "chrome-for-testing" as const, logLevel: "warn" as const,
    onBrowserDownload: () => { throw new Error("render:browser_download_forbidden"); }, offthreadVideoThreads: 1 };
  progress.record({phase:'selecting-composition'});await progress.flush();
  const composition = await selectComposition({ ...common, id: "Walkthrough" });
  // Upstream no longer performs capacity admission. Keep the strict reserve
  // before native encoding starts; executeLocal still owns all failure cleanup.
  requireStreamingMemory(composition.width, composition.height);
  const outputFrames=config.frameRange?config.frameRange[1]-config.frameRange[0]+1:composition.durationInFrames;
  progress.record({phase:'rendering-and-encoding',frames:{rendered:0,total:outputFrames}});await progress.flush();
  try{
    await renderMedia({ ...common,...masterRenderOptions(config.directory),composition,...(config.frameRange?{frameRange:config.frameRange}:{}),
      onProgress: observation => progress.record(remotionProgress(observation,outputFrames)) });
  }finally{await progress.flush();}
}

if(import.meta.main)await runWorker(process.argv[2]);
