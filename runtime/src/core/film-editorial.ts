import type {FilmSource,SourceSet} from '../project/contracts.ts';
import type {NarrationBeat,NarrationResult,NarrationWord} from '../audio/index.ts';
import type {Box,RenderSegment} from '../render/timeline.ts';
import {pictureTimeline,type FilmEdit} from './film-edit.ts';

const MINIMUM_GAP_SECONDS=3;
const PICTURE_CONTEXT_LIMIT=8;
const MARK_CONTEXT_LIMIT=6;
const GESTURE_CONTEXT_LIMIT=6;
const EMPHASIS_CONTEXT_LIMIT=6;
const TEXT_CONTEXT_LIMIT=180;
type TimingBasis='resolved-word-alignment'|'measured-audio-span'|'unmeasured-narration';

export interface EditorialSpeechContext {
  phraseId:string;text:string;textTruncated:boolean;timingBasis:TimingBasis;
  outputStartSeconds:number;outputEndSeconds:number|null;
  word?:{text:string;textTruncated:boolean;charStart:number;charEnd:number};
}
export interface EditorialGestureContext {
  kind:'click'|'drag';sourceStartSeconds:number;sourceEndSeconds:number;
  outputStartSeconds:number;outputEndSeconds:number;
}
export interface EditorialPictureContext {
  pictureId:string;sourceId:string;kind:'live'|'hold';transition:'cut'|'continuous';
  outputStartSeconds:number;outputEndSeconds:number;sourceStartSeconds:number;sourceEndSeconds:number;
  framing:{zoom:number;target:Box|null;cameraAtIntervalStart:'initial'|'moving'|'destination'};
  cameraMove:null|{outputStartSeconds:number;outputEndSeconds:number;zoom:number;target:Box|null};
  emphasis:Array<{id:string;kind:'outline'|'spotlight';target:Box;outputStartSeconds:number;outputEndSeconds:number}>;
  totalEmphasis:number;emphasisTruncated:boolean;
  pointer:{moveCount:number;downCount:number;upCount:number;gestures:EditorialGestureContext[];totalGestures:number;gesturesTruncated:boolean};
  marks:Array<{id:string;title:string;titleTruncated:boolean;sourceTimeSeconds:number;outputTimeSeconds:number|null;target:Box|null;settled:boolean}>;
  totalMarks:number;marksTruncated:boolean;
}
export interface EditorialObservation {
  code:'CAMERA_DURING_RECORDED_GESTURE'|'NARRATION_GAP';severity:'observation';
  /** First intersecting picture; context.pictures includes subsequent cuts. */
  pictureId:string;sourceId:string;outputStartSeconds:number;outputEndSeconds:number;detail:string;
  /** Frame-aligned arguments for the existing preview --from/--to operation. */
  preview:{fromSeconds:number;toSeconds:number};
  context:{pictures:EditorialPictureContext[];totalPictures:number;picturesTruncated:boolean};
  speech?:{before:EditorialSpeechContext|null;after:EditorialSpeechContext|null;
    timingBasis:'no-narration'|TimingBasis|'mixed';spokenContentVerified:false};
}

interface OccupiedSpeech {start:number;end:number;context:EditorialSpeechContext}
interface RecordedGesture {kind:'click'|'drag';start:number;end:number}
const excerpt=(text:string)=>({text:text.length>TEXT_CONTEXT_LIMIT?`${text.slice(0,TEXT_CONTEXT_LIMIT-1)}…`:text,textTruncated:text.length>TEXT_CONTEXT_LIMIT});

/** Word boundaries are alignment evidence, not an acoustic silence detector or
 * spoken-content verification. Incomplete/ambiguous timing occupies the whole
 * measured WAV instead of manufacturing gaps from unsupported word spans. */
