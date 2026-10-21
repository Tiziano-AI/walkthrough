import assert from 'node:assert/strict';
import test from 'node:test';
import type {NarrationBeat,NarrationWord} from '../src/audio/index.ts';
import type {FilmEdit} from '../src/core/film-edit.ts';
import {filmEditorialObservations} from '../src/core/film-editorial.ts';
import {pictureTimeline} from '../src/core/film-edit.ts';
import {frameState} from '../src/render/timeline.ts';
import type {SourceSet} from '../src/project/contracts.ts';

const sources:SourceSet={schemaVersion:1,kind:'source-set',id:'sources-editorial',projectId:'project-editorial',createdAt:'2026-10-10T00:00:00Z',state:'sealed',mediaReview:'agent-reviewable-synthetic',sources:[{
  id:'take-one',media:{relativePath:'one.mp4',sha256:'a'.repeat(64),bytes:1},width:3200,height:1800,durationSeconds:30,frameCount:1800,
  clock:{offsetSeconds:0,uncertaintySeconds:0,driftSeconds:0},pointer:[],usableRange:{startSeconds:0,endSeconds:30},
}],marks:[],artifacts:[]};
const edit:FilmEdit={schemaVersion:1,sourceSetId:sources.id,sourceSetSha256:'b'.repeat(64),title:'Inspect a product',brief:'See the gesture and response.',voiceId:'copilot-female-1',pictures:[
  {id:'context',sourceId:'take-one',kind:'live',transition:'cut',startSeconds:0,endSeconds:2,zoom:1,target:null},
  {id:'response',sourceId:'take-one',kind:'live',transition:'cut',startSeconds:5,endSeconds:11,zoom:1,target:null},
],narration:[{id:'before',text:'Observe the first relationship.',outputStartSeconds:0},{id:'after',text:'Follow the changed relationship.',outputStartSeconds:5}]};
function beat(id:string,text:string,durationSeconds:number,words:NarrationWord[]=[]):NarrationBeat{
  return {id,text,durationSeconds,words,wavPath:`/retained/${id}.wav`,captions:[{text,startSeconds:0,endSeconds:durationSeconds}],cacheHit:true,wavSha256:'c'.repeat(64),unresolvedWordCount:0,
    metrics:{durationSeconds,sampleRate:24000,channels:1,peak:0.5,rms:0.1,clippedSampleFraction:0,wordsPerMinute:120}};
}
function aligned(text:string,intervals:number[][]):NarrationWord[]{
  return [...text.matchAll(/\S+/gu)].map((token,index)=>({text:token[0],charStart:token.index,charEnd:token.index+token[0].length,startSeconds:intervals[index][0],endSeconds:intervals[index][1],timingResolved:true}));
}
const gaps=(selected=edit,retained=sources,audio?:{beats:NarrationBeat[]})=>filmEditorialObservations(selected,retained,audio).filter(item=>item.code==='NARRATION_GAP');

test('one measured narration gap crosses a cut and pointer/mark events never break it',()=>{
  const retained=structuredClone(sources);
  retained.sources[0].pointer=[
    {timeSeconds:1.5,x:100,y:100,type:'move'},
    {timeSeconds:6,x:101,y:100,type:'move'},
    {timeSeconds:6.5,x:101,y:100,type:'down'},
    {timeSeconds:6.6,x:101,y:100,type:'up'},
    {timeSeconds:7.5,x:102,y:100,type:'move'},
  ];
  retained.marks=[{id:'changed',title:'The revealed response',sourceId:'take-one',timeSeconds:7,target:{x:100,y:100,width:400,height:200}}];
  const audio={beats:edit.narration.map(phrase=>beat(phrase.id,phrase.text,1))};
  const before=JSON.stringify({edit,retained,audio}),observations=gaps(edit,retained,audio);
  assert.equal(observations.length,1);
  const observation=observations[0];
  assert.deepEqual([observation.outputStartSeconds,observation.outputEndSeconds],[1,5]);
  assert.deepEqual(observation.preview,{fromSeconds:1,toSeconds:5});
  assert.equal(observation.speech?.before?.phraseId,'before');
  assert.equal(observation.speech?.after?.phraseId,'after');
  assert.equal(observation.speech?.timingBasis,'measured-audio-span');
  assert.equal(observation.context.totalPictures,2);
  assert.deepEqual(observation.context.pictures.map(picture=>[picture.pictureId,picture.outputStartSeconds,picture.outputEndSeconds,picture.sourceStartSeconds,picture.sourceEndSeconds]),[
    ['context',1,2,1,2],['response',2,5,5,8],
  ]);
  assert.equal(observation.context.pictures[0].pointer.moveCount,1);
  assert.equal(observation.context.pictures[1].pointer.moveCount,2);
  assert.equal(observation.context.pictures[1].pointer.totalGestures,1);
  assert.equal(observation.context.pictures[1].marks[0].outputTimeSeconds,4);
  assert.equal(observation.severity,'observation');
  assert.equal(JSON.stringify({edit,retained,audio}),before,'inspection never rewrites edit, audio or sealed sources');
});

