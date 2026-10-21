import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProject,readProject,validateBrief,retainFile,saveSourceSet,loadSourceSet,checkedId,validateSourceSet} from '../src/project/store.ts';
import type {ProjectBrief,SourceSet} from '../src/project/contracts.ts';

const brief:ProjectBrief={title:'Product exploration',brief:'Show capabilities',audience:'New users',mandate:{applicationUrl:'https://example.com/',navigationOrigins:['https://example.com'],network:'web',allowedEffects:'Use fictional local content; no sharing.',dataDescription:'Fictional drawing',inputRoots:[],mediaReview:'agent-reviewable-synthetic',delivery:'local'}};
test('project is explicit, independent, retained and refuses replacement',async()=>{
  const directory=join(await mkdtemp(join(tmpdir(),'walkthrough-project-')),'.walkthrough');
  const created=await createProject(directory,brief);assert.equal((await readProject(directory)).id,created.project.id);
  await assert.rejects(access(join(directory,'imports')),{code:'ENOENT'});
  await assert.rejects(createProject(directory,{...brief,title:'replacement'}),{code:'EEXIST'});
  assert.equal((await readProject(directory)).title,brief.title);
});
test('mandate distinguishes navigation from network profile without per-site API descriptions',()=>{
  assert.equal(validateBrief(brief).mandate.network,'web');
  assert.throws(()=>validateBrief({...brief,mandate:{...brief.mandate,network:'loopback-only'}}),{code:'LOOPBACK_MANDATE_REQUIRED'});
  assert.throws(()=>validateBrief({...brief,mandate:{...brief.mandate,navigationOrigins:['https://example.org']}}),{code:'INVALID_NAVIGATION_ORIGINS'});
  assert.throws(()=>checkedId('../other'),{code:'INVALID_ID'});
  assert.throws(()=>checkedId(undefined),{code:'INVALID_ID'});
});
test('sealed source bytes stay usable without a target or adapter and detect drift',async()=>{
  const root=await mkdtemp(join(tmpdir(),'walkthrough-source-')),projectPath=join(root,'.walkthrough');const {project}=await createProject(projectPath,brief);
  const directory=join(projectPath,'sources','sources-test');await mkdir(directory);
  const source=join(root,'original.mp4');await writeFile(source,'retained bytes');
  const media=await retainFile(source,directory,'take/source.mp4');
  const set:SourceSet={schemaVersion:1,kind:'source-set',id:'sources-test',projectId:project.id,createdAt:new Date().toISOString(),state:'sealed',mediaReview:'agent-reviewable-synthetic',sources:[{id:'take-a',media,width:3200,height:1800,durationSeconds:4,frameCount:240,clock:{offsetSeconds:-1,uncertaintySeconds:0.01,driftSeconds:0.01},pointer:[],usableRange:{startSeconds:1,endSeconds:3}}],marks:[],artifacts:[]};
  const sealed=await saveSourceSet(projectPath,set);const retained=await loadSourceSet(projectPath,set.id);assert.equal(retained.sha256,sealed.sha256);assert.equal(await readFile(retained.sourcePaths['take-a'],'utf8'),'retained bytes');
  await writeFile(retained.sourcePaths['take-a'],'changed bytes');await assert.rejects(loadSourceSet(projectPath,set.id),{code:'RETAINED_FILE_CHANGED'});
});
test('retention rejects symlink sources rather than reaching unrelated files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'walkthrough-source-'));await writeFile(join(root,'actual'),'bytes');await symlink(join(root,'actual'),join(root,'link'));
  await assert.rejects(retainFile(join(root,'link'),root,'retained'),{code:'SOURCE_FILE_NOT_LITERAL'});
});
test('retention never creates children through a redirected destination parent',async()=>{
  const root=await mkdtemp(join(tmpdir(),'walkthrough-retain-boundary-')),destination=join(root,'destination'),outside=join(root,'outside');
  await mkdir(destination);await mkdir(outside);await writeFile(join(root,'source'),'bytes');await symlink(outside,join(destination,'redirect'));
  await assert.rejects(retainFile(join(root,'source'),destination,'redirect/new-child/file'),{code:'RETAINED_DIRECTORY_REDIRECT'});
  await assert.rejects(access(join(outside,'new-child')),{code:'ENOENT'});
});
test('project manifest is published after owned directories and partial setup can resume',async()=>{
  const root=await mkdtemp(join(tmpdir(),'walkthrough-create-boundary-')),directory=join(root,'.walkthrough');await mkdir(directory);await mkdir(join(directory,'sessions'));
  const result=await createProject(directory,brief);assert.equal((await readProject(directory)).id,result.project.id);
  const other=join(root,'blocked');await mkdir(other);await symlink(root,join(other,'takes'));
  await assert.rejects(createProject(other,brief),{code:'RETAINED_DIRECTORY_REDIRECT'});await assert.rejects(access(join(other,'project.json')),{code:'ENOENT'});
});
test('source-set validation rejects nonfinite bounds, unsupported gestures and malformed framing',()=>{
  const set:SourceSet={schemaVersion:1,kind:'source-set',id:'set',projectId:'project',createdAt:'2026-10-03',state:'sealed',mediaReview:'agent-reviewable-synthetic',sources:[{id:'take',media:{relativePath:'source.mp4',sha256:'a'.repeat(64),bytes:1},width:3200,height:1800,durationSeconds:4,frameCount:240,clock:{offsetSeconds:0,uncertaintySeconds:0.01,driftSeconds:0.01},pointer:[],usableRange:{startSeconds:1,endSeconds:3}}],marks:[{id:'mark',title:'Result',sourceId:'take',timeSeconds:2,target:null}],artifacts:[]};
  assert.equal(validateSourceSet(set),set);
  const observed=structuredClone(set);observed.marks[0].settled={startSeconds:1.5,endSeconds:2.5,method:'observed-stability'};
  assert.equal(validateSourceSet(observed),observed);
  const importedAssertion=structuredClone(observed);(importedAssertion.marks[0].settled as {method:string}).method='imported-assertion';
  assert.throws(()=>validateSourceSet(importedAssertion),{code:'INVALID_SOURCE_SET'});
  for(const end of [NaN,Infinity,undefined]){const bad=structuredClone(set);bad.sources[0].usableRange.endSeconds=end as number;assert.throws(()=>validateSourceSet(bad),{code:'INVALID_SOURCE_SET'});}
  const badGesture=structuredClone(set);badGesture.sources[0].pointer=[{timeSeconds:2,x:10,y:20,type:'move',gesture:'made-up' as 'drag'}];assert.throws(()=>validateSourceSet(badGesture),{code:'INVALID_SOURCE_SET'});
  for(const target of [{x:0,y:0,width:Infinity,height:20},{x:3190,y:0,width:20,height:20}]){const bad=structuredClone(set);bad.marks[0].target=target;assert.throws(()=>validateSourceSet(bad),{code:'INVALID_SOURCE_SET'});}
});
