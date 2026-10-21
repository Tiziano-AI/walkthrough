import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {Ajv2020} from 'ajv/dist/2020.js';
import {buildFilmTimeline,validateFilmEdit,validateFilmSources,type FilmEdit,type FilmEmphasis} from '../src/core/film-edit.ts';
import type {SourceSet} from '../src/project/contracts.ts';
import type {NarrationBeat} from '../src/audio/index.ts';
import {validateTimeline} from '../src/render/timeline.ts';

const sources:SourceSet={schemaVersion:1,kind:'source-set',id:'sources-emphasis',projectId:'project-test',createdAt:'2026-10-10T00:00:00Z',state:'sealed',mediaReview:'agent-reviewable-synthetic',sources:[{id:'take-one',media:{relativePath:'one.mp4',sha256:'a'.repeat(64),bytes:1},width:3200,height:1800,durationSeconds:12,frameCount:720,clock:{offsetSeconds:0,uncertaintySeconds:0,driftSeconds:0},pointer:[],usableRange:{startSeconds:0,endSeconds:12}}],marks:[{id:'subject',title:'Observed subject',sourceId:'take-one',timeSeconds:3,target:{x:1000,y:600,width:400,height:240}}],artifacts:[]};
const edit:FilmEdit={schemaVersion:1,sourceSetId:sources.id,sourceSetSha256:'b'.repeat(64),title:'Follow a product response',brief:'Show a retained relationship.',voiceId:'copilot-female-1',pictures:[{id:'response',sourceId:'take-one',kind:'live',transition:'cut',startSeconds:2,endSeconds:8,zoom:1,target:null}],narration:[]};
const emphasis:FilmEmphasis={id:'relationship',kind:'outline',target:{markId:'subject'},startSeconds:1,endSeconds:3};
const withEmphasis=(items:unknown[])=>({...structuredClone(edit),pictures:[{...structuredClone(edit.pictures[0]),emphasis:items}]} as FilmEdit);
const schema=JSON.parse(await readFile(new URL('../docs/schemas/film-edit.schema.json',import.meta.url),'utf8'));
// Picture kind branches refer to fields declared on their enclosing object.
const schemaValidate=new Ajv2020({strict:true,strictRequired:false,allErrors:true}).compile(schema);
function speech(text='iii',duration=6):NarrationBeat{return {id:'voice',text,wavPath:'/retained/voice.wav',durationSeconds:duration,words:[],captions:[{text,startSeconds:0,endSeconds:duration}],cacheHit:true,wavSha256:'c'.repeat(64),unresolvedWordCount:0,metrics:{durationSeconds:duration,sampleRate:24000,channels:1,peak:0.5,rms:0.1,clippedSampleFraction:0,wordsPerMinute:120}};}

test('optional emphasis resolves exact sealed marks offline and leaves historical edit/source bytes untouched',()=>{
  const original=JSON.stringify(edit),sourceBytes=JSON.stringify(sources);
  assert.equal(validateFilmEdit(edit),edit);
  const oldTimeline=buildFilmTimeline(edit,{beats:[]},sources);
  assert.equal(Object.hasOwn(oldTimeline.segments[0],'emphasis'),false);
  const selected=withEmphasis([emphasis]),bytes=JSON.stringify(selected);
  const timeline=buildFilmTimeline(selected,{beats:[]},sources);
  assert.deepEqual(timeline.segments[0].emphasis,[{...emphasis,target:sources.marks[0].target}]);
  assert.equal(JSON.stringify(selected),bytes);assert.equal(JSON.stringify(edit),original);assert.equal(JSON.stringify(sources),sourceBytes);
  assert.equal(schemaValidate(selected),true,JSON.stringify(schemaValidate.errors));
  assert.equal(schemaValidate(edit),true,JSON.stringify(schemaValidate.errors));
});

