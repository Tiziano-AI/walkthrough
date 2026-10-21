import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {writeFile,readFile,lstat,link,rename,unlink} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {Page} from 'playwright';
import {asCaptureSurface,type CaptureSurface,type SlateCover} from './surface.ts';
import {Failure,type LocalTools} from '../core/contracts.ts';

type Anchor={beforeMs:number;afterMs:number};
const maximumClockErrorSeconds=0.05;
// The opening bracket alone can already make final calibration impossible.
// Keep its early rejection and the two-anchor final check on the same formula.
const clockUncertaintySeconds=(...anchors:Anchor[])=>Math.max(...anchors.map(anchor=>anchor.afterMs-anchor.beforeMs))/2000+1/60;
type StartClockFailure={start:Anchor;minimumUncertaintySeconds:number};
export type CaptureMap={sourcePath:string;width:number;height:number;durationSeconds:number;offsetSeconds:number;uncertaintySeconds:number;driftSeconds:number;frameCount:number;usableRasterRange:{startSeconds:number;endSeconds:number}};
type CalibrationSample={mean:number;min:number;max:number};
type AnalysisOptions={signal?:AbortSignal};
type TakeAnalysisOptions=AnalysisOptions&{diagnosticsPath?:string};

/** A new recovery attempt must not replace prior diagnostics. Default analysis
 * can replace its regular canonical file, atomically rather than truncating it.
 * Neither path follows an output symlink, including one created during a race. */
async function saveDiagnostics(path:string,diagnostics:unknown,{signal,diagnosticsPath}:TakeAnalysisOptions){
  const existing=await lstat(path).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;});
  if(existing&&!existing.isFile())throw new Failure('CAPTURE_ANALYSIS_PATH_INVALID','capture','Capture diagnostics must be a regular file, never a symlink or directory. Choose an unused recovery analysis path.');
  if(existing&&diagnosticsPath!==undefined)throw new Failure('CAPTURE_ANALYSIS_EXISTS','capture','The requested analysis path already exists. Preserve that attempt and choose a new diagnostics path.');
  const temporary=join(dirname(path),`.${basename(path)}.${randomUUID()}.tmp`);
  try{
    await writeFile(temporary,JSON.stringify(diagnostics,null,2),{mode:0o600,flag:'wx',signal});
    if(signal?.aborted)throw new Failure('CAPTURE_ABORTED','capture','Capture analysis was cancelled; the retained source is unchanged.');
    // link publishes a complete new file exclusively; rename replaces the
    // canonical directory entry without opening an existing target for writes.
    if(diagnosticsPath!==undefined)await link(temporary,path);
    else await rename(temporary,path);
  }catch(error){
    if(signal?.aborted)throw new Failure('CAPTURE_ABORTED','capture','Capture analysis was cancelled; the retained source is unchanged.');
    if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Failure('CAPTURE_ANALYSIS_EXISTS','capture','The requested analysis path appeared during analysis. Preserve that attempt and choose a new diagnostics path.');
    throw error;
  }finally{
    await unlink(temporary).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;});
  }
}

/** Drain both pipes while retaining only a bounded diagnostic tail. A capture's
 * size must not become a subprocess buffer limit, and cancellation is not
 * complete until the child has closed its pipes and exited. */
