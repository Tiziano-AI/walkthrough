import {Failure} from './contracts.ts';
import {isDeepStrictEqual} from 'node:util';
import type {SourceSet} from '../project/contracts.ts';
import type {NarrationResult} from '../audio/index.ts';
import type {AudioLanguage} from '../audio/provision.ts';
import {CAPTION_STRIP_HEIGHT,DEFAULT_CAPTION_PLACEMENT,OUTPUT_WIDTH,OUTPUT_HEIGHT,TimelineEmphasisFailure,isCameraMove,isCaptionPlacement,isFrameAligned,secondsToFrames,segmentTransform,validateTimeline,type Box,type CameraMove,type CaptionPlacement,type RenderEmphasis,type Timeline} from '../render/timeline.ts';
import {CAPTION_PADDING_X,layoutCaption} from '../render/captions.ts';

export type FilmTarget = Box | {markId:string} | null;
export type FilmCameraMove = Omit<CameraMove,'target'> & {target:FilmTarget};
export type FilmEmphasis = Omit<RenderEmphasis,'target'> & {target:Exclude<FilmTarget,null>};
export interface FilmPicture {
  id:string;sourceId:string;kind:'live'|'hold';transition:'cut'|'continuous';
  startSeconds:number;endSeconds?:number;durationSeconds?:number;settledObservationId?:string;
  zoom:number;target:FilmTarget;cameraMove?:FilmCameraMove;captionPlacement?:CaptionPlacement;emphasis?:FilmEmphasis[];
}
export interface FilmNarration {id:string;text:string;outputStartSeconds:number}
/** Pictures determine film length. Speech has its own output clock and may cross cuts. */
export interface FilmEdit {
  schemaVersion:1;sourceSetId:string;sourceSetSha256:string;title:string;brief:string;
  voiceId:string;language?:AudioLanguage;pictures:FilmPicture[];narration:FilmNarration[];
}

export interface FilmNarrationPhraseFit {
  phraseId:string;outputStartSeconds:number;measuredDurationSeconds:number;measuredEndSeconds:number;
  occupiedDurationSeconds:number;occupiedEndSeconds:number;
  nextPhrase:{phraseId:string;outputStartSeconds:number;requiredClearanceSeconds:number}|null;
  pictureEnd:{outputEndSeconds:number;requiredClearanceSeconds:number};
}
export interface FilmNarrationFit {
  schemaVersion:1;kind:'narration-fit';status:'fits'|'rejected';pictureDurationSeconds:number;
  phraseCount:number;conflictingPhraseCount:number;phrases:FilmNarrationPhraseFit[];
}
export const narrationPhraseConflicts=(phrase:FilmNarrationPhraseFit)=>
  (phrase.nextPhrase?.requiredClearanceSeconds??0)>0||phrase.pictureEnd.requiredClearanceSeconds>0;

export interface FilmCaptionDiagnostic {
  pictureId:string;phraseId:string|null;placement:CaptionPlacement|null;captionIndex?:number;
  outputFrame?:number;subjectKind?:'picture-target'|'camera-move-target'|'emphasis-target';emphasisId?:string;captionBox?:Box;projectedSubject?:Box;
}
export class FilmCaptionFailure extends Failure {
  caption:FilmCaptionDiagnostic;
  constructor(code:string,caption:FilmCaptionDiagnostic,remedy:string){
    super(code,'film-edit',`Picture ${caption.pictureId}${caption.phraseId?`, phrase ${caption.phraseId}`:''}${caption.emphasisId?`, emphasis ${caption.emphasisId}`:''}, captionPlacement ${JSON.stringify(caption.placement)}. ${remedy}`);
    this.caption=caption;
  }
}

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value===value.trim();
const known=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));
const box=(value:unknown):value is Box=>record(value)&&known(value,['x','y','width','height'])&&[value.x,value.y,value.width,value.height].every(Number.isFinite)&&Number(value.x)>=0&&Number(value.y)>=0&&Number(value.width)>0&&Number(value.height)>0;
const target=(value:unknown):value is FilmTarget=>value===null||box(value)||(record(value)&&known(value,['markId'])&&id(value.markId));
const fail=(code:string,recovery:string):never=>{throw new Failure(code,'film-edit',recovery);};
const frame=(seconds:number)=>{if(!isFrameAligned(seconds)||!Number.isSafeInteger(Math.round(seconds*60)))fail('FILM_TIME_NOT_FRAME_ALIGNED','Place picture boundaries, holds, camera moves, emphasis intervals and speech starts on the 60 fps frame grid.');return Math.round(seconds*60);};
const normalized=(value:string)=>value.replace(/\s+/gu,' ').trim();

