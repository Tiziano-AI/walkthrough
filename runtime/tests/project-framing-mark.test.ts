import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileDigest} from '../src/core/files.ts';
import {sealTakes,sourceMarks,type RawMark} from '../src/project/capture.ts';
import {createProject,loadSourceSet,ownedDirectory,saveJson,validateSourceSet} from '../src/project/store.ts';
import type {FilmSource,MarkTargetObservation,SourceSet,TakeRecord} from '../src/project/contracts.ts';

const origin:MarkTargetObservation={observationId:'surface-one',observedAt:'2026-10-08T10:00:00.000Z',pageId:'page-one',frameId:'frame-one',documentId:'document-one',markId:'dom',ref:'ref-one',coordinateSpace:'css',box:{x:100,y:80,width:140,height:50},viewport:{width:1600,height:900}};
const source:FilmSource={id:'take-observed',media:{relativePath:'source.mp4',sha256:'a'.repeat(64),bytes:1},width:3200,height:1800,durationSeconds:4,frameCount:240,clock:{offsetSeconds:0,uncertaintySeconds:0,driftSeconds:0},pointer:[],usableRange:{startSeconds:.5,endSeconds:3.5}};
const raw:RawMark[]=[{id:'dom',title:'DOM subject',atMs:1000,target:{...origin.box},targetObservation:origin},
  {id:'canvas',title:'Canvas subject',atMs:2000,target:{x:400,y:125,width:300,height:200},targetObservation:{...origin,markId:'canvas',ref:undefined,coordinateSpace:'screenshot',box:{x:800,y:250,width:600,height:400},screenshotPixels:{width:3200,height:1800}}}];
function sourceSet():SourceSet{return {schemaVersion:1,kind:'source-set',id:'sources-observed',projectId:'project',createdAt:'2026-10-08T10:00:00.000Z',state:'sealed',mediaReview:'agent-reviewable-synthetic',sources:[structuredClone(source)],marks:sourceMarks(raw,source,ms=>ms/1000),artifacts:[]};}

async function fixture(t:TestContext,sourceId=source.id,existingProjectPath?:string){
  let projectPath=existingProjectPath;
  if(!projectPath){
    const root=await mkdtemp('/private/tmp/wt-framing-source-');projectPath=join(root,'project');t.after(()=>rm(root,{recursive:true,force:true}));
    await createProject(projectPath,{title:'Observed framing retention',brief:'Retain exact observed geometry offline.',audience:'Test',mandate:{applicationUrl:'http://127.0.0.1/',navigationOrigins:['http://127.0.0.1'],network:'loopback-only',allowedEffects:'None; synthetic byte retention test.',dataDescription:'Synthetic fixture bytes',inputRoots:[],mediaReview:'agent-reviewable-synthetic',delivery:'local'}});
  }
  const directory=await ownedDirectory(projectPath,'takes',sourceId),media=join(directory,'source.mp4');await writeFile(media,'synthetic-retained-byte-fixture');
  const record:TakeRecord={schemaVersion:1,id:sourceId,sessionId:'session',pageId:origin.pageId,title:'Observed source',createdAt:'2026-10-08T10:00:00.000Z',state:'stopped',source:{...structuredClone(source),id:sourceId,media:{relativePath:'source.mp4',bytes:30,sha256:await fileDigest(media)}},marks:sourceSet().marks.map(mark=>({...mark,sourceId})),eventsPath:'input-events.json'};
  record.source!.media.bytes=(await readFile(media)).length;
  await saveJson(join(directory,'take.json'),record);
  for(const name of ['input-events.json','capture-clock.json','capture-analysis.json'])await saveJson(join(directory,name),[]);
  await saveJson(join(directory,'raw-marks.json'),raw);
  return {projectPath,directory,record};
}

test('source mapping preserves observation origin and maps geometry once without implying settlement',()=>{
  const set=sourceSet();assert.equal(validateSourceSet(set),set);
  assert.deepEqual(set.marks.map(mark=>mark.target),[{x:200,y:160,width:280,height:100},{x:800,y:250,width:600,height:400}]);
  assert.deepEqual(set.marks.map(mark=>mark.targetObservation),raw.map(mark=>mark.targetObservation));
  assert.ok(set.marks.every(mark=>mark.settled===undefined));
  set.marks[0].targetObservation!.box.x=110;assert.equal(origin.box.x,100,'mapped sources own a copy, not live observation state');
  const settled=sourceMarks([{...raw[0],settled:{startMs:100,endMs:1200}}],source,ms=>ms/1000)[0];
  assert.deepEqual(settled.settled,{startSeconds:.5,endSeconds:1.2,method:'observed-stability'});
});