async function readTool(path:string,args:string[],consume:(chunk:Buffer)=>void,code:string,{signal}:AnalysisOptions={}){
  if(signal?.aborted)throw new Failure('CAPTURE_ABORTED','capture','Capture analysis was cancelled; the retained source is unchanged.');
  const child=spawn(path,args,{stdio:['ignore','pipe','pipe']});
  let stderr=Buffer.alloc(0),stderrBytes=0,error:unknown;
  let killing:ReturnType<typeof setTimeout>|undefined;
  const fail=(cause:unknown)=>{
    if(error)return;
    error=cause;
    child.kill('SIGTERM');
    killing=setTimeout(()=>child.kill('SIGKILL'),1000);
    killing.unref();
  };
  const abort=()=>fail(new Failure('CAPTURE_ABORTED','capture','Capture analysis was cancelled; the retained source is unchanged.'));
  const closed=new Promise<void>((resolve,reject)=>{
    child.once('error',cause=>{error??=cause;});
    child.stdout.on('data',(chunk:Buffer)=>{if(!error)try{consume(chunk);}catch(cause){fail(cause);}});
    child.stderr.on('data',(chunk:Buffer)=>{
      stderrBytes+=chunk.length;
      stderr=Buffer.concat([stderr,chunk]).subarray(-16*1024);
    });
    child.once('close',(status,exitSignal)=>{
      if(killing)clearTimeout(killing);
      signal?.removeEventListener('abort',abort);
      if(error){reject(error);return;}
      if(status!==0){
        const prefix=stderrBytes>stderr.length?`[${stderrBytes-stderr.length} earlier stderr bytes omitted] `:'';
        reject(new Failure(code,'capture',`The media tool exited with ${exitSignal??status}. Inspect the retained source. ${prefix}${stderr.toString('utf8')}`.trim()));
      }else resolve();
    });
  });
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  await closed;
}

/** Metadata is small; frame timestamps are read incrementally instead of
 * collecting ffprobe's full JSON in a fixed-size child-process buffer. */
async function probeCapture(ffprobePath:string,sourcePath:string,options:AnalysisOptions){
  const metadata:Buffer[]=[];let bytes=0;
  await readTool(ffprobePath,['-v','error','-select_streams','v:0','-show_streams','-of','json',sourcePath],chunk=>{
    bytes+=chunk.length;
    if(bytes>1024*1024)throw new Failure('CAPTURE_PROBE_FAILED','capture','Video stream metadata exceeded 1 MiB; inspect the retained source.');
    metadata.push(chunk);
  },'CAPTURE_PROBE_FAILED',options);
  const probe=JSON.parse(Buffer.concat(metadata).toString('utf8'));
  const frames:Array<{best_effort_timestamp_time:string}>=[];
  let pending='';
  const line=(value:string)=>{
    if(!value.trim())return;
    if(value.length>1024)throw new Failure('CAPTURE_TIMESTAMPS_INVALID','capture','The frame probe returned an oversized timestamp record; inspect the retained source.');
    const match=/^best_effort_timestamp_time=(\S+)$/.exec(value.trim());
    if(!match)throw new Failure('CAPTURE_TIMESTAMPS_INVALID','capture','The frame probe returned an unexpected timestamp record; inspect the retained source.');
    frames.push({best_effort_timestamp_time:match[1]});
  };
  // Zero-duration startup samples have equal native PTS. Demux fill-in can
  // invent increasing timestamps for them, followed by a false backwards jump.
  await readTool(ffprobePath,['-v','error','-fflags','+nofillin','-select_streams','v:0','-show_entries','frame=best_effort_timestamp_time:frame_side_data=','-of','default=noprint_wrappers=1:nokey=0',sourcePath],chunk=>{
    pending+=chunk.toString('utf8');
    let newline:number;
    while((newline=pending.indexOf('\n'))>=0){line(pending.slice(0,newline));pending=pending.slice(newline+1);}
    if(pending.length>1024)throw new Failure('CAPTURE_TIMESTAMPS_INVALID','capture','The frame probe returned an oversized timestamp record; inspect the retained source.');
  },'CAPTURE_PROBE_FAILED',options);
  line(pending);
  return {...probe,frames};
}

/** Each authored slate holds white and then returns to black for 250ms each.
 * The initial black cover protects privacy but its startup PTS extent may be
 * compressed. Qualify both later holds before using the white transition:
 * Chromium's zero-PTS flush samples are not an authored slate. */
export function calibrationMarkers(pixels:ArrayLike<number>,pts:number[]){
  const starts:number[]=[];
  for(let i=1;i<pixels.length;i++){
    if(pixels[i]<253||pixels[i-1]>5)continue;
    let black=i+1;
    while(black<pixels.length&&pixels[black]>=253)black++;
    if(black===pixels.length||pixels[black]>5)continue;
    let after=black+1;
    while(after<pixels.length&&pixels[after]<=5)after++;
    // A final black sample has no inferred duration: a later measured PTS
    // must establish the return hold, even when recording ends on black.
    const blackThrough=Math.min(after,pixels.length-1);
    if(pts[black]-pts[i]>=0.15&&pts[blackThrough]-pts[black]>=0.15)starts.push(i);
  }
  return starts;
}