export function previewFrameRange(from:number,to:number,durationSeconds:number):[number,number]{
  if(!isFrameAligned(from)||!isFrameAligned(to)||!Number.isSafeInteger(Math.round(from*60))||!Number.isSafeInteger(Math.round(to*60))||from<0||to<=from||to>durationSeconds)throw new Failure('FILM_PREVIEW_RANGE','film-edit','Use --from and --to on the 60 fps grid inside the picture timeline. The range includes from and excludes to.');
  return [Math.round(from*60),Math.round(to*60)-1];
}

/** Pure authoring validation. Never opens an application, synthesizes or renders. */
export function validateFilmEdit(value:unknown):FilmEdit {
  if(!record(value)||!known(value,['schemaVersion','sourceSetId','sourceSetSha256','title','brief','voiceId','language','pictures','narration'])||value.schemaVersion!==1||!id(value.sourceSetId)||typeof value.sourceSetSha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sourceSetSha256)||!text(value.title)||!text(value.brief)||typeof value.voiceId!=='string'||!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(value.voiceId)||(value.language!==undefined&&!['English','Italian'].includes(String(value.language)))||!Array.isArray(value.pictures)||!value.pictures.length||!Array.isArray(value.narration))fail('INVALID_FILM_EDIT','Provide the sealed source-set identity, title, brief, provisioned voice ID, optional English or Italian language, pictures and independent narration.');
  const edit=value as unknown as FilmEdit;
  const ids=new Set<string>();
  for(const picture of edit.pictures){
    try{
    if(!record(picture)||!known(picture,['id','sourceId','kind','transition','startSeconds','endSeconds','durationSeconds','settledObservationId','zoom','target','cameraMove','captionPlacement','emphasis'])||!id(picture.id)||ids.has(picture.id)||!id(picture.sourceId)||!['live','hold'].includes(picture.kind)||!['cut','continuous'].includes(picture.transition)||!Number.isFinite(picture.startSeconds)||picture.startSeconds<0||!Number.isFinite(picture.zoom)||picture.zoom<1||picture.zoom>1.5||!target(picture.target))fail('INVALID_FILM_PICTURE','Use unique picture IDs, explicit source ranges, framing, and live or observed-settled picture selection.');
    ids.add(picture.id);frame(picture.startSeconds);
    if(picture.kind==='live'){
      if(!Number.isFinite(picture.endSeconds)||picture.endSeconds!<=picture.startSeconds||picture.durationSeconds!==undefined||picture.settledObservationId!==undefined)fail('INVALID_FILM_LIVE_RANGE','Live footage has start and end source times and plays at 1× without padding.');
      frame(picture.endSeconds!);
    }else{
      if(!Number.isFinite(picture.durationSeconds)||picture.durationSeconds!<=0||picture.endSeconds!==undefined||!id(picture.settledObservationId))fail('INVALID_FILM_HOLD','A reading hold selects one frame and names the observation proving that frame is settled.');
      frame(picture.durationSeconds!);
    }
    const duration=picture.kind==='live'?picture.endSeconds!-picture.startSeconds:picture.durationSeconds!;
    if(picture.cameraMove!==undefined){
      if(!record(picture.cameraMove)||!target(picture.cameraMove.target)||!isCameraMove({...picture.cameraMove,target:null},duration))fail('INVALID_FILM_CAMERA_MOVE','Keep the camera move within its picture with zoom between 1× and 1.5×.');
      frame(picture.cameraMove.startSeconds);frame(picture.cameraMove.durationSeconds);
    }
    if(picture.emphasis!==undefined){
      if(!Array.isArray(picture.emphasis))throw new FilmEditFailure('INVALID_FILM_EMPHASIS',{pictureId:picture.id,field:'emphasis'},'Provide an array of timed outline or spotlight subjects; omit it when no emphasis is needed.');
      const emphasisIds=new Set<string>(),spotlights:FilmEmphasis[]=[];
      for(const emphasis of picture.emphasis){
        const location={pictureId:picture.id,field:'emphasis',...(id(emphasis?.id)?{emphasisId:emphasis.id}:{})};
        if(!record(emphasis)||!known(emphasis,['id','kind','target','startSeconds','endSeconds'])||!id(emphasis.id)||emphasisIds.has(emphasis.id)||!['outline','spotlight'].includes(emphasis.kind)||emphasis.target===null||!target(emphasis.target)||![emphasis.startSeconds,emphasis.endSeconds].every(Number.isFinite)||emphasis.startSeconds<0||emphasis.endSeconds<=emphasis.startSeconds||emphasis.endSeconds>duration+1e-9)
          throw new FilmEditFailure('INVALID_FILM_EMPHASIS',location,'Use unique IDs within this picture, outline or spotlight, a non-null source box or sealed mark target, and a positive picture-local interval inside this picture. No styles, tracking or labels are admitted.');
        try{frame(emphasis.startSeconds);frame(emphasis.endSeconds);}catch(error){if(error instanceof Failure)throw new FilmEditFailure(error.code,location,error.recovery);throw error;}
        emphasisIds.add(emphasis.id);
        if(emphasis.kind==='spotlight'){
          if(spotlights.some(other=>emphasis.startSeconds<other.endSeconds&&other.startSeconds<emphasis.endSeconds))throw new FilmEditFailure('FILM_EMPHASIS_SPOTLIGHT_OVERLAP',location,'Keep at most one spotlight active at any frame. Adjacent exclusive-end intervals are valid; outlines can compare several subjects.');
          spotlights.push(emphasis);
        }
      }
    }
    if(picture.captionPlacement!==undefined&&(!isCaptionPlacement(picture.captionPlacement)||picture.captionPlacement.width<=2*CAPTION_PADDING_X)){
      const supplied=picture.captionPlacement,placement=record(supplied)&&[supplied.x,supplied.y,supplied.width].every(Number.isFinite)?{x:supplied.x,y:supplied.y,width:supplied.width}:null;
      throw new FilmCaptionFailure('INVALID_FILM_CAPTION_PLACEMENT',{pictureId:picture.id,phraseId:null,placement},`Use finite output-pixel coordinates, a width greater than ${2*CAPTION_PADDING_X} pixels for caption padding, and keep the full ${CAPTION_STRIP_HEIGHT}-pixel-high strip inside ${OUTPUT_WIDTH}×${OUTPUT_HEIGHT}. Actual cue text is checked after audio measurement.`);
    }
    }catch(error){if(error instanceof Failure&&!(error instanceof FilmCaptionFailure)&&!(error instanceof FilmEditFailure))throw new FilmEditFailure(error.code,{...(id(picture?.id)?{pictureId:picture.id}:{})},error.recovery);throw error;}
  }
  ids.clear();let previous=-1;
  for(const phrase of edit.narration){
    try{
    if(!record(phrase)||!known(phrase,['id','text','outputStartSeconds'])||!id(phrase.id)||ids.has(phrase.id)||!text(phrase.text)||!Number.isFinite(phrase.outputStartSeconds)||phrase.outputStartSeconds<0||phrase.outputStartSeconds<previous)fail('INVALID_FILM_NARRATION','Give each phrase unique identity, canonical text and an independent output start in chronological order.');
    // Audio storage uses IDs as directory names and admits the same safe length.
    if(phrase.id.length>64)fail('INVALID_FILM_NARRATION','Keep narration IDs at most 64 characters.');
    frame(phrase.outputStartSeconds);ids.add(phrase.id);previous=phrase.outputStartSeconds;
    }catch(error){if(error instanceof Failure)throw new FilmEditFailure(error.code,{...(id(phrase?.id)?{phraseId:phrase.id}:{})},error.recovery);throw error;}
  }
  return edit;
}