test('sealing preserves returned mark IDs and their observed origin offline',async t=>{
  const f=await fixture(t),before=await readFile(join(f.directory,'take.json'));
  const sealed=await sealTakes({projectPath:f.projectPath,takeIds:[source.id]}),loaded=await loadSourceSet(f.projectPath,sealed.sourceSet.id);
  assert.deepEqual(loaded.sourceSet.marks.map(mark=>mark.id),raw.map(mark=>mark.id));
  assert.deepEqual(loaded.sourceSet.marks.map(mark=>mark.target),f.record.marks.map(mark=>mark.target));
  assert.deepEqual(loaded.sourceSet.marks.map(mark=>mark.targetObservation),JSON.parse(JSON.stringify(raw.map(mark=>mark.targetObservation))));
  assert.equal(loaded.sourceSet.marks[0].sourceId,source.id);assert.equal(loaded.sourceSet.marks[0].targetObservation?.markId,'dom');
  assert.deepEqual(await readFile(join(f.directory,'take.json')),before,'sealing copies rather than rewrites take provenance');
  const retainedRaw=loaded.sourceSet.records!.find(record=>record.relativePath.endsWith('/raw-marks.json'))!;
  assert.deepEqual(JSON.parse(await readFile(join(loaded.directory,retainedRaw.relativePath),'utf8')),JSON.parse(JSON.stringify(raw)));
});

test('sealing admits the same mark name on different takes without renaming either',async t=>{
  const first=await fixture(t),second=await fixture(t,'take-second',first.projectPath);
  const before=await Promise.all([first,second].map(f=>readFile(join(f.directory,'take.json'))));
  const sealed=await sealTakes({projectPath:first.projectPath,takeIds:[first.record.id,second.record.id]});
  const loaded=await loadSourceSet(first.projectPath,sealed.sourceSet.id);
  assert.deepEqual(loaded.sourceSet.marks.map(mark=>[mark.sourceId,mark.id]),[
    ['take-observed','dom'],['take-observed','canvas'],['take-second','dom'],['take-second','canvas'],
  ]);
  for(const [index,f] of [first,second].entries())assert.deepEqual(await readFile(join(f.directory,'take.json')),before[index]);
  const duplicate=structuredClone(loaded.sourceSet);duplicate.marks.push(structuredClone(duplicate.marks[0]));
  assert.throws(()=>validateSourceSet(duplicate),{code:'INVALID_SOURCE_SET'});
});

test('sealing refuses framing reassigned to a different source, page or original mark',async t=>{
  const f=await fixture(t);
  for(const mutate of [(record:TakeRecord)=>{record.marks[0].sourceId='different-source';},(record:TakeRecord)=>{record.marks[0].targetObservation!.pageId='different-page';},(record:TakeRecord)=>{record.marks[0].targetObservation!.markId='different-mark';}]){
    const record=structuredClone(f.record);mutate(record);await saveJson(join(f.directory,'take.json'),record);
    await assert.rejects(sealTakes({projectPath:f.projectPath,takeIds:[source.id]}),{code:'MARK_SOURCE_MISMATCH'});
  }
});

test('observed source geometry rejects missing or inconsistent provenance without changing historical source sets',()=>{
  const historical=sourceSet();for(const mark of historical.marks)delete mark.targetObservation;
  const bytes=JSON.stringify(historical);assert.equal(validateSourceSet(historical),historical);assert.equal(JSON.stringify(historical),bytes);
  for(const mutate of [(set:SourceSet)=>{set.marks[0].target=null;},(set:SourceSet)=>{set.marks[0].target!.x+=1;},
    (set:SourceSet)=>{set.marks[0].targetObservation!.viewport.width=3200;},(set:SourceSet)=>{set.marks[0].targetObservation!.observedAt='not-a-date';},
    (set:SourceSet)=>{set.marks[1].targetObservation!.screenshotPixels=undefined;},(set:SourceSet)=>{set.marks[1].targetObservation!.box.width=4000;},
    (set:SourceSet)=>{set.marks[0].targetObservation=null as any;}]){
    const set=sourceSet();mutate(set);assert.throws(()=>validateSourceSet(set),{code:'INVALID_SOURCE_SET'});
  }
});