/** The clock's input bracket can precede the first revealed product raster.
 * Bound usable footage with observed cover transitions instead: retain no
 * opening gray frame and stop before the ending black cover starts. */
function usableRasterRange(samples:CalibrationSample[],pts:number[],markers:number[]){
  const white=(i:number)=>samples[i]?.min>=253;
  const black=(i:number)=>samples[i]?.max<=5;
  // The authored #777 cover decodes to 119. Allow small codec roundoff across
  // the whole raster, never classify a gray average as an opaque cover.
  const gray=(i:number)=>samples[i]?.min>=117&&samples[i]?.max<=121;
  let startFrame=markers[0];
  while(white(startFrame))startFrame++;
  while(black(startFrame))startFrame++;
  if(!gray(startFrame))throw new Failure('CAPTURE_USABLE_RANGE_INVALID','capture','The opening slate needs its observed opaque gray cover before the first product raster can be bounded.');
  while(gray(startFrame))startFrame++;
  const endingMarker=markers[1];
  // The end boundary precedes the closing slate. Its measured return-black
  // hold already qualifies the clock marker; gray is an additional witness,
  // not a required frame after it. A recorder may finish on repeated black
  // before including the requested gray paint. Never infer that missing frame
  // or admit a tail that reveals product content again.
  let afterEndingCover=endingMarker;
  while(white(afterEndingCover))afterEndingCover++;
  while(black(afterEndingCover))afterEndingCover++;
  while(gray(afterEndingCover))afterEndingCover++;
  let endFrame=endingMarker;
  while(black(endFrame-1))endFrame--;
  if(afterEndingCover!==samples.length||startFrame>=endFrame||!(pts[startFrame]<pts[endFrame]))throw new Failure('CAPTURE_USABLE_RANGE_INVALID','capture','The source must reveal distinguishable product footage after the opening gray cover and remain covered after the closing slate; do not guess missing raster boundaries.');
  return {startSeconds:pts[startFrame],endSeconds:pts[endFrame]};
}

/** A slate covers the entire raster. Its spatial samples must all be white or
 * black: a mean alone mistakes a sparse, mostly-white application for a slate.
 * Retain extrema and the mean so a rejection can be diagnosed offline. */
export async function decodeCalibrationFrames(ffmpegPath:string,sourcePath:string,frameCount:number,options:AnalysisOptions={}){
  const sampleSize=32*18;
  if(!Number.isSafeInteger(frameCount)||frameCount<1)throw new Failure('CAPTURE_TIMESTAMPS_INVALID','capture','At least one original frame timestamp is required.');
  const frames:CalibrationSample[]=[];
  let bytes=0,position=0,sum=0,min=255,max=0;
  // Preserve the input time base as well as its VFR cadence. The default raw
  // encoder time base quantizes distinct input PTS to the guessed frame rate,
  // producing repeated-DTS warnings even with fps_mode=passthrough. With a
  // synchronous decoder those warnings shared and exhausted the pixel buffer.
  await readTool(ffmpegPath,['-v','error','-nostdin','-fflags','+nofillin','-i',sourcePath,'-map','0:v:0','-vf','scale=32:18:flags=area','-fps_mode','passthrough','-enc_time_base','demux','-f','rawvideo','-pix_fmt','gray','pipe:1'],chunk=>{
    bytes+=chunk.length;
    for(const value of chunk){
      sum+=value;min=Math.min(min,value);max=Math.max(max,value);
      if(++position===sampleSize){
        // Drain surplus output too, but never retain more samples than the
        // independently probed count. Report the exact mismatch on completion.
        if(frames.length<frameCount)frames.push({mean:sum/sampleSize,min,max});
        position=0;sum=0;min=255;max=0;
      }
    }
  },'CAPTURE_DECODE_FAILED',options);
  if(bytes!==frameCount*sampleSize)throw new Failure('CAPTURE_TIMESTAMPS_INVALID','capture',`Decoded luminance frames must match the original frame timestamps: expected ${frameCount} frames (${frameCount*sampleSize} bytes), received ${Math.floor(bytes/sampleSize)} complete frames and ${bytes%sampleSize} trailing bytes (${bytes} bytes).`);
  return frames;
}