export class FilmEditFailure extends Failure {
  location:{pictureId?:string;phraseId?:string;emphasisId?:string;field?:string;markId?:string;outputStartSeconds?:number;outputEndSeconds?:number;outputFrame?:number};
  constructor(code:string,location:FilmEditFailure['location'],recovery:string){super(code,'film-edit',recovery);this.location=location;}
}
function validatePictureTimeline(timeline:Timeline){
  try{return validateTimeline(timeline);}catch(error){
    if(error instanceof TimelineEmphasisFailure){
      const picture=timeline.segments.find(segment=>segment.id===error.segmentId)!;
      const reasons:Record<string,string>={'render:invalid_emphasis':'Use one valid timed outline or spotlight subject within this picture.','render:overlapping_spotlights':'Keep at most one spotlight active at any frame.','render:emphasis_outside_source':'Keep this emphasis target inside the exact source raster.','render:emphasis_hidden_by_framing':'Keep the complete emphasized subject visible throughout its active interval, including camera movement.'};
      throw new FilmEditFailure(error.message==='render:emphasis_hidden_by_framing'?'FILM_EMPHASIS_HIDDEN_BY_FRAMING':error.message==='render:emphasis_outside_source'?'FILM_EMPHASIS_GEOMETRY':error.message==='render:overlapping_spotlights'?'FILM_EMPHASIS_SPOTLIGHT_OVERLAP':'INVALID_FILM_EMPHASIS',{pictureId:error.segmentId,field:'emphasis',...(error.emphasisId?{emphasisId:error.emphasisId}:{}),...(error.localFrame!==undefined?{outputFrame:secondsToFrames(picture.outputStartSeconds)+error.localFrame}:{})},reasons[error.message]);
    }
    const reasons:Record<string,string>={
      'render:target_hidden_by_framing':'Keep the complete declared subject visible at the selected framing.',
      'render:discontinuous_source_requires_cut':'Use a cut unless this picture continues the preceding source interval exactly.',
      'render:continuous_framing_change_forbidden':'Use a cut or keep the preceding ending camera framing at this continuous boundary.',
    };
    if(!(error instanceof Error)||!Object.hasOwn(reasons,error.message))throw error;
    // Diagnose only a failed edit; the ordinary valid path traverses once.
    for(let index=0;index<timeline.segments.length;index++){
      try{validateTimeline({...timeline,segments:timeline.segments.slice(0,index+1),narration:[]});}catch(local){
        if(local instanceof Error&&local.message===error.message){const picture=timeline.segments[index];throw new FilmEditFailure(error.message==='render:target_hidden_by_framing'?'FILM_TARGET_HIDDEN_BY_FRAMING':'FILM_CONTINUOUS_BOUNDARY',{pictureId:picture.id,outputStartSeconds:picture.outputStartSeconds,outputEndSeconds:picture.outputStartSeconds+picture.durationSeconds},reasons[error.message]);}
        throw local;
      }
    }
    throw error;
  }
}
function resolveTarget(value:FilmTarget,picture:FilmPicture,sourceSet:SourceSet,field:string,emphasisId?:string):Box|null{
  if(value===null)return null;
  const source=sourceSet.sources.find(source=>source.id===picture.sourceId)!;
  const markId='markId' in value?value.markId:undefined;
  const location={pictureId:picture.id,field,...(markId?{markId}:{}),...(emphasisId?{emphasisId}:{})};
  const matches=markId?sourceSet.marks.filter(mark=>mark.sourceId===picture.sourceId&&mark.id===markId):[];
  if(markId&&(matches.length!==1||!matches[0].target))throw new FilmEditFailure('FILM_TARGET_MARK_INVALID',location,'Choose one sealed mark with a target on this picture’s exact source.');
  const resolved=markId?matches[0].target!:value as Box;
  if(!box(resolved)||resolved.x+resolved.width>source.width||resolved.y+resolved.height>source.height)throw new FilmEditFailure('FILM_TARGET_GEOMETRY',location,'Keep the declared target inside this source’s canonical raster geometry.');
  return {...resolved};
}
export function pictureTimeline(edit:FilmEdit,sourceSet:SourceSet):Timeline {
  validateFilmEdit(edit);
  if(edit.sourceSetId!==sourceSet.id)fail('FILM_SOURCE_SET_MISMATCH','Select the exact sealed source set named by the edit.');
  const first=sourceSet.sources[0];
  if(!first||sourceSet.sources.some(source=>source.width!==first.width||source.height!==first.height))fail('FILM_SOURCE_GEOMETRY','Use retained sources with the same qualified geometry.');
  const timeline:Timeline={sourceWidth:first.width,sourceHeight:first.height,sources:Object.fromEntries(sourceSet.sources.map(source=>[source.id,{pointer:source.pointer}])),segments:[],narration:[]};
  let output=0;
  for(const picture of edit.pictures){
    try{
    const source=sourceSet.sources.find(source=>source.id===picture.sourceId)??fail('FILM_SOURCE_MISSING','Select a source retained in this sealed source set.');
    const start=frame(picture.startSeconds),end=picture.kind==='live'?frame(picture.endSeconds!):start;
    const duration=picture.kind==='live'?end-start:frame(picture.durationSeconds!);
    const validStart=Math.ceil(source.usableRange.startSeconds*60-1e-6),validEnd=Math.floor(Math.min(source.usableRange.endSeconds,source.durationSeconds)*60+1e-6);
    if(start<validStart||(picture.kind==='live'?end:start+1)>validEnd)fail('FILM_SOURCE_RANGE','Keep each selected frame within the source usable range; calibration and unfinished footage are not film pictures.');
    if(picture.kind==='hold'){
      const matches=sourceSet.marks.filter(mark=>mark.sourceId===picture.sourceId&&mark.id===picture.settledObservationId);
      if(matches.length!==1)throw new FilmEditFailure('FILM_HOLD_MARK_INVALID',{pictureId:picture.id,field:'settledObservationId',markId:picture.settledObservationId},'Choose one retained mark from this picture’s exact source. Inspect the sealed source set’s marks for their identities.');
      const observation=matches[0];
      if(!observation.settled||picture.startSeconds<observation.settled.startSeconds||picture.startSeconds>=observation.settled.endSeconds)fail('FILM_HOLD_NOT_SETTLED','Hold only a frame covered by the named settled observation, never a pending interaction or spinner.');
    }
    timeline.segments.push({id:picture.id,sourceId:picture.sourceId,kind:picture.kind,transition:picture.transition,sourceStartSeconds:start/60,sourceEndSeconds:end/60,outputStartSeconds:output/60,durationSeconds:duration/60,zoom:picture.zoom,target:resolveTarget(picture.target,picture,sourceSet,'target'),...(picture.cameraMove?{cameraMove:{...picture.cameraMove,target:resolveTarget(picture.cameraMove.target,picture,sourceSet,'cameraMove.target')}}:{}),...(picture.captionPlacement?{captionPlacement:picture.captionPlacement}:{}),...(picture.emphasis?{emphasis:picture.emphasis.map(emphasis=>({...emphasis,target:resolveTarget(emphasis.target,picture,sourceSet,'emphasis.target',emphasis.id)!}))}:{})});
    output+=duration;
    if(!Number.isSafeInteger(output))fail('FILM_TIMELINE_OUT_OF_RANGE','Keep the cumulative film frame count within exact integer range.');
    }catch(error){if(error instanceof Failure&&!(error instanceof FilmEditFailure))throw new FilmEditFailure(error.code,{pictureId:picture.id},error.recovery);throw error;}
  }
  validatePictureTimeline(timeline);
  const outside=edit.narration.find(phrase=>frame(phrase.outputStartSeconds)>=output);
  if(outside)throw new FilmEditFailure('FILM_NARRATION_START_OUTSIDE',{phraseId:outside.id,outputStartSeconds:outside.outputStartSeconds},'Place every spoken phrase inside the picture timeline. Validation never extends pictures to fit speech.');
  return timeline;
}

