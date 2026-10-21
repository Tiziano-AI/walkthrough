import assert from 'node:assert/strict';
import test from 'node:test';
import {buildFilmTimeline,filmTimelineVtt,measureFilmNarrationFit,projectFilmNarrationFit,validateFilmEdit,validateFilmSources,type FilmEdit} from '../src/core/film-edit.ts';
import type {SourceSet} from '../src/project/contracts.ts';
import type {NarrationBeat} from '../src/audio/index.ts';
import {captionOverlayAtFrame} from '../src/render/captions.ts';
import {frameState} from '../src/render/timeline.ts';
import {filmEditorialObservations} from '../src/core/film-editorial.ts';
import {validateSourceSet} from '../src/project/store.ts';

const sourceSet:SourceSet={schemaVersion:1,kind:'source-set',id:'sources-test',projectId:'project-test',createdAt:'2026-10-03T00:00:00Z',state:'sealed',mediaReview:'agent-reviewable-synthetic',sources:[{id:'take-one',media:{relativePath:'one.mp4',sha256:'a'.repeat(64),bytes:1},width:3200,height:1800,durationSeconds:12,frameCount:720,clock:{offsetSeconds:0,uncertaintySeconds:0,driftSeconds:0},pointer:[],usableRange:{startSeconds:1,endSeconds:11}}],marks:[{id:'settled-one',title:'Settled result',sourceId:'take-one',timeSeconds:8,target:null,settled:{startSeconds:8,endSeconds:10,method:'observed-stability'}}],artifacts:[]};
const edit:FilmEdit={schemaVersion:1,sourceSetId:sourceSet.id,sourceSetSha256:'b'.repeat(64),title:'Inspect a product',brief:'See the main view, then compare its result.',voiceId:'copilot-female-1',pictures:[{id:'overview',sourceId:'take-one',kind:'live',transition:'cut',startSeconds:1,endSeconds:3,zoom:1,target:null,captionPlacement:{x:100,y:30,width:1400}},{id:'result',sourceId:'take-one',kind:'live',transition:'cut',startSeconds:6,endSeconds:10,zoom:1,target:null,captionPlacement:{x:100,y:900,width:1400}}],narration:[{id:'introduction',text:'Compare the product and its result.',outputStartSeconds:1}]};
function speech(text=edit.narration[0].text,duration=3):NarrationBeat{return {id:'introduction',text,wavPath:'/retained/introduction.wav',durationSeconds:duration,words:[],captions:[{text,startSeconds:0,endSeconds:duration}],cacheHit:true,wavSha256:'c'.repeat(64),unresolvedWordCount:0,metrics:{durationSeconds:duration,sampleRate:24000,channels:1,peak:0.5,rms:0.1,clippedSampleFraction:0,wordsPerMinute:120}};}

test('sealed mark targets resolve in picture and camera move without modifying edit bytes',()=>{
  const selected=structuredClone(edit),sources=structuredClone(sourceSet),box={x:100,y:100,width:500,height:200};
  sources.marks[0].target=box;selected.pictures[0].target={markId:'settled-one'};selected.pictures[0].cameraMove={startSeconds:0,durationSeconds:1,zoom:1.2,target:{markId:'settled-one'}};selected.narration=[];
  const before=JSON.stringify(selected),timeline=buildFilmTimeline(selected,{beats:[]},sources);
  assert.deepEqual(timeline.segments[0].target,box);assert.deepEqual(timeline.segments[0].cameraMove?.target,box);assert.equal(JSON.stringify(selected),before);
  sources.marks[0].sourceId='another-source';
  assert.throws(()=>validateFilmSources(selected,sources),{code:'FILM_TARGET_MARK_INVALID',location:{pictureId:'overview',field:'target',markId:'settled-one'}});
  sources.marks[0].sourceId='take-one';sources.marks[0].target={...box,x:3199};
  assert.throws(()=>validateFilmSources(selected,sources),{code:'FILM_TARGET_GEOMETRY',location:{pictureId:'overview',field:'target',markId:'settled-one'}});
});
test('new language/voice selection is explicit while historical omitted language remains untouched',()=>{
  assert.equal(validateFilmEdit({...edit,voiceId:'another-reviewed-voice',language:'Italian'}).language,'Italian');
  assert.equal(Object.hasOwn(validateFilmEdit(edit),'language'),false);
  assert.throws(()=>validateFilmEdit({...edit,language:'French'}),/INVALID_FILM_EDIT/);
});