test('strict emphasis shape rejects null, unknown fields and nonpositive geometry in runtime and shipped schema',()=>{
  const invalid=[null,{}, {...emphasis,kind:'arrow'}, {...emphasis,id:''}, {...emphasis,target:null},
    {...emphasis,style:{color:'red'}}, {...emphasis,label:'Look here'}, {...emphasis,track:true},
    {...emphasis,target:{...sources.marks[0].target!,width:0}}, {...emphasis,target:{...sources.marks[0].target!,height:-1}},
    {...emphasis,target:{markId:'subject',sourceId:'take-one'}}, {...emphasis,target:{...sources.marks[0].target!,units:'px'}},
    {...emphasis,startSeconds:-1},{...emphasis,endSeconds:0}];
  for(const item of invalid){
    assert.throws(()=>validateFilmEdit(withEmphasis([item])),{code:'INVALID_FILM_EMPHASIS'},JSON.stringify(item));
    assert.equal(schemaValidate(withEmphasis([item])),false,`Schema admitted ${JSON.stringify(item)}`);
  }
  assert.throws(()=>validateFilmEdit(withEmphasis([emphasis,emphasis])),{code:'INVALID_FILM_EMPHASIS',location:{pictureId:'response',field:'emphasis',emphasisId:'relationship'}});
  assert.throws(()=>validateFilmEdit({...edit,pictures:[{...edit.pictures[0],emphasis:{} as any}]}),{code:'INVALID_FILM_EMPHASIS'});
});

test('emphasis is frame-aligned, picture-local, positive and inside either live or held pictures',()=>{
  for(const change of [{startSeconds:1,endSeconds:1},{endSeconds:6+1/60},{startSeconds:0.001},{endSeconds:3.001}])
    assert.throws(()=>validateFilmEdit(withEmphasis([{...emphasis,...change}])),{code:Object.values(change).some(value=>value===.001||value===3.001)?'FILM_TIME_NOT_FRAME_ALIGNED':'INVALID_FILM_EMPHASIS'});
  const selected=withEmphasis([{...emphasis,startSeconds:0,endSeconds:6}]);
  assert.equal(validateFilmSources(selected,sources).durationSeconds,6);
  const held=structuredClone(selected);held.pictures[0]={...held.pictures[0],kind:'hold',endSeconds:undefined,durationSeconds:6,settledObservationId:'subject',startSeconds:3};
  const observed=structuredClone(sources);observed.marks[0].settled={startSeconds:3,endSeconds:4,method:'observed-stability'};
  assert.equal(validateFilmSources(held,observed).durationSeconds,6);
  selected.pictures.push({...structuredClone(selected.pictures[0]),id:'second'});
  assert.equal(validateFilmEdit(selected).pictures.length,2,'Emphasis IDs are picture-local, not a new global namespace');
});

test('mark lookup and source geometry failures identify the exact emphasis, without accepting a mark from another source',()=>{
  const selected=withEmphasis([emphasis]),wrong=structuredClone(sources);
  wrong.marks[0].sourceId='another-take';
  assert.throws(()=>validateFilmSources(selected,wrong),{code:'FILM_TARGET_MARK_INVALID',location:{pictureId:'response',field:'emphasis.target',emphasisId:'relationship',markId:'subject'}});
  wrong.marks[0].sourceId='take-one';wrong.marks[0].target!.x=3199;
  assert.throws(()=>validateFilmSources(selected,wrong),{code:'FILM_TARGET_GEOMETRY',location:{pictureId:'response',field:'emphasis.target',emphasisId:'relationship',markId:'subject'}});
  const missing=structuredClone(sources);missing.marks[0].target=null;
  assert.throws(()=>validateFilmSources(selected,missing),{code:'FILM_TARGET_MARK_INVALID'});
});

test('one spotlight is active at most; exclusive-end adjacency and overlapping comparison outlines are allowed',()=>{
  const first={...emphasis,kind:'spotlight' as const},second={...first,id:'another',startSeconds:3,endSeconds:5};
  validateFilmSources(withEmphasis([first,second]),sources);
  validateFilmSources(withEmphasis([emphasis,{...emphasis,id:'compare'}]),sources);
  assert.throws(()=>validateFilmEdit(withEmphasis([first,{...second,startSeconds:3-1/60}])),{code:'FILM_EMPHASIS_SPOTLIGHT_OVERLAP',location:{pictureId:'response',field:'emphasis',emphasisId:'another'}});
  const timeline=buildFilmTimeline(withEmphasis([first,second]),{beats:[]},sources);
  timeline.segments[0].emphasis![1].startSeconds=2;
  assert.throws(()=>validateTimeline(timeline),{message:'render:overlapping_spotlights',segmentId:'response',emphasisId:'another'});
  const invalid=buildFilmTimeline(withEmphasis([emphasis]),{beats:[]},sources);
  (invalid.segments[0].emphasis![0] as any).label='Unexpected';
  assert.throws(()=>validateTimeline(invalid),{message:'render:invalid_emphasis'});
});