export function validateFilmSources(edit:FilmEdit,sourceSet:SourceSet){
  const timeline=pictureTimeline(edit,sourceSet);
  return {durationSeconds:validateTimeline(timeline).durationInFrames/60,pictureCount:edit.pictures.length,narrationCount:edit.narration.length,speechTiming:edit.narration.length?'requires-audio' as const:'silent' as const};
}

/** Keep the natural measurement separate from the 60 fps occupied interval.
 * Clearance is the local deficit at a boundary, not a cumulative retiming plan. */
function narrationFit(totalFrames:number,measured:Array<Pick<FilmNarrationPhraseFit,'phraseId'|'outputStartSeconds'|'measuredDurationSeconds'>>):FilmNarrationFit{
  const phrases=measured.map((phrase,index)=>{
    const start=frame(phrase.outputStartSeconds),duration=Math.ceil(phrase.measuredDurationSeconds*60),end=start+duration,next=measured[index+1];
    return {...phrase,outputStartSeconds:start/60,measuredEndSeconds:start/60+phrase.measuredDurationSeconds,occupiedDurationSeconds:duration/60,occupiedEndSeconds:end/60,
      nextPhrase:next?{phraseId:next.phraseId,outputStartSeconds:frame(next.outputStartSeconds)/60,requiredClearanceSeconds:Math.max(0,end-frame(next.outputStartSeconds))/60}:null,
      pictureEnd:{outputEndSeconds:totalFrames/60,requiredClearanceSeconds:Math.max(0,end-totalFrames)/60}};
  });
  const conflictingPhraseCount=phrases.filter(narrationPhraseConflicts).length;
  return {schemaVersion:1,kind:'narration-fit',status:conflictingPhraseCount?'rejected':'fits',pictureDurationSeconds:totalFrames/60,phraseCount:phrases.length,conflictingPhraseCount,phrases};
}