function resolvedWords(beat:NarrationBeat):NarrationWord[]|null{
  if(beat.unresolvedWordCount!==0||!Array.isArray(beat.words)||!beat.words.length)return null;
  const canonical=[...beat.text.matchAll(/\S+/gu)];
  if(canonical.length!==beat.words.length)return null;
  let previousEnd=0;
  for(const [index,word] of beat.words.entries()){
    const token=canonical[index];
    if(word.timingResolved!==true||word.text!==token[0]||word.charStart!==token.index||word.charEnd!==token.index+token[0].length
      ||!Number.isFinite(word.startSeconds)||!Number.isFinite(word.endSeconds)||word.startSeconds<previousEnd
      ||word.endSeconds<=word.startSeconds||word.endSeconds>beat.durationSeconds+0.001)return null;
    previousEnd=word.endSeconds;
  }
  return beat.words;
}

function speechIntervals(edit:FilmEdit,audio?:Pick<NarrationResult,'beats'>):OccupiedSpeech[]{
  return edit.narration.flatMap<OccupiedSpeech>(phrase=>{
    const beat=audio?.beats.find(beat=>beat.id===phrase.id&&beat.text===phrase.text);
    const measured=beat&&Number.isFinite(beat.durationSeconds)&&beat.durationSeconds>0?beat:undefined;
    const words=measured?resolvedWords(measured):null;
    const context={phraseId:phrase.id,...excerpt(phrase.text)};
    if(words)return words.map(word=>{
      const start=phrase.outputStartSeconds+word.startSeconds,end=phrase.outputStartSeconds+Math.min(word.endSeconds,measured!.durationSeconds);
      return {start,end,context:{...context,timingBasis:'resolved-word-alignment' as const,outputStartSeconds:start,outputEndSeconds:end,word:{...excerpt(word.text),charStart:word.charStart,charEnd:word.charEnd}}};
    });
    const end=measured?phrase.outputStartSeconds+measured.durationSeconds:Infinity;
    return [{start:phrase.outputStartSeconds,end,context:{...context,timingBasis:measured?'measured-audio-span' as const:'unmeasured-narration' as const,outputStartSeconds:phrase.outputStartSeconds,outputEndSeconds:Number.isFinite(end)?end:null}}];
  }).sort((a,b)=>a.start-b.start||a.end-b.end);
}

function recordedGestures(source:FilmSource):RecordedGesture[]{
  const gestures:RecordedGesture[]=[];
  let down:(typeof source.pointer)[number]|undefined;
  let trajectoryMovedAt:number|undefined;
  for(const sample of source.pointer){
    if(sample.type==='down'){down=sample;trajectoryMovedAt=undefined;}
    // Untagged retained input uses the same measured trajectory threshold as
    // the renderer. This recognizes pointer displacement, not an app effect.
    if(sample.type==='move'&&down&&sample.timeSeconds>down.timeSeconds&&Math.hypot(sample.x-down.x,sample.y-down.y)>3)trajectoryMovedAt??=sample.timeSeconds;
    if(sample.type==='up'&&down){
      if(sample.timeSeconds>down.timeSeconds)gestures.push({kind:down.gesture==='drag'||sample.gesture==='drag'||trajectoryMovedAt!==undefined&&trajectoryMovedAt<sample.timeSeconds?'drag':'click',start:down.timeSeconds,end:sample.timeSeconds});
      down=undefined;
      trajectoryMovedAt=undefined;
    }
  }
  return gestures;
}