test('complete resolved word timing exposes leading, internal and trailing intervals with its alignment basis',()=>{
  const selected=structuredClone(edit);selected.pictures=[{...selected.pictures[0],endSeconds:14}];
  selected.narration=[{id:'phrase',text:'Observe the response.',outputStartSeconds:0}];
  // Controlled aligned spans, not evidence of acoustic silence or natural speech.
  const words=aligned(selected.narration[0].text,[[3.1,3.5],[6.7,7],[7,7.8]]);
  const observed=gaps(selected,sources,{beats:[beat('phrase',selected.narration[0].text,11,words)]});
  assert.deepEqual(observed.map(item=>[item.outputStartSeconds,item.outputEndSeconds]),[[0,3.1],[3.5,6.7],[7.8,14]]);
  assert.deepEqual(observed.map(item=>item.speech?.timingBasis),Array(3).fill('resolved-word-alignment'));
  assert.equal(observed[1].speech?.before?.phraseId,'phrase');
  assert.equal(observed[1].speech?.before?.word?.text,'Observe');
  assert.equal(observed[1].speech?.after?.word?.text,'the');
  assert.equal(observed[1].speech?.spokenContentVerified,false);
  assert.match(observed[1].detail,/alignment evidence/);
  assert.deepEqual(observed[1].preview,{fromSeconds:3.5,toSeconds:6.7});
});

test('unresolved, incomplete, incoherent or absent word timing conservatively occupies the measured WAV',()=>{
  const selected=structuredClone(edit);selected.pictures=[{...selected.pictures[0],endSeconds:14}];selected.narration=[{id:'phrase',text:'Observe the response.',outputStartSeconds:0}];
  const complete=beat('phrase',selected.narration[0].text,11,aligned(selected.narration[0].text,[[3.1,3.5],[6.7,7],[7,7.8]]));
  const unresolved=structuredClone(complete);unresolved.words[1].timingResolved=false;unresolved.unresolvedWordCount=1;
  const missingWord=structuredClone(complete);missingWord.words.splice(1,1);
  const wrongCanonical=structuredClone(complete);wrongCanonical.words[0].text='Invented';
  const wrongOffset=structuredClone(complete);wrongOffset.words[1].charStart=0;
  const reversed=structuredClone(complete);reversed.words[1].startSeconds=3;
  const pastWav=structuredClone(complete);pastWav.words[2].endSeconds=12;
  const nonfinite=structuredClone(complete);nonfinite.words[0].startSeconds=NaN;
  const absent=structuredClone(complete);absent.words=[];
  for(const audio of [unresolved,missingWord,wrongCanonical,wrongOffset,reversed,pastWav,nonfinite,absent]){
    const observed=gaps(selected,sources,{beats:[audio]});
    assert.deepEqual(observed.map(item=>[item.outputStartSeconds,item.outputEndSeconds]),[[11,14]]);
    assert.equal(observed[0].speech?.timingBasis,'measured-audio-span');
    assert.equal(observed[0].speech?.before?.word,undefined);
  }
});

test('unmeasured or mismatched speech cannot be inferred silent after dispatch placement',()=>{
  assert.deepEqual(gaps(),[]);
  const audio={beats:[beat('before','The previous script is not this script.',1),beat('after',edit.narration[1].text,1)]};
  assert.deepEqual(gaps(edit,sources,audio),[]);
  for(const duration of [NaN,Infinity,0,-1]){
    assert.deepEqual(gaps(edit,sources,{beats:[beat('before',edit.narration[0].text,duration)]}),[]);
  }
  const selected=structuredClone(edit);selected.narration=[{...selected.narration[0],outputStartSeconds:4}];
  const observed=gaps(selected);
  assert.deepEqual(observed.map(item=>[item.outputStartSeconds,item.outputEndSeconds]),[[0,4]]);
  assert.equal(observed[0].speech?.after?.timingBasis,'unmeasured-narration');
  assert.equal(observed[0].speech?.after?.outputEndSeconds,null);
});