/** Uses supplied measured audio only: no synthesis, cache access or picture edits. */
export function measureFilmNarrationFit(edit:FilmEdit,audio:Pick<NarrationResult,'beats'>,sourceSet:SourceSet):FilmNarrationFit{
  const totalFrames=validateTimeline(pictureTimeline(edit,sourceSet)).durationInFrames;
  return measuredNarrationFit(edit,audio,totalFrames);
}
function measuredNarrationFit(edit:FilmEdit,audio:Pick<NarrationResult,'beats'>,totalFrames:number):FilmNarrationFit{
  if(audio.beats.length!==edit.narration.length||new Set(audio.beats.map(beat=>beat.id)).size!==audio.beats.length||audio.beats.some(beat=>!edit.narration.some(phrase=>phrase.id===beat.id&&phrase.text===beat.text)))fail('FILM_AUDIO_MISMATCH','Use audio for the exact canonical text and phrase IDs in this edit.');
  const measured=edit.narration.map(phrase=>{
    const spoken=audio.beats.find(beat=>beat.id===phrase.id)!;
    if(!Number.isFinite(spoken.durationSeconds)||spoken.durationSeconds<=0||!Number.isSafeInteger(frame(phrase.outputStartSeconds)+Math.ceil(spoken.durationSeconds*60))||normalized(spoken.captions.map(caption=>caption.text).join(' '))!==normalized(phrase.text))fail('FILM_AUDIO_MISMATCH','Use complete captions aligned to the exact phrase text and its natural speech duration.');
    return {phraseId:phrase.id,outputStartSeconds:phrase.outputStartSeconds,measuredDurationSeconds:spoken.durationSeconds};
  });
  return narrationFit(totalFrames,measured);
}