function pictureContext(picture:RenderSegment,sourceSet:SourceSet,gestures:RecordedGesture[],from:number,to:number):EditorialPictureContext{
  const source=sourceSet.sources.find(source=>source.id===picture.sourceId)!;
  const outputStart=Math.max(from,picture.outputStartSeconds),outputEnd=Math.min(to,picture.outputStartSeconds+picture.durationSeconds);
  const sourceTime=(output:number)=>picture.sourceStartSeconds+(picture.kind==='live'?output-picture.outputStartSeconds:0);
  const sourceStart=sourceTime(outputStart),sourceEnd=sourceTime(outputEnd);
  const outputTime=(source:number)=>picture.outputStartSeconds+source-picture.sourceStartSeconds;
  const interval=(start:number,end:number)=>{
    const clippedStart=Math.max(outputStart,picture.outputStartSeconds+start),clippedEnd=Math.min(outputEnd,picture.outputStartSeconds+end);
    return clippedStart<clippedEnd?{outputStartSeconds:clippedStart,outputEndSeconds:clippedEnd}:null;
  };
  const camera=picture.cameraMove,cameraRange=camera?interval(camera.startSeconds,camera.startSeconds+camera.durationSeconds):null;
  const localStart=outputStart-picture.outputStartSeconds;
  const cameraAtIntervalStart=!camera||localStart<=camera.startSeconds?'initial' as const:localStart>=camera.startSeconds+camera.durationSeconds?'destination' as const:'moving' as const;
  const framing=cameraAtIntervalStart==='destination'?camera!:picture;
  const emphasis=(picture.emphasis??[]).flatMap(subject=>{
    const range=interval(subject.startSeconds,subject.endSeconds);
    return range?[{...range,id:subject.id,kind:subject.kind,target:subject.target}]:[];
  });
  const pointer=picture.kind==='live'?source.pointer.filter(sample=>sample.timeSeconds>=sourceStart&&sample.timeSeconds<sourceEnd):[];
  const localGestures=picture.kind==='live'?gestures.filter(gesture=>gesture.start<sourceEnd&&gesture.end>sourceStart).map(gesture=>{
    const start=Math.max(gesture.start,sourceStart),end=Math.min(gesture.end,sourceEnd);
    return {kind:gesture.kind,sourceStartSeconds:start,sourceEndSeconds:end,outputStartSeconds:outputTime(start),outputEndSeconds:outputTime(end)};
  }):[];
  const marks=sourceSet.marks.filter(mark=>mark.sourceId===source.id&&(picture.kind==='live'?mark.timeSeconds>=sourceStart&&mark.timeSeconds<sourceEnd:
    mark.timeSeconds===sourceStart||!!mark.settled&&mark.settled.startSeconds<=sourceStart&&mark.settled.endSeconds>sourceStart));
  return {pictureId:picture.id,sourceId:source.id,kind:picture.kind,transition:picture.transition,
    outputStartSeconds:outputStart,outputEndSeconds:outputEnd,sourceStartSeconds:sourceStart,sourceEndSeconds:sourceEnd,
    framing:{zoom:framing.zoom,target:framing.target,cameraAtIntervalStart},
    cameraMove:camera&&cameraRange?{...cameraRange,zoom:camera.zoom,target:camera.target}:null,
    emphasis:emphasis.slice(0,EMPHASIS_CONTEXT_LIMIT),totalEmphasis:emphasis.length,emphasisTruncated:emphasis.length>EMPHASIS_CONTEXT_LIMIT,
    pointer:{moveCount:pointer.filter(sample=>sample.type==='move').length,downCount:pointer.filter(sample=>sample.type==='down').length,upCount:pointer.filter(sample=>sample.type==='up').length,
      gestures:localGestures.slice(0,GESTURE_CONTEXT_LIMIT),totalGestures:localGestures.length,gesturesTruncated:localGestures.length>GESTURE_CONTEXT_LIMIT},
    marks:marks.slice(0,MARK_CONTEXT_LIMIT).map(mark=>({id:mark.id,title:excerpt(mark.title).text,titleTruncated:excerpt(mark.title).textTruncated,sourceTimeSeconds:mark.timeSeconds,
      outputTimeSeconds:picture.kind==='live'?outputTime(mark.timeSeconds):null,target:mark.target,settled:!!mark.settled})),totalMarks:marks.length,marksTruncated:marks.length>MARK_CONTEXT_LIMIT};
}