test('camera gesture observations retain local framing, recorded action and canonical mark geometry',()=>{
  const retained=structuredClone(sources),selected=structuredClone(edit),box={x:100,y:100,width:500,height:200};
  retained.marks=[{id:'subject',title:'The relevant relationship',sourceId:'take-one',timeSeconds:1,target:box}];
  retained.sources[0].pointer=[{timeSeconds:.5,x:200,y:200,type:'down',gesture:'drag'},{timeSeconds:1.5,x:600,y:200,type:'up',gesture:'drag'}];
  selected.pictures[0].target={markId:'subject'};
  selected.pictures[0].cameraMove={startSeconds:0,durationSeconds:1,zoom:1.2,target:{markId:'subject'}};
  const observation=filmEditorialObservations(selected,retained).find(item=>item.code==='CAMERA_DURING_RECORDED_GESTURE')!;
  assert.deepEqual([observation.outputStartSeconds,observation.outputEndSeconds],[.5,1]);
  assert.deepEqual(observation.context.pictures[0].framing.target,box);
  assert.deepEqual(observation.context.pictures[0].cameraMove,{outputStartSeconds:.5,outputEndSeconds:1,zoom:1.2,target:box});
  assert.deepEqual(observation.context.pictures[0].pointer.gestures,[{kind:'drag',sourceStartSeconds:.5,sourceEndSeconds:1,outputStartSeconds:.5,outputEndSeconds:1}]);
  assert.equal(observation.speech,undefined);
});

test('untagged retained gestures use measured trajectory recognition, not click labels or inferred app effects',()=>{
  const retained=structuredClone(sources),selected=structuredClone(edit);selected.narration=[];
  retained.sources[0].pointer=[
    // The path moves more than 3 pixels and returns: endpoint distance is zero.
    {timeSeconds:.1,x:100,y:100,type:'down'},
    {timeSeconds:.2,x:104,y:100,type:'move'},
    {timeSeconds:.3,x:100,y:100,type:'up'},
    // Exactly 3 pixels stays a click, matching the renderer's strict boundary.
    {timeSeconds:.4,x:100,y:100,type:'down'},
    {timeSeconds:.5,x:103,y:100,type:'move'},
    {timeSeconds:.6,x:100,y:100,type:'up'},
    // Explicit recorded drag remains a drag without a displacement sample.
    {timeSeconds:.7,x:100,y:100,type:'down',gesture:'drag'},
    {timeSeconds:.8,x:100,y:100,type:'up'},
    {timeSeconds:.9,x:100,y:100,type:'down'},
    {timeSeconds:.95,x:100,y:100,type:'up'},
    // Motion after release must not retroactively classify the previous click.
    {timeSeconds:1,x:500,y:100,type:'move'},
    {timeSeconds:1.1,x:100,y:100,type:'down'},
    // A move at release has no recorded button-down movement interval.
    {timeSeconds:1.2,x:500,y:100,type:'move'},
    {timeSeconds:1.2,x:100,y:100,type:'up'},
  ];
  const gestures=gaps(selected,retained)[0].context.pictures[0].pointer.gestures;
  assert.deepEqual(gestures.map(gesture=>gesture.kind),['drag','click','drag','click','click']);
  const timeline=pictureTimeline(selected,retained);
  assert.deepEqual([.2,.5,.75,.925,1.15].map(seconds=>frameState(timeline,Math.round(seconds*60)).cursor?.dragging),[true,false,true,false,false]);
});

test('gap context clips active emphasis and resolves its mark on the picture source',()=>{
  const retained=structuredClone(sources),selected=structuredClone(edit),box={x:100,y:100,width:500,height:200};
  retained.marks=[{id:'subject',title:'The relevant relationship',sourceId:'take-one',timeSeconds:7,target:box}];
  selected.pictures[1].emphasis=[
    {id:'attention',kind:'outline',target:{markId:'subject'},startSeconds:2,endSeconds:5},
    {id:'later',kind:'spotlight',target:box,startSeconds:4,endSeconds:5},
  ];
  const observed=gaps(selected,retained,{beats:selected.narration.map(phrase=>beat(phrase.id,phrase.text,1))});
  assert.deepEqual(observed[0].context.pictures[1].emphasis,[{id:'attention',kind:'outline',target:box,outputStartSeconds:4,outputEndSeconds:5}]);
  assert.equal(observed[0].context.pictures[1].totalEmphasis,1);
});

