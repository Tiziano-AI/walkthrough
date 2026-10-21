import {createHash} from 'node:crypto';
import {chmod,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {executeLocal} from '../render/media.ts';
import {frameState,segmentTransform,secondsToFrames,validateTimeline,OUTPUT_FPS,OUTPUT_WIDTH,OUTPUT_HEIGHT,type Timeline} from '../render/timeline.ts';
import {captionOverlayBoxesAtFrame} from '../render/captions.ts';

const STEP=6,WIDTH=320,HEIGHT=180,TILE=20;
const LIMITS=[
  'Source timestamp cadence is descriptive: damage-driven VFR legitimately holds static content. Neither average FPS nor burst timestamps prove genuine 60 Hz motion.',
  'Freeze detection compares matching source and output grayscale tiles across the full product frame every 100 ms during static framing; it excludes explicit holds, cuts, cursor, actual visible-caption boxes at either endpoint, and low-texture or static source tiles.',
  'Sample pairs whose editorial camera transform changes are not assessed: camera movement can otherwise disguise a frozen application. Static framing before and after a move is assessed separately.',
  'A pass applies only to tested static-framing live sample pairs and excludes sustained near-identical output where the corresponding sampled source visibly changes. It does not establish motion during camera moves, source-motion cadence, complete visual fidelity, readability, smoothness, speech, or viewer comprehension.',
];

export type TemporalPresentation='full-frame-visible-captions'|'full-frame-subtitles';
const sameTransform=(a:ReturnType<typeof segmentTransform>,b:ReturnType<typeof segmentTransform>)=>
  Math.abs(a.scale-b.scale)<1e-9&&Math.abs(a.x-b.x)<1e-9&&Math.abs(a.y-b.y)<1e-9;

export function summarizeSourceCadence(pts:number[]){
  if(pts.length<2 || pts.some((t,i)=>!Number.isFinite(t) || (i>0 && t<pts[i-1])))throw new Error('quality:invalid_source_timestamps');
  const bins={nonpositive:0,upTo20ms:0,over20To40ms:0,over40To100ms:0,over100ms:0};
  let burst=0,maxBurst=0,bursts=0,maxIntervalSeconds=0;
  for(let i=1;i<pts.length;i++){
    const dt=pts[i]-pts[i-1];maxIntervalSeconds=Math.max(maxIntervalSeconds,dt);
    if(dt<=0)bins.nonpositive++;
    else if(dt<=0.020001)bins.upTo20ms++;
    else if(dt<=0.040001)bins.over20To40ms++;
    else if(dt<=0.100001)bins.over40To100ms++;
    else bins.over100ms++;
    if(dt>0 && dt<=0.020001){burst++;maxBurst=Math.max(maxBurst,burst);}else{if(burst>=3)bursts++;burst=0;}
  }
  if(burst>=3)bursts++;
  return {samples:pts.length,intervals:pts.length-1,spanSeconds:pts.at(-1)!-pts[0],intervalBins:bins,maxIntervalSeconds,burstsOfAtLeastThreeFastIntervals:bursts,maxConsecutiveFastIntervals:maxBurst,acceptance:'descriptive-only' as const};
}

type UnassessedReason='editorial-hold'|'source-discontinuity'|'changing-camera'|'missing-source'|'insufficient-source-motion';
type Measurement={eligibleTiles:number;frozenTiles:number;meanAbsoluteDifference:number;tested:boolean;frozen:boolean;unassessedReason:UnassessedReason|null;captionMaskedTiles:number};
const unassessed=(unassessedReason:UnassessedReason):Measurement=>({eligibleTiles:0,frozenTiles:0,meanAbsoluteDifference:0,tested:false,frozen:false,unassessedReason,captionMaskedTiles:0});
/** Inputs are private 320x180 gray samples of the complete 1920x1080 frame. */
export function measureCameraPair(timeline:Timeline,fromFrame:number,toFrame:number,a:Uint8Array,b:Uint8Array,sourceA?:Uint8Array|null,sourceB?:Uint8Array|null,presentation:TemporalPresentation='full-frame-visible-captions'):Measurement{
  if(a.length!==WIDTH*HEIGHT || b.length!==a.length)throw new Error('quality:invalid_decoded_frame');
  const from=frameState(timeline,fromFrame),to=frameState(timeline,toFrame);
  if(from.hold || to.hold)return unassessed('editorial-hold');
  if(from.segment.sourceId!==to.segment.sourceId || (from.index!==to.index && to.segment.transition!=='continuous'))return unassessed('source-discontinuity');
  if(!sameTransform(from.transform,to.transform))return unassessed('changing-camera');
  if(!sourceA || !sourceB)return unassessed('missing-source');
  if(sourceA.length!==a.length || sourceB.length!==a.length)throw new Error('quality:invalid_source_frame');
  // Historical full-frame-subtitles encodes have no painted captions. Never
  // reinterpret those retained pixels using today's visible-caption overlay.
  const captionBoxes=presentation==='full-frame-visible-captions'?[...captionOverlayBoxesAtFrame(timeline,fromFrame),...captionOverlayBoxesAtFrame(timeline,toFrame)]:[];
  let eligibleTiles=0,frozenTiles=0,totalDifference=0,captionMaskedTiles=0;
  for(let y=0;y+TILE<=HEIGHT;y+=TILE)for(let x=0;x+TILE<=WIDTH;x+=TILE){
    // A small output-pixel margin covers filtering/codec bleed, not a caption rail.
    if(captionBoxes.some(box=>x*6<box.x+box.width+2&&(x+TILE)*6>box.x-2&&y*6<box.y+box.height+2&&(y+TILE)*6>box.y-2)){captionMaskedTiles++;continue;}
    if([from.cursor,to.cursor].some(c=>c && c.x>=x*6-36 && c.x<=(x+TILE)*6+36 && c.y>=y*6-36 && c.y<=(y+TILE)*6+36))continue;
    let gradient=0,difference=0,changed=0,sourceDifference=0,sourceChanged=0;
    for(let yy=y;yy<y+TILE;yy++)for(let xx=x;xx<x+TILE;xx++){
      const i=yy*WIDTH+xx,d=Math.abs(a[i]-b[i]);difference+=d;if(d>2)changed++;
      const sd=Math.abs(sourceA[i]-sourceB[i]);sourceDifference+=sd;if(sd>5)sourceChanged++;
      if(xx>x)gradient+=Math.abs(sourceA[i]-sourceA[i-1]);
      if(yy>y)gradient+=Math.abs(sourceA[i]-sourceA[i-WIDTH]);
    }
    const pixels=TILE*TILE;
    if(gradient/(2*TILE*(TILE-1))<1 || sourceDifference/pixels<1 || sourceChanged/pixels<0.02)continue;
    eligibleTiles++;totalDifference+=difference/pixels;
    // Near-identity tolerates tiny codec noise, but not material edge motion.
    if(difference/pixels<=0.15 && changed/pixels<=0.002)frozenTiles++;
  }
  const tested=eligibleTiles>=6;
  return {eligibleTiles,frozenTiles,meanAbsoluteDifference:eligibleTiles?totalDifference/eligibleTiles:0,tested,frozen:tested && frozenTiles/eligibleTiles>=0.8,unassessedReason:tested?null:'insufficient-source-motion',captionMaskedTiles};
}

export function evaluateCameraFrames(timeline:Timeline,frames:Uint8Array[],sourceFrames?:Array<Uint8Array|null>,presentation:TemporalPresentation='full-frame-visible-captions'){
  const expected=Math.ceil(validateTimeline(timeline).durationInFrames/STEP);
  if(frames.length!==expected)throw new Error('quality:decoded_frame_count_mismatch');
  if(sourceFrames && sourceFrames.length!==expected)throw new Error('quality:source_frame_count_mismatch');
  const pairs=[];
  let consecutive=0,longest=0,testedPairs=0,frozenPairs=0,changingCameraPairs=0,captionMaskedPairs=0;
  for(let i=1;i<frames.length;i++){
    const pair=measureCameraPair(timeline,(i-1)*STEP,i*STEP,frames[i-1],frames[i],sourceFrames?.[i-1],sourceFrames?.[i],presentation);
    pairs.push({fromFrame:(i-1)*STEP,toFrame:i*STEP,...pair});
    if(pair.tested)testedPairs++;
    if(pair.unassessedReason==='changing-camera')changingCameraPairs++;
    if(pair.captionMaskedTiles)captionMaskedPairs++;
    if(pair.frozen){frozenPairs++;consecutive++;longest=Math.max(longest,consecutive);}else consecutive=0;
  }
  const status=longest>=3?'fail':testedPairs>=3?'pass':'not-assessed';
  return {summary:{status,assessmentScope:'static-framing-live-sample-pairs',decodedSamples:frames.length,testedPairs,frozenPairs,changingCameraPairs,captionMaskedPairs,longestConsecutiveFrozenPairs:longest,frozenDefectThresholdSeconds:3*STEP/OUTPUT_FPS,sampleSpacingSeconds:STEP/OUTPUT_FPS,minimumSourceMeanDifference:1,minimumTexturedTiles:6} as const,pairs};
}

export async function qualifyTemporalVideo(input:{finalMP4:string;sourceMP4s:Record<string,string>;timeline:Timeline;presentation?:TemporalPresentation;ffmpegPath:string;ffprobePath:string;directory:string;signal?:AbortSignal}){
  const {directory,timeline,signal}=input;
  const expected=validateTimeline(timeline);
  await mkdir(directory,{recursive:true,mode:0o700});
  const sourceCadence:Record<string,ReturnType<typeof summarizeSourceCadence>>={};
  for(const [index,sourceId] of [...new Set(timeline.segments.map(segment=>segment.sourceId))].entries()){
    const sourcePath=input.sourceMP4s[sourceId];
    if(!sourcePath)throw new Error('quality:source_missing');
    const sourceProbe=join(directory,`source-${index}-pts.json`);
    // Capture qualification and source references share the native clock;
    // demux fill-in must not invent PTS for zero-duration startup samples.
    await executeLocal(input.ffprobePath,['-v','error','-fflags','+nofillin','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',sourcePath],sourceProbe,120000,undefined,signal);
    const rawProbe=JSON.parse(await readFile(sourceProbe,'utf8'));
    sourceCadence[sourceId]=summarizeSourceCadence(rawProbe.frames.map((f:any)=>Number(f.best_effort_timestamp_time)));
  }
  const finalProbe=join(directory,'final-probe.json');
  await executeLocal(input.ffprobePath,['-v','error','-select_streams','v:0','-show_streams','-show_entries','stream=width,height,nb_frames,avg_frame_rate','-of','json',input.finalMP4],finalProbe,120000,undefined,signal);
  const stream=JSON.parse(await readFile(finalProbe,'utf8')).streams[0];
  if(stream?.width!==OUTPUT_WIDTH || stream.height!==OUTPUT_HEIGHT || stream.avg_frame_rate!=='60/1' || Number(stream.nb_frames)!==expected.durationInFrames)throw new Error('quality:final_video_geometry_or_frame_count');
  const rawPath=join(directory,'camera-samples.gray');
  await executeLocal(input.ffmpegPath,['-hide_banner','-loglevel','error','-nostdin','-n','-i',input.finalMP4,'-map','0:v:0','-an','-vf',`select=not(mod(n\\,${STEP})),scale=${WIDTH}:${HEIGHT}:flags=area`,'-fps_mode','passthrough','-pix_fmt','gray','-f','rawvideo',rawPath],join(directory,'decode.log'),300000,undefined,signal);
  await chmod(rawPath,0o600);
  const bytes=await readFile(rawPath),size=WIDTH*HEIGHT;
  if(bytes.length%size)throw new Error('quality:truncated_decoded_frames');
  const frames=Array.from({length:bytes.length/size},(_,i)=>bytes.subarray(i*size,(i+1)*size));
  const sourceFrames:Array<Uint8Array|null>=Array.from({length:frames.length},()=>null);
  const states=frames.map((_,sample)=>frameState(timeline,sample*STEP));
  const comparable=(a:typeof states[number],b:typeof states[number])=>!a.hold&&!b.hold&&a.segment.sourceId===b.segment.sourceId
    &&(a.index===b.index||b.segment.transition==='continuous')&&sameTransform(a.transform,b.transform);
  // Decode only samples belonging to a static-framing comparison. Decode each
  // settled framing separately so post-move evidence uses the final crop rather
  // than the segment's initial camera. Moving-camera samples remain unobserved.
  const needed=states.map((state,sample)=>(sample>0&&comparable(states[sample-1],state))||(sample+1<states.length&&comparable(state,states[sample+1])));
  for(const [index,segment] of timeline.segments.entries()){
    if(segment.kind==='hold')continue;
    const outputStart=secondsToFrames(segment.outputStartSeconds),outputEnd=outputStart+secondsToFrames(segment.durationSeconds);
    const firstSample=Math.ceil(outputStart/STEP),lastSample=Math.ceil(outputEnd/STEP)-1;
    if(lastSample<firstSample)continue;
    let group=0;
    for(let start=firstSample;start<=lastSample;start++){
      if(!needed[start])continue;
      let end=start;
      while(end<lastSample&&needed[end+1]&&sameTransform(states[start].transform,states[end+1].transform))end++;
      const sourceStart=secondsToFrames(segment.sourceStartSeconds)+start*STEP-outputStart;
      const sourceEnd=sourceStart+(end-start)*STEP+1;
      const transform=states[start].transform;
      const suffix=group++?`-${group}`:'';
      const referencePath=join(directory,`source-${index}${suffix}-samples.gray`);
      // Match the render's causal sample-and-hold clock: never select a future
      // state before its PTS. Original timestamps above remain cadence evidence.
      const scaledWidth=Math.round(timeline.sourceWidth*transform.scale),scaledHeight=Math.round(timeline.sourceHeight*transform.scale);
      const x=Math.round(transform.x),y=Math.round(transform.y);
      // The comparison is grayscale. Convert before geometry so chroma subsampling
      // cannot round an odd crop height down and make a valid pad smaller than input.
      const filter=`fps=60:start_time=0:round=up,trim=start_frame=${sourceStart}:end_frame=${sourceEnd},select=not(mod(n\\,${STEP})),format=gray,scale=${scaledWidth}:${scaledHeight}:flags=bicubic,pad=${Math.max(OUTPUT_WIDTH,scaledWidth)}:${Math.max(OUTPUT_HEIGHT,scaledHeight)}:${Math.max(0,x)}:${Math.max(0,y)}:black,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:${Math.max(0,-x)}:${Math.max(0,-y)},scale=${WIDTH}:${HEIGHT}:flags=area`;
      await executeLocal(input.ffmpegPath,['-hide_banner','-loglevel','error','-nostdin','-n','-fflags','+nofillin','-i',input.sourceMP4s[segment.sourceId],'-map','0:v:0','-an','-vf',filter,'-fps_mode','passthrough','-pix_fmt','gray','-f','rawvideo',referencePath],join(directory,`source-${index}${suffix}-decode.log`),300000,undefined,signal);
      await chmod(referencePath,0o600);
      const reference=await readFile(referencePath);
      if(reference.length!==(end-start+1)*size)throw new Error('quality:source_decoded_frame_count_mismatch');
      for(let sample=start;sample<=end;sample++)sourceFrames[sample]=reference.subarray((sample-start)*size,(sample-start+1)*size);
      start=end;
    }
  }
  const presentation=input.presentation??'full-frame-visible-captions';
  const camera=evaluateCameraFrames(timeline,frames,sourceFrames,presentation);
  const summary={schemaVersion:3,presentation,sourceCadence,frozenCamera:camera.summary,limits:LIMITS};
  // These raw frames, hashes and timing details are local run artifacts, never
  // console output or hosted QA inputs. The returned value is coarse only.
  await writeFile(join(directory,'camera-evidence.json'),JSON.stringify({pairs:camera.pairs,frameHashes:frames.map(f=>createHash('sha256').update(f).digest('hex'))},null,2),{flag:'wx',mode:0o600});
  await writeFile(join(directory,'temporal-summary.json'),JSON.stringify(summary,null,2),{flag:'wx',mode:0o600});
  return summary;
}