/** Admit only the recorded public shape and internally coherent arithmetic.
 * This verifies a retained diagnostic, not the underlying WAV or spoken content. */
export function projectFilmNarrationFit(value:unknown):FilmNarrationFit|null{
  if(!record(value)||!Array.isArray(value.phrases)||!Number.isFinite(value.pictureDurationSeconds)||Number(value.pictureDurationSeconds)<=0||!isFrameAligned(Number(value.pictureDurationSeconds)))return null;
  const totalFrames=Math.round(Number(value.pictureDurationSeconds)*60);if(!Number.isSafeInteger(totalFrames))return null;
  const measured:Array<Pick<FilmNarrationPhraseFit,'phraseId'|'outputStartSeconds'|'measuredDurationSeconds'>>=[],ids=new Set<string>();let previous=-1;
  for(const phrase of value.phrases){
    if(!record(phrase)||!id(phrase.phraseId)||phrase.phraseId.length>64||ids.has(phrase.phraseId)||!Number.isFinite(phrase.outputStartSeconds)||Number(phrase.outputStartSeconds)<previous||Number(phrase.outputStartSeconds)<0||Number(phrase.outputStartSeconds)>=Number(value.pictureDurationSeconds)||!isFrameAligned(Number(phrase.outputStartSeconds))||!Number.isFinite(phrase.measuredDurationSeconds)||Number(phrase.measuredDurationSeconds)<=0||!Number.isSafeInteger(Math.round(Number(phrase.outputStartSeconds)*60)+Math.ceil(Number(phrase.measuredDurationSeconds)*60)))return null;
    ids.add(phrase.phraseId);previous=Number(phrase.outputStartSeconds);
    measured.push({phraseId:phrase.phraseId,outputStartSeconds:Number(phrase.outputStartSeconds),measuredDurationSeconds:Number(phrase.measuredDurationSeconds)});
  }
  const projected=narrationFit(totalFrames,measured);return isDeepStrictEqual(value,projected)?projected:null;
}