test('framing and reading holds resolve duplicate names by their picture source',()=>{
  const sources=structuredClone(sourceSet),selected=structuredClone(edit);
  const boxes=[{x:100,y:100,width:500,height:200},{x:1800,y:900,width:600,height:300}];
  sources.sources.push({...structuredClone(sources.sources[0]),id:'take-two'});
  sources.marks[0].target=boxes[0];
  sources.marks.unshift({...structuredClone(sources.marks[0]),sourceId:'take-two',target:boxes[1],settled:{startSeconds:3,endSeconds:5,method:'observed-stability'}});
  validateSourceSet(sources);
  selected.narration=[];
  selected.pictures=sources.sources.map((source,index)=>({id:`reading-${index}`,sourceId:source.id,kind:'hold',transition:'cut',startSeconds:index===0?9:4,durationSeconds:2,settledObservationId:'settled-one',zoom:1,target:{markId:'settled-one'},cameraMove:{startSeconds:0,durationSeconds:1,zoom:1.2,target:{markId:'settled-one'}}}));
  const before=JSON.stringify({sources,selected}),timeline=buildFilmTimeline(selected,{beats:[]},sources);
  assert.deepEqual(timeline.segments.map(segment=>segment.target),boxes);
  assert.deepEqual(timeline.segments.map(segment=>segment.cameraMove?.target),boxes);
  assert.equal(JSON.stringify({sources,selected}),before,'resolution never rewrites retained material');
  selected.pictures[0].settledObservationId='missing';
  assert.throws(()=>validateFilmSources(selected,sources),{code:'FILM_HOLD_MARK_INVALID',location:{pictureId:'reading-0',field:'settledObservationId',markId:'missing'}});
  selected.pictures[0].settledObservationId='settled-one';selected.pictures[0].startSeconds=4;
  assert.throws(()=>validateFilmSources(selected,sources),{code:'FILM_HOLD_NOT_SETTLED'},'a different source’s valid interval cannot admit this hold');
  sources.marks=sources.marks.filter(mark=>mark.sourceId==='take-two');selected.pictures[0].startSeconds=9;
  assert.throws(()=>validateFilmSources(selected,sources),{code:'FILM_HOLD_MARK_INVALID'},'a same-named mark on another source is not this picture’s observation');
});

test('historical prefixed mark IDs remain opaque and usable without conversion',()=>{
  const sources=structuredClone(sourceSet),selected=structuredClone(edit),mark=sources.marks[0];
  mark.id='take-original-settled-one';mark.target={x:100,y:100,width:500,height:200};
  selected.narration=[];selected.pictures=[{id:'reading',sourceId:'take-one',kind:'hold',transition:'cut',startSeconds:9,durationSeconds:2,settledObservationId:mark.id,zoom:1,target:{markId:mark.id}}];
  const before=JSON.stringify({sources,selected});validateSourceSet(sources);
  assert.equal(validateFilmSources(selected,sources).durationSeconds,2);
  assert.deepEqual(buildFilmTimeline(selected,{beats:[]},sources).segments[0].target,mark.target);
  assert.equal(JSON.stringify({sources,selected}),before);
});
test('editorial observations distinguish moving camera during a gesture from objective errors',()=>{
  const selected=structuredClone(edit),sources=structuredClone(sourceSet);selected.narration=[];
  selected.pictures[0].cameraMove={startSeconds:0,durationSeconds:1,zoom:1.2,target:null};
  sources.sources[0].pointer=[{timeSeconds:1.2,x:200,y:200,type:'down',gesture:'drag'},{timeSeconds:1.8,x:600,y:200,type:'up',gesture:'drag'}];
  const observed=filmEditorialObservations(selected,sources),move=observed.find(item=>item.code==='CAMERA_DURING_RECORDED_GESTURE');
  assert.equal(move?.pictureId,'overview');assert.ok(Math.abs(move!.outputStartSeconds-.2)<1e-10);assert.ok(Math.abs(move!.outputEndSeconds-.8)<1e-10);assert.equal(move?.severity,'observation');
  assert.equal(validateFilmSources(selected,sources).pictureCount,2,'observation is not a validation rejection');
});
test('unknown speech duration is never estimated into a silent interval',()=>{
  const selected=structuredClone(edit);selected.narration[0].outputStartSeconds=0;
  assert.equal(filmEditorialObservations(selected,sourceSet).some(item=>item.code==='NARRATION_GAP'),false);
  const sources=structuredClone(sourceSet);sources.marks=[];selected.narration=[];
  assert.ok(filmEditorialObservations(selected,sources).some(item=>item.code==='NARRATION_GAP'));
});