/** Nonblocking viewing prompts. A gap is a whole-film narration interval, not
 * absence of UI change. Pointer/mark activity is context and never suppresses
 * it. Unknown speech duration covers the remaining film conservatively. */
export function filmEditorialObservations(edit:FilmEdit,sourceSet:SourceSet,audio?:Pick<NarrationResult,'beats'>):EditorialObservation[]{
  const timeline=pictureTimeline(edit,sourceSet),pictures=timeline.segments,observations:EditorialObservation[]=[];
  const filmEnd=pictures.at(-1)!.outputStartSeconds+pictures.at(-1)!.durationSeconds;
  const gestures=new Map(sourceSet.sources.map(source=>[source.id,recordedGestures(source)]));
  const base=(code:EditorialObservation['code'],from:number,to:number,detail:string):EditorialObservation=>{
    const intersecting=pictures.filter(picture=>picture.outputStartSeconds<to&&picture.outputStartSeconds+picture.durationSeconds>from);
    const first=intersecting[0];
    return {code,severity:'observation',pictureId:first.id,sourceId:first.sourceId,outputStartSeconds:from,outputEndSeconds:to,detail,
      preview:{fromSeconds:Math.max(0,Math.floor(from*60+1e-9)/60),toSeconds:Math.min(filmEnd,Math.ceil(to*60-1e-9)/60)},
      context:{pictures:intersecting.slice(0,PICTURE_CONTEXT_LIMIT).map(picture=>pictureContext(picture,sourceSet,gestures.get(picture.sourceId)!,from,to)),
        totalPictures:intersecting.length,picturesTruncated:intersecting.length>PICTURE_CONTEXT_LIMIT}};
  };
  for(const picture of pictures){
    if(picture.kind!=='live'||!picture.cameraMove)continue;
    const moveStart=picture.sourceStartSeconds+picture.cameraMove.startSeconds,moveEnd=moveStart+picture.cameraMove.durationSeconds;
    for(const gesture of gestures.get(picture.sourceId)!){
      const from=Math.max(gesture.start,moveStart),to=Math.min(gesture.end,moveEnd);
      if(from<to)observations.push(base('CAMERA_DURING_RECORDED_GESTURE',picture.outputStartSeconds+from-picture.sourceStartSeconds,picture.outputStartSeconds+to-picture.sourceStartSeconds,
        'The camera moves during a recorded button-down gesture. Review whether the viewer can follow both motions.'));
    }
  }
  const occupied=speechIntervals(edit,audio);
  const gap=(from:number,to:number)=>{
    if(to-from<MINIMUM_GAP_SECONDS-1e-9)return;
    const before=occupied.filter(interval=>interval.end<=from+1e-9).sort((a,b)=>b.end-a.end).at(0)?.context??null;
    const after=occupied.find(interval=>interval.start>=to-1e-9)?.context??null;
    const bases=new Set([before,after].filter(item=>item!==null).map(item=>item!.timingBasis));
    const timingBasis=!edit.narration.length?'no-narration' as const:bases.size===1?[...bases][0]:bases.size>1?'mixed' as const:'measured-audio-span' as const;
    const observation=base('NARRATION_GAP',from,to,
      'At least 3 seconds lie outside the available narration timing. Word-derived boundaries are alignment evidence, not an acoustic-silence measurement or verified spoken content. Inspect the pictures for a useful visual or reading task; retained pointer activity does not establish application change.');
    observation.speech={before,after,timingBasis,spokenContentVerified:false};observations.push(observation);
  };
  let end=0;
  for(const interval of occupied){
    if(interval.start>end)gap(end,Math.min(interval.start,filmEnd));
    end=Math.max(end,interval.end);
    if(end>=filmEnd)break;
  }
  if(end<filmEnd)gap(end,filmEnd);
  return observations.sort((a,b)=>a.outputStartSeconds-b.outputStartSeconds||a.outputEndSeconds-b.outputEndSeconds||a.code.localeCompare(b.code));
}