function minimumCaptionWidth(text:string):number|null{
  const fits=(width:number)=>{try{layoutCaption(text,{x:0,y:0,width});return true;}catch{return false;}};
  if(!fits(OUTPUT_WIDTH))return null;
  let low=2*CAPTION_PADDING_X+1,high=OUTPUT_WIDTH;
  while(low<high){const middle=Math.floor((low+high)/2);if(fits(middle))high=middle;else low=middle+1;}
  return low;
}
const boxesOverlap=(a:Box,b:Box)=>a.x<b.x+b.width-1e-6&&a.x+a.width>b.x+1e-6&&a.y<b.y+b.height-1e-6&&a.y+a.height>b.y+1e-6;

/** Check the renderer's actual cue intervals and text-sized backing boxes.
 * A null target declares no subject. During a move both named subjects are
 * protected; before/after it only the corresponding endpoint subject is used. */
function validateFilmCaptions(timeline:Timeline){
  for(const narration of timeline.narration){
    const narrationStart=secondsToFrames(narration.outputStartSeconds),narrationEnd=narrationStart+secondsToFrames(narration.durationSeconds);
    for(const [captionIndex,caption] of narration.captions.entries())for(const [pictureIndex,picture] of timeline.segments.entries()){
      const pictureStart=secondsToFrames(picture.outputStartSeconds),pictureEnd=pictureStart+secondsToFrames(picture.durationSeconds);
      const from=Math.max(pictureStart,narrationStart+secondsToFrames(caption.startSeconds)),to=Math.min(pictureEnd,narrationEnd,narrationStart+secondsToFrames(caption.endSeconds));
      if(from>=to)continue;
      const placement=picture.captionPlacement??DEFAULT_CAPTION_PLACEMENT,diagnostic:FilmCaptionDiagnostic={pictureId:picture.id,phraseId:narration.id,captionIndex,placement};
      let overlay;
      try{overlay=layoutCaption(caption.text,placement);}catch(error){
        if(!(error instanceof Error)||!['render:caption_does_not_fit','render:invalid_caption_placement','render:empty_caption'].includes(error.message))throw error;
        const minimum=minimumCaptionWidth(caption.text);
        throw new FilmCaptionFailure('FILM_CAPTION_DOES_NOT_FIT',diagnostic,minimum===null
          ?'This measured cue cannot fit within the output frame. Deliberately revise its narration text, then compose again; captions are never truncated or scaled down.'
          :`Increase this picture’s captionPlacement.width to at least ${minimum} output pixels and adjust x to keep the strip within ${OUTPUT_WIDTH} pixels. Keep the full strip inside ${OUTPUT_WIDTH}×${OUTPUT_HEIGHT}; existing narration audio can be reused.`);
      }
      const move=picture.cameraMove,moveStart=move?secondsToFrames(move.startSeconds):0,moveEnd=move?moveStart+secondsToFrames(move.durationSeconds):0;
      if(!picture.target&&!move?.target&&!picture.emphasis?.length)continue;
      // A stationary declared framing subject needs one check. Camera movement
      // and changing emphasis membership are checked on actual displayed frames.
      for(let outputFrame=from;outputFrame<to;){
        const localFrame=outputFrame-pictureStart,transform=segmentTransform(timeline,pictureIndex,localFrame);
        const subjects:Array<{box:Box;kind:NonNullable<FilmCaptionDiagnostic['subjectKind']>;emphasisId?:string}>=[];
        if(picture.target&&(!move||localFrame<moveEnd))subjects.push({box:picture.target,kind:'picture-target'});
        if(move?.target&&localFrame>=moveStart)subjects.push({box:move.target,kind:'camera-move-target'});
        for(const emphasis of picture.emphasis??[])if(localFrame>=secondsToFrames(emphasis.startSeconds)&&localFrame<secondsToFrames(emphasis.endSeconds))subjects.push({box:emphasis.target,kind:'emphasis-target',emphasisId:emphasis.id});
        for(const subject of subjects){
          const projectedSubject={x:subject.box.x*transform.scale+transform.x,y:subject.box.y*transform.scale+transform.y,width:subject.box.width*transform.scale,height:subject.box.height*transform.scale};
          for(const line of overlay.lines)if(boxesOverlap(line.box,projectedSubject))throw new FilmCaptionFailure('FILM_CAPTION_SUBJECT_OVERLAP',{...diagnostic,outputFrame,subjectKind:subject.kind,...(subject.emphasisId?{emphasisId:subject.emphasisId}:{}),captionBox:line.box,projectedSubject},`Move this picture’s captionPlacement away from the declared subject at output frame ${outputFrame}, or explicitly revise framing or narration placement. Check the full active interval and camera move; do not remove a genuine subject declaration merely to suppress this conflict.`);
        }
        if(picture.emphasis?.length){outputFrame++;continue;}
        if(!move||localFrame>=moveEnd)break;
        outputFrame=localFrame<moveStart?pictureStart+moveStart:outputFrame+1;
      }
    }
  }
}