test('independent speech crosses a picture cut with 1x picture playback and shot-relative captions',()=>{
  const timeline=buildFilmTimeline(edit,{beats:[speech()]},sourceSet);
  assert.equal(timeline.narration[0].outputStartSeconds,1);
  assert.equal(timeline.narration[0].durationSeconds,3);
  assert.deepEqual(timeline.segments.map(picture=>[picture.outputStartSeconds,picture.durationSeconds]),[[0,2],[2,4]]);
  assert.equal(frameState(timeline,119).sourceFrame,179);
  assert.equal(frameState(timeline,120).sourceFrame,360);
  assert.equal(captionOverlayAtFrame(timeline,119)?.placement.y,30);
  assert.equal(captionOverlayAtFrame(timeline,120)?.placement.y,900);
  assert.match(filmTimelineVtt(timeline),/00:00:01.000 --> 00:00:04.000/);
});
test('picture edits retain exact narration and never imply regenerated or retimed speech',()=>{
  const adjusted=structuredClone(edit);adjusted.pictures[0].zoom=1.2;adjusted.pictures[1].captionPlacement={x:200,y:20,width:1300};
  const original=buildFilmTimeline(edit,{beats:[speech()]},sourceSet),revised=buildFilmTimeline(adjusted,{beats:[speech()]},sourceSet);
  assert.deepEqual(revised.narration,original.narration);
  assert.equal(revised.segments.at(-1)!.outputStartSeconds+revised.segments.at(-1)!.durationSeconds,6);
});
test('actual speech duration cannot implicitly pad pictures or overlap another phrase',()=>{
  assert.throws(()=>buildFilmTimeline(edit,{beats:[speech(edit.narration[0].text,6)]},sourceSet),/FILM_NARRATION_EXCEEDS_PICTURES/);
  const overlapping=structuredClone(edit);overlapping.narration.push({id:'next',text:'Next result.',outputStartSeconds:2});
  assert.throws(()=>buildFilmTimeline(overlapping,{beats:[speech(),{...speech('Next result.',1),id:'next'}]},sourceSet),/FILM_NARRATION_OVERLAP/);
});
test('fit diagnostics measure every conflict rather than stopping at the first overlap',()=>{
  const overlapping=structuredClone(edit);overlapping.narration=[
    {id:'long',text:'A long phrase.',outputStartSeconds:0},
    {id:'middle',text:'A middle phrase.',outputStartSeconds:2},
    {id:'last',text:'A last phrase.',outputStartSeconds:5},
  ];
  const beats=overlapping.narration.map((phrase,index)=>({...speech(phrase.text,[6.004,3,1.001][index]),id:phrase.id}));
  const fit=measureFilmNarrationFit(overlapping,{beats},sourceSet);
  assert.equal(fit.status,'rejected');assert.equal(fit.conflictingPhraseCount,2);assert.equal(fit.pictureDurationSeconds,6);
  assert.deepEqual(fit.phrases[0],{phraseId:'long',outputStartSeconds:0,measuredDurationSeconds:6.004,measuredEndSeconds:6.004,occupiedDurationSeconds:361/60,occupiedEndSeconds:361/60,nextPhrase:{phraseId:'middle',outputStartSeconds:2,requiredClearanceSeconds:241/60},pictureEnd:{outputEndSeconds:6,requiredClearanceSeconds:1/60}});
  assert.equal(fit.phrases[1].nextPhrase?.requiredClearanceSeconds,0,'exactly adjacent speech fits');
  assert.equal(fit.phrases[2].pictureEnd.requiredClearanceSeconds,1/60);
  assert.ok(Math.abs(fit.phrases[2].measuredEndSeconds-6.001)<1e-12);
  assert.equal(fit.phrases[2].occupiedEndSeconds,361/60);
  assert.deepEqual(projectFilmNarrationFit(fit),fit);
  const corrupt=structuredClone(fit);corrupt.phrases[0].nextPhrase!.requiredClearanceSeconds=0;
  assert.equal(projectFilmNarrationFit(corrupt),null);
});
test('exact phrase and picture boundaries fit and sub-frame measurements remain distinct',()=>{
  const exact=structuredClone(edit);exact.narration=[{id:'first',text:'First.',outputStartSeconds:0},{id:'last',text:'Last.',outputStartSeconds:3}];
  const fit=measureFilmNarrationFit(exact,{beats:exact.narration.map(phrase=>({...speech(phrase.text,3),id:phrase.id}))},sourceSet);
  assert.equal(fit.status,'fits');assert.equal(fit.conflictingPhraseCount,0);
  assert.deepEqual(fit.phrases.map(phrase=>phrase.pictureEnd.requiredClearanceSeconds),[0,0]);
  assert.deepEqual(fit.phrases[0].nextPhrase,{phraseId:'last',outputStartSeconds:3,requiredClearanceSeconds:0});
  assert.equal(projectFilmNarrationFit({...fit,secret:'unadmitted raw text'}),null);
});
test('only marked settled source frames may become holds; calibration footage is excluded',()=>{
  const hold=structuredClone(edit);hold.narration=[];hold.pictures=[{id:'reading',sourceId:'take-one',kind:'hold',transition:'cut',startSeconds:9,durationSeconds:4,settledObservationId:'settled-one',zoom:1,target:null}];
  assert.equal(validateFilmSources(hold,sourceSet).durationSeconds,4);
  hold.pictures[0].startSeconds=7;assert.throws(()=>validateFilmSources(hold,sourceSet),/FILM_HOLD_NOT_SETTLED/);
  const early=structuredClone(edit);early.pictures[0].startSeconds=0;assert.throws(()=>validateFilmSources(early,sourceSet),/FILM_SOURCE_RANGE/);
  const late=structuredClone(edit);late.pictures[1].endSeconds=12;assert.throws(()=>validateFilmSources(late,sourceSet),/FILM_SOURCE_RANGE/);
});
test('validation rejects former beat coupling, speed fields, unsafe IDs and off-grid starts',()=>{
  assert.throws(()=>validateFilmEdit({...edit,beats:[]}),/INVALID_FILM_EDIT/);
  assert.throws(()=>validateFilmEdit({...edit,pictures:[{...edit.pictures[0],speed:2}]}),/INVALID_FILM_PICTURE/);
  assert.throws(()=>validateFilmEdit({...edit,narration:[{id:'../voice',text:'Hello.',outputStartSeconds:0}]}),/INVALID_FILM_NARRATION/);
  assert.throws(()=>validateFilmEdit({...edit,narration:[{...edit.narration[0],outputStartSeconds:0.001}]}),/FILM_TIME_NOT_FRAME_ALIGNED/);
});
test('caption completeness and fit are checked on both sides of a cut',()=>{
  assert.throws(()=>buildFilmTimeline(edit,{beats:[{...speech(),captions:[{text:'Compare the result.',startSeconds:0,endSeconds:3}]}]},sourceSet),/FILM_AUDIO_MISMATCH/);
  const narrow=structuredClone(edit);narrow.pictures[1].captionPlacement={x:0,y:10,width:40};
  assert.throws(()=>buildFilmTimeline(narrow,{beats:[speech()]},sourceSet),{code:'FILM_CAPTION_DOES_NOT_FIT',owner:'film-edit',caption:{pictureId:'result',phraseId:'introduction',captionIndex:0,placement:{x:0,y:10,width:40}}});
});
test('caption placement too narrow even for padding fails before measured narration',()=>{
  const narrow=structuredClone(edit);narrow.pictures[0].captionPlacement={x:0,y:10,width:28};
  assert.throws(()=>validateFilmEdit(narrow),{code:'INVALID_FILM_CAPTION_PLACEMENT',owner:'film-edit',caption:{pictureId:'overview',phraseId:null,placement:{x:0,y:10,width:28}}});
});
test('actual caption boxes cannot cover an explicitly declared picture subject',()=>{
  const covered=structuredClone(edit);covered.pictures[1].captionPlacement=undefined;
  // 0.6 scale places this subject at x=930..990, y=978..1014;
  // the default one-line caption backing is at y=974..1018.
  covered.pictures[1].target={x:1550,y:1630,width:100,height:60};
  assert.throws(()=>buildFilmTimeline(covered,{beats:[speech()]},sourceSet),error=>{
    const failure=error as {code:string;owner:string;caption:any};
    assert.equal(failure.code,'FILM_CAPTION_SUBJECT_OVERLAP');assert.equal(failure.owner,'film-edit');
    assert.equal(failure.caption.pictureId,'result');assert.equal(failure.caption.phraseId,'introduction');
    assert.equal(failure.caption.outputFrame,120);assert.equal(failure.caption.subjectKind,'picture-target');
    assert.deepEqual(failure.caption.projectedSubject,{x:930,y:978,width:60,height:36});
    assert.equal(failure.caption.captionBox.y,974);return true;
  });
});
test('caption fit failures give the minimum width for the measured cue',()=>{
  const narrow=structuredClone(edit);narrow.narration[0].text='iii';narrow.pictures[0].captionPlacement={x:0,y:10,width:40};
  assert.throws(()=>buildFilmTimeline(narrow,{beats:[speech('iii')]},sourceSet),{code:'FILM_CAPTION_DOES_NOT_FIT',recovery:/at least 52 output pixels/});
});
test('undeclared subjects, empty strip margins, touching edges and caption gaps do not become occlusion failures',()=>{
  const clear=structuredClone(edit);clear.pictures[1].captionPlacement=undefined;clear.narration[0].text='iii';
  buildFilmTimeline(clear,{beats:[speech('iii')]},sourceSet);
  clear.pictures[1].target={x:650,y:1625,width:60,height:60};
  buildFilmTimeline(clear,{beats:[speech('iii')]},sourceSet); // Within the strip, outside the text-sized box.
  clear.pictures[1].target={x:1550,y:1018/0.6,width:100,height:60};
  buildFilmTimeline(clear,{beats:[speech('iii')]},sourceSet); // Exact contact with the backing's bottom edge.
  clear.pictures[1].target={x:1550,y:1630,width:100,height:60};
  buildFilmTimeline(clear,{beats:[{...speech('iii'),captions:[{text:'iii',startSeconds:0,endSeconds:1.001}]}]},sourceSet);
  // The rounded caption ends at the cut, even though its measured end is just
  // beyond it. The next shot's subject is not covered by a nonexistent cue.
});
test('camera moves check intermediate caption-subject crossings and respect visible cue intervals',()=>{
  const moving=structuredClone(edit);moving.pictures=[{id:'pan',sourceId:'take-one',kind:'live',transition:'cut',startSeconds:1,endSeconds:7,zoom:1.5,target:{x:0,y:0,width:100,height:100},captionPlacement:{x:1400,y:980,width:400},cameraMove:{startSeconds:1,durationSeconds:4,zoom:1.5,target:{x:2600,y:1600,width:100,height:100}}}];
  moving.narration=[{id:'introduction',text:'iii',outputStartSeconds:0}];
  assert.throws(()=>buildFilmTimeline(moving,{beats:[speech('iii',6)]},sourceSet),error=>{
    const failure=error as {code:string;caption:any};assert.equal(failure.code,'FILM_CAPTION_SUBJECT_OVERLAP');
    assert.equal(failure.caption.subjectKind,'camera-move-target');assert.ok(failure.caption.outputFrame>180&&failure.caption.outputFrame<240);
    assert.deepEqual(failure.caption.captionBox,{x:1574,y:1006,width:52,height:44});return true;
  });
  // At the endpoints the initial subject is x=0..90,y=0..90 and the destination
  // is x=1380..1470,y=900..990; neither overlaps the actual caption backing.
  for(const [startSeconds,endSeconds] of [[0,1],[5,6]])buildFilmTimeline(moving,{beats:[{...speech('iii',6),captions:[{text:'iii',startSeconds,endSeconds}]}]},sourceSet);
});
test('film structure has no arbitrary narration phrase count cap',()=>{
  const many=structuredClone(edit);many.narration=Array.from({length:21},(_,i)=>({id:`phrase-${i}`,text:'A word.',outputStartSeconds:i/6}));
  assert.equal(validateFilmEdit(many).narration.length,21);
});