async function slate(overlay:SlateCover):Promise<Anchor>{
  await delay(250);
  const beforeMs=performance.now();
  await overlay.color('#fff');
  const afterMs=performance.now();
  await delay(250);
  await overlay.color('#000');
  await delay(250);
  // Request a distinct opaque sample to witness the black hold's extent.
  // Completion of this paint is not recording acknowledgement: final analysis
  // accepts either recorded gray or measured repeated black through EOF.
  await overlay.color('#777');
  return {beforeMs,afterMs};
}

/** Calibration slates surround, but are excluded from, the product edit. The
 * Node bracket is not presented as a compositor timestamp. Decoded marker PTS
 * anchors the mapping, and the independent ending anchor checks drift. */
export async function beginTake(source:Page|CaptureSurface,policy:LocalTools,directory:string){
  const surface=asCaptureSurface(source);
  // Cover and paint before the first recorder command: even its startup frames
  // must contain the slate, never the live form beneath it.
  let overlay=await surface.cover();
  const sourcePath=join(directory,'source.mp4');
  const recording=await surface.startRecording(sourcePath);
  // One command owns settlement, including its uncertain failure. Calling
  // abort again waits for that same result; it never retries a CDP stop.
  let stopping:ReturnType<typeof recording.stop>|undefined;
  const stop=()=>stopping??=Promise.resolve().then(()=>recording.stop());
  const failAndStop=async(error:unknown,startFailure?:StartClockFailure):Promise<never>=>{
    const errors=[error];let stopped=false,timing:Awaited<ReturnType<typeof stop>>|undefined;
    try{timing=await stop();stopped=true;}
    catch(stopError){errors.push(stopError);}
    if(startFailure)try{
      // A rejected start has no ending anchor or accepted map. Retain its
      // measured evidence separately, including an uncertain stop honestly.
      await writeFile(join(directory,'capture-start-failure.json'),JSON.stringify({
        ...startFailure,maximumUncertaintySeconds:maximumClockErrorSeconds,
        recorderSettlement:stopped?'stopped':'uncertain',
        timing:timing??{requestedStartIntervalMs:recording.requestedStartIntervalMs},
      },null,2),{mode:0o600,flag:'wx'});
    }catch(diagnosticError){errors.push(diagnosticError);}
    if(stopped)try{await overlay.remove();}catch(cleanupError){errors.push(cleanupError);}
    if(errors.length>1)throw new AggregateError(errors,'CAPTURE_CLEANUP_FAILED');
    throw error;
  };
  let start:Anchor,startFailure:StartClockFailure|undefined;
  try{
    start=await slate(overlay);
    const minimumUncertaintySeconds=clockUncertaintySeconds(start);
    if(minimumUncertaintySeconds>maximumClockErrorSeconds){
      startFailure={start,minimumUncertaintySeconds};
      throw new Failure('CAPTURE_CLOCK_UNCERTAIN','capture','The opening paint bracket already exceeds the final 50ms source-clock uncertainty limit. Inspect capture-start-failure.json and the retained source. No take was opened for authoring and no new capture starts automatically.');
    }
    await overlay.remove();
  }catch(error){return failAndStop(error,startFailure);}
  let ended=false;
  let aborted=false;
  let finishing=false;
  const controller=new AbortController();
  let analysis:Promise<CaptureMap>|undefined;
  return {sourcePath,async abort(){
    ended=true;aborted=true;controller.abort();await stop();
    // The recorder's settlement does not settle a decoder started by finish.
    // Drain that owned child too, without replacing finish's analysis result.
    await analysis?.catch(()=>{});
    if(!finishing)await overlay.remove();
  },async finish(){
    if(ended)throw new Failure('CAPTURE_ALREADY_STOPPED','capture','Do not reuse a completed capture handle.');
    ended=true;finishing=true;
    let end:Anchor;
    try{
      overlay=await surface.cover();
      end=await slate(overlay);
      if(aborted)throw new Failure('CAPTURE_ABORTED','capture','The take was aborted before its ending calibration completed.');
    }catch(error){return failAndStop(error);}
    const timing=await stop();
    await overlay.remove();
    if(aborted)throw new Failure('CAPTURE_ABORTED','capture','The take was aborted while the recorder was stopping.');
    await writeFile(join(directory,'capture-clock.json'),JSON.stringify({start,end,timing},null,2),{mode:0o600});
    analysis=analyzeTake(policy,directory,{signal:controller.signal});
    const map=await analysis;
    if(aborted)throw new Failure('CAPTURE_ABORTED','capture','The take was aborted before calibration was accepted.');
    return map;
  }};
}