/** Actual speech durations constrain the edit; they never pad or retime pictures. */
export function buildFilmTimeline(edit:FilmEdit,audio:Pick<NarrationResult,'beats'>,sourceSet:SourceSet):Timeline {
  const timeline=pictureTimeline(edit,sourceSet);
  const fit=measuredNarrationFit(edit,audio,validateTimeline(timeline).durationInFrames);let previousEnd=0;
  for(const [index,phrase] of edit.narration.entries()){
    const spoken=audio.beats.find(beat=>beat.id===phrase.id)!;
    const measured=fit.phrases[index];
    const location={phraseId:phrase.id,outputStartSeconds:measured.outputStartSeconds,outputEndSeconds:measured.occupiedEndSeconds};
    if(measured.outputStartSeconds<previousEnd)throw new FilmEditFailure('FILM_NARRATION_OVERLAP',location,'Inspect retained narration-fit measurements. Move the next phrase after the preceding phrase finishes or revise the edit; speech is never accelerated.');
    if(measured.pictureEnd.requiredClearanceSeconds>0)throw new FilmEditFailure('FILM_NARRATION_EXCEEDS_PICTURES',location,'Inspect retained narration-fit measurements. Choose sufficient real footage or an explicit settled hold, move speech earlier, or revise its text. Picture duration never changes implicitly.');
    timeline.narration.push({id:phrase.id,outputStartSeconds:measured.outputStartSeconds,durationSeconds:measured.occupiedDurationSeconds,wavPath:spoken.wavPath,captions:spoken.captions});
    previousEnd=measured.occupiedEndSeconds;
  }
  validateTimeline(timeline);validateFilmCaptions(timeline);return timeline;
}

export const filmTimestamp=(seconds:number)=>{const ms=Math.round(seconds*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;};
export function filmTimelineVtt(timeline:Timeline){
  const escape=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return 'WEBVTT\n\n'+timeline.narration.flatMap(phrase=>phrase.captions.map(caption=>`${filmTimestamp(phrase.outputStartSeconds+caption.startSeconds)} --> ${filmTimestamp(phrase.outputStartSeconds+caption.endSeconds)}\n${escape(caption.text)}\n`)).join('\n');
}