test('an emphasized subject must stay visible throughout its active camera move, but not outside its interval',()=>{
  const selected=withEmphasis([{...emphasis,target:{x:0,y:0,width:100,height:100},startSeconds:0,endSeconds:3}]);
  selected.pictures[0].cameraMove={startSeconds:1,durationSeconds:2,zoom:1.5,target:null};
  assert.throws(()=>validateFilmSources(selected,sources),error=>{
    const failure=error as {code:string;location:{pictureId:string;emphasisId:string;outputFrame:number}};
    assert.equal(failure.code,'FILM_EMPHASIS_HIDDEN_BY_FRAMING');assert.equal(failure.location.pictureId,'response');assert.equal(failure.location.emphasisId,'relationship');
    assert.ok(failure.location.outputFrame>60&&failure.location.outputFrame<180);return true;
  });
  selected.pictures[0].emphasis![0].endSeconds=1;
  validateFilmSources(selected,sources); // End before the detail framing crops the subject.
});

test('actual caption protection includes only active emphasis and reports its identity at the conflicting frame',()=>{
  const selected=withEmphasis([{...emphasis,target:{x:1550,y:1630,width:100,height:60},startSeconds:3,endSeconds:4}]);
  selected.narration=[{id:'voice',text:'iii',outputStartSeconds:0}];
  assert.throws(()=>buildFilmTimeline(selected,{beats:[speech()]},sources),error=>{
    const failure=error as {code:string;caption:any};assert.equal(failure.code,'FILM_CAPTION_SUBJECT_OVERLAP');
    assert.equal(failure.caption.emphasisId,'relationship');assert.equal(failure.caption.subjectKind,'emphasis-target');assert.equal(failure.caption.outputFrame,180);
    assert.deepEqual(failure.caption.projectedSubject,{x:930,y:978,width:60,height:36});return true;
  });
  buildFilmTimeline(selected,{beats:[{...speech(),captions:[{text:'iii',startSeconds:0,endSeconds:3}]}]},sources);
  selected.pictures[0].captionPlacement={x:100,y:30,width:1400};
  buildFilmTimeline(selected,{beats:[speech()]},sources);
});

test('camera motion checks intermediate caption-emphasis intersections rather than just its resting endpoints',()=>{
  const selected=withEmphasis([{...emphasis,target:{x:1600,y:900,width:100,height:100},startSeconds:0,endSeconds:6}]);
  selected.pictures[0].zoom=1.5;selected.pictures[0].target={x:0,y:0,width:100,height:100};
  selected.pictures[0].cameraMove={startSeconds:1,durationSeconds:4,zoom:1.5,target:{x:3000,y:1600,width:100,height:100}};
  selected.pictures[0].captionPlacement={x:800,y:480,width:400};selected.narration=[{id:'voice',text:'iii',outputStartSeconds:0}];
  assert.throws(()=>buildFilmTimeline(selected,{beats:[speech()]},sources),error=>{
    const failure=error as {code:string;caption:any};assert.equal(failure.code,'FILM_CAPTION_SUBJECT_OVERLAP');
    assert.equal(failure.caption.emphasisId,'relationship');assert.equal(failure.caption.subjectKind,'emphasis-target');assert.ok(failure.caption.outputFrame>60&&failure.caption.outputFrame<300);return true;
  });
  for(const [startSeconds,endSeconds] of [[0,1],[5,6]])buildFilmTimeline(selected,{beats:[{...speech(),captions:[{text:'iii',startSeconds,endSeconds}]}]},sources);
});