test('a gap after a completed camera move reports destination framing, not the original shot',()=>{
  const selected=structuredClone(edit),box={x:100,y:100,width:500,height:200};
  selected.pictures=[{...selected.pictures[0],endSeconds:8,cameraMove:{startSeconds:0,durationSeconds:1,zoom:1.2,target:box}}];
  selected.narration=[selected.narration[0]];
  const picture=gaps(selected,sources,{beats:[beat('before',selected.narration[0].text,2)]})[0].context.pictures[0];
  assert.deepEqual(picture.framing,{zoom:1.2,target:box,cameraAtIntervalStart:'destination'});
  assert.equal(picture.cameraMove,null);
});

test('silent footage is inspectable and contextual collections are bounded with exact totals',()=>{
  const selected=structuredClone(edit),retained=structuredClone(sources);selected.narration=[];
  selected.pictures=Array.from({length:10},(_,index)=>({...edit.pictures[0],id:`picture-${index}`,startSeconds:index*2,endSeconds:index*2+2}));
  retained.marks=Array.from({length:10},(_,index)=>({id:`mark-${index}`,title:'A'.repeat(300),sourceId:'take-one',timeSeconds:.1+index*.1,target:null}));
  retained.sources[0].pointer=Array.from({length:10},(_,index)=>[
    {timeSeconds:.1+index*.1,x:100,y:100,type:'down' as const},
    {timeSeconds:.15+index*.1,x:100,y:100,type:'up' as const},
  ]).flat();
  const observation=gaps(selected,retained)[0];
  assert.deepEqual([observation.outputStartSeconds,observation.outputEndSeconds],[0,20]);
  assert.equal(observation.speech?.timingBasis,'no-narration');
  assert.equal(observation.context.pictures.length,8);
  assert.equal(observation.context.totalPictures,10);assert.equal(observation.context.picturesTruncated,true);
  const picture=observation.context.pictures[0];
  assert.equal(picture.marks.length,6);assert.equal(picture.totalMarks,10);assert.equal(picture.marksTruncated,true);
  assert.equal(picture.marks[0].title.length,180);assert.equal(picture.marks[0].titleTruncated,true);
  assert.equal(picture.pointer.gestures.length,6);assert.equal(picture.pointer.totalGestures,10);assert.equal(picture.pointer.gesturesTruncated,true);
  assert.equal(Object.hasOwn(picture.pointer,'samples'),false,'context does not return raw pointer samples');
});

test('settled holds describe their retained frame rather than replaying pointer events',()=>{
  const selected=structuredClone(edit),retained=structuredClone(sources);selected.narration=[];
  retained.marks=[{id:'settled',title:'Read the result',sourceId:'take-one',timeSeconds:8,target:null,settled:{startSeconds:8,endSeconds:10,method:'observed-stability'}}];
  retained.sources[0].pointer=[{timeSeconds:8,x:100,y:100,type:'move'}];
  selected.pictures=[{id:'reading',sourceId:'take-one',kind:'hold',transition:'cut',startSeconds:9,durationSeconds:4,settledObservationId:'settled',zoom:1,target:null}];
  const picture=gaps(selected,retained)[0].context.pictures[0];
  assert.deepEqual([picture.sourceStartSeconds,picture.sourceEndSeconds],[9,9]);
  assert.equal(picture.pointer.moveCount,0);assert.equal(picture.marks[0].outputTimeSeconds,null);
  assert.equal(picture.marks[0].settled,true);
});

test('preview ranges enclose subframe alignment boundaries on the existing 60 fps clock',()=>{
  const selected=structuredClone(edit);selected.pictures=[{...selected.pictures[0],endSeconds:12}];
  selected.narration=[{id:'phrase',text:'Observe the response.',outputStartSeconds:0}];
  const observed=gaps(selected,sources,{beats:[beat('phrase',selected.narration[0].text,7,aligned(selected.narration[0].text,[[0,.333],[3.444,3.8],[3.8,4.2]]))]});
  assert.deepEqual(observed[0].preview,{fromSeconds:19/60,toSeconds:207/60});
  assert.equal(observed[0].outputStartSeconds,.333);assert.equal(observed[0].outputEndSeconds,3.444);
});