/** Reanalysis consumes the same retained capture; it never replays the fixture.
 * An explicit diagnosticsPath creates a new, exclusive attempt instead of
 * replacing the canonical capture-analysis.json. */
export async function analyzeTake(policy:LocalTools,directory:string,options:TakeAnalysisOptions={}):Promise<CaptureMap>{
    const sourcePath=join(directory,'source.mp4');
    const {start,end}=JSON.parse(await readFile(join(directory,'capture-clock.json'),'utf8')) as {start:Anchor;end:Anchor};
    const probe=await probeCapture(policy.ffprobePath,sourcePath,options);
    const stream=probe.streams?.[0];
    if(stream?.width!==3200 || stream?.height!==1800)throw new Failure('CAPTURE_GEOMETRY_FAILED','capture','The native master must be3200×1800; no upscaling substitute.');
    const pts:number[]=probe.frames.map((f:any)=>Number(f.best_effort_timestamp_time));
    const invalidFrame=pts.findIndex((t,i)=>!Number.isFinite(t)||(i>0 && t<pts[i-1]));
    if(invalidFrame!==-1)throw new Failure('CAPTURE_TIMESTAMPS_INVALID','capture',`Invalid native timestamp at frame ${invalidFrame} (zero-based): current=${JSON.stringify(probe.frames[invalidFrame].best_effort_timestamp_time)}; previous=${invalidFrame?JSON.stringify(probe.frames[invalidFrame-1].best_effort_timestamp_time):'<none>'}. Original timestamps must be finite and nondecreasing; inspect the retained source before any frame-rate conversion.`);
    const samples=await decodeCalibrationFrames(policy.ffmpegPath,sourcePath,pts.length,options);
    const pixels=samples.map(frame=>frame.min>=253?255:frame.max<=5?0:128);
    const starts=calibrationMarkers(pixels,pts);
    const diagnostics={probe,markerFrames:starts,calibrationSamples:samples};
    let map:CaptureMap|undefined;
    try{
      if(starts.length!==2)throw new Failure('CAPTURE_CLOCK_MARKER_AMBIGUOUS','capture','Exactly two held white-and-return-black calibration slates are required; startup flushes or extra candidates cannot define the clock.');
      const first=pts[starts[0]],last=pts[starts.at(-1)!];
      const offsetSeconds=first-(start.beforeMs+start.afterMs)/2000;
      const endOffset=last-(end.beforeMs+end.afterMs)/2000;
      const uncertaintySeconds=clockUncertaintySeconds(start,end);
      const driftSeconds=Math.abs(offsetSeconds-endOffset);
      map={sourcePath,width:stream.width,height:stream.height,durationSeconds:Number(stream.duration),offsetSeconds,uncertaintySeconds,driftSeconds,frameCount:pts.length,usableRasterRange:usableRasterRange(samples,pts,starts)};
      if(uncertaintySeconds>maximumClockErrorSeconds || driftSeconds>maximumClockErrorSeconds)throw new Failure('CAPTURE_CLOCK_UNCERTAIN','capture','The start/end source-clock calibration must stay within50ms; inspect rather than retime blindly.');
    }finally{
      await saveDiagnostics(options.diagnosticsPath??join(directory,'capture-analysis.json'),{...(map?{map}:{}),...diagnostics},options);
    }
    if(options.signal?.aborted)throw new Failure('CAPTURE_ABORTED','capture','Capture analysis was cancelled; the retained source is unchanged.');
    return map;
}

export const sourceSeconds=(map:CaptureMap,nodeMs:number)=>nodeMs/1000+map.offsetSeconds;
