import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {mkdtemp,mkdir,writeFile,rm,realpath,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createProject,retainFile,saveSourceSet} from '../src/project/store.ts';
import {bundleFiles} from '../src/core/bundle.ts';
import {fileDigest} from '../src/core/files.ts';
import {AUDIO_MODELS} from '../src/audio/provision.ts';
import type {ProjectBrief,SourceSet} from '../src/project/contracts.ts';
import type {SessionInfo} from '../src/session/contracts.ts';

const root=resolve(import.meta.dirname,'..');
const brief:ProjectBrief={title:'Explore a product',brief:'Show defining interactions',audience:'New users',mandate:{applicationUrl:'http://127.0.0.1:9/',navigationOrigins:['http://127.0.0.1:9'],network:'loopback-only',allowedEffects:'Use fictional local content; no publication.',dataDescription:'Synthetic material',inputRoots:[],mediaReview:'agent-reviewable-synthetic',delivery:'local'}};
function cli(args:string[],cwd=tmpdir()){
  const result=spawnSync(process.execPath,[join(root,'bin/walkthrough.mjs'),...args],{cwd,encoding:'utf8',timeout:15000,env:{...process.env,WALKTHROUGH_CREDENTIAL_CANARY:'not-a-real-credential'}});
  assert.ifError(result.error);const lines=result.stdout.trim().split('\n');assert.equal(lines.length,1,'one public JSON record');assert.equal(result.stderr,'');assert.ok(!result.stdout.includes('not-a-real-credential'));
  return {code:result.status,record:JSON.parse(lines[0])};
}
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){
  const directory=await mkdtemp(join(await realpath(tmpdir()),'walkthrough-cli-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const projectPath=join(directory,'.walkthrough');return {directory,projectPath};
}
test('version and public help work outside the checkout without application setup',async()=>{
  const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const version=cli(['--version','--json']);assert.equal(version.code,0);assert.equal(version.record.result.name,'walkthrough');assert.equal(version.record.result.version,manifest.version);assert.equal(version.record.result.runtimeRoot,root);assert.equal(version.record.result.kind,'development-source');
  const help=cli(['help','--json']);assert.equal(help.code,0);assert.ok(help.record.commands.some((c:string)=>c.startsWith('observe ')));assert.ok(!help.record.commands.some((c:string)=>c.startsWith('integrations ')));
  assert.equal(Object.keys(help.record.schemas).length,7);for(const path of Object.values(help.record.schemas))assert.ok(String(path).startsWith(root+'/docs/schemas/'));
  const captureHelp=cli(['help','capture']).record;
  assert.equal(captureHelp.seal.artifacts[0].role,'deliverable');
  assert.deepEqual(captureHelp.markTargets,[{observationId:'<current-observation-id>',ref:'<observed-ref>'},{observationId:'<current-observation-id>',box:{x:400,y:300,width:600,height:400},coordinateSpace:'screenshot'}]);
  assert.ok(captureHelp.notes.some((note:string)=>note.includes('Raw CSS boxes are not accepted')));
  assert.ok(help.record.commands.includes('project compact --project <path> --composition <composition-id>'));
  assert.ok(help.record.commands.includes('project compact --project <path> --preview <failed-preview-id>'));
  assert.deepEqual(cli(['help','recovery']).record.outcomes,['effect-observed','no-effect-observed','uncertain']);
  const actionHelp=cli(['help','act']).record;
  assert.ok(actionHelp.notes.some((note:string)=>note.includes('input-backed file chooser')&&note.includes('Do not click first')));
  assert.ok(actionHelp.examples.some((action:{kind:string;sourceArtifacts?:unknown})=>action.kind==='upload'&&action.sourceArtifacts));
  assert.ok(actionHelp.examples.some((action:{kind:string;modifiers?:string[]})=>action.kind==='click'&&action.modifiers?.includes('Shift')));
  assert.ok(help.record.commands.some((command:string)=>command.includes('--ref <select-ref>')));
  assert.ok(help.record.commands.some((command:string)=>command.includes('--section narration-fit')));
});
test('setup and audio help expose exact model acquisition without requiring setup',()=>{
  const setup=cli(['help','setup','--json']),audio=cli(['help','audio','--json']);
  assert.equal(setup.code,0);assert.equal(audio.code,0);
  const requirements=audio.record.audioRequirements;
  assert.deepEqual(setup.record.audioRequirements,requirements);
  assert.deepEqual(requirements.models,Object.entries(AUDIO_MODELS).map(([role,model])=>({role,...model,
    acquireCommand:['hf','download',model.repository,'--revision',model.revision,'--cache-dir','<model_cache>'],
    previewCommand:['hf','download',model.repository,'--revision',model.revision,'--cache-dir','<model_cache>','--dry-run'],
  })));
  assert.deepEqual(requirements.cache.inspectCommand,['voices','--json','doctor']);
  assert.equal(requirements.cache.directoryField,'model_cache');
  assert.equal(requirements.cache.owner,'huggingface_hub');
  assert.equal(requirements.cache.resolverTreeWriter,'huggingface_hub.snapshot_download');
  assert.match(requirements.cache.resolverTreePath,/\/trees\/<revision>\.json$/);
  assert.match(requirements.nextStep,/model_cache.*explicit authorization.*setup prepare\/apply/);
  assert.ok(requirements.notes.some((note:string)=>note.includes('never fabricate metadata')));
  assert.ok(requirements.notes.some((note:string)=>note.includes('--dry-run')&&note.includes('not an offline inspect')));
  assert.ok(requirements.notes.some((note:string)=>note.includes('Neither is run by Walkthrough help, doctor or setup')));
});
test('retired engine commands and malformed new commands fail before effects',()=>{
  for(const args of [
    ['unknown'],['capture','--integration','sample-product','--scenario','missing.json'],['integrations','list'],['runs','list'],['compose','old-id','--edit','missing.json'],
    ['doctor','--phase','unknown'],['doctor','--phase','capture','--phase','compose'],['session','open','--project'],['help','act','extra'],['help','--json','--json'],
    ['observe','--ref','select-without-snapshot'],
  ]){const result=cli(args);assert.equal(result.code,1,JSON.stringify(args));assert.equal(result.record.error.code,'INVALID_COMMAND',JSON.stringify(args));}
});
test('the public project journey uses caller-relative inputs and refuses replacement',async t=>{
  const f=await fixture(t);await writeFile(join(f.directory,'brief.json'),JSON.stringify(brief));
  const created=cli(['project','create','--path','.walkthrough','--brief','brief.json','--json'],f.directory);assert.equal(created.code,0,JSON.stringify(created.record));
  assert.equal(created.record.projectPath,f.projectPath);assert.match(created.record.projectId,/^project-/);
  const inspected=cli(['project','inspect','--project','.walkthrough'],f.directory);assert.equal(inspected.code,0);assert.equal(inspected.record.result.project.id,created.record.projectId);assert.equal(inspected.record.result.sessions.total,0);
  assert.equal(cli(['project','create','--path','.walkthrough','--brief','brief.json'],f.directory).record.error.code,'EEXIST');
  assert.equal(JSON.parse(await readFile(join(f.projectPath,'project.json'),'utf8')).id,created.record.projectId);
});
test('artifact discovery is empty data and exact identities reject traversal',async t=>{
  const f=await fixture(t);await createProject(f.projectPath,brief);
  const empty=cli(['artifact','list','--project',f.projectPath]);assert.equal(empty.code,0);assert.deepEqual(empty.record.result.items,[]);
  for(const args of [
    ['action','inspect','--session','../outside','--id','a'],['inspect','--take','../outside'],['inspect','--source-set','../outside'],
  ]){const result=cli([...args,'--project',f.projectPath]);assert.equal(result.code,1);assert.equal(result.record.error.code,'INVALID_ID');}
});
test('session inspection offers retained work for closed sessions and recovery for unavailable workers',async t=>{
  const f=await fixture(t),{project}=await createProject(f.projectPath,brief);
  for(const status of ['closed','interrupted','starting'] as const){
    const sessionId=`retained-${status}`,directory=join(f.projectPath,'sessions',sessionId);await mkdir(directory);
    const session:SessionInfo={version:1,sessionId,projectId:project.id,projectPath:f.projectPath,directory,status,createdAt:'2026-10-04T00:00:00.000Z',updatedAt:'2026-10-04T00:00:00.000Z',captureActive:false,socketPath:join(directory,'absent.sock'),workerToken:`${sessionId}-worker-token`,
      ...(status==='starting'?{}:{processIdentity:{pid:2147483647,pgid:2147483647,startedAt:'1:0',commandSha256:'0'.repeat(64)}})};
    await writeFile(join(directory,'session.json'),JSON.stringify(session));
    const inspected=cli(['session','inspect','--project',f.projectPath,'--session',sessionId]);
    assert.equal(inspected.code,0,JSON.stringify(inspected.record));assert.equal(inspected.record.result.session.status,status);
    assert.equal(inspected.record.result.live,false);assert.equal(inspected.record.result.worker,status==='starting'?'unresolved':'stopped');
    assert.doesNotMatch(inspected.record.nextStep,/Observe the page/);
    if(status==='closed')assert.match(inspected.record.nextStep,/Inspect retained takes, source sets or original actions/);
    else assert.equal(inspected.record.nextStep,inspected.record.result.recovery);
  }
});
test('private-local review is denied without exposing content',async t=>{
  const f=await fixture(t);await createProject(f.projectPath,{...brief,title:'Sensitive title',mandate:{...brief.mandate,mediaReview:'private-local'}});
  const result=cli(['project','inspect','--project',f.projectPath]);assert.equal(result.record.error.code,'MEDIA_REVIEW_NOT_AUTHORIZED');assert.ok(!JSON.stringify(result.record).includes('Sensitive title'));
});
test('project inspection pages remaining identities instead of silently capping discovery',async t=>{
  const f=await fixture(t);await createProject(f.projectPath,brief);
  for(const id of ['a','b','c'])await mkdir(join(f.projectPath,'takes',id));
  const first=cli(['project','inspect','--project',f.projectPath,'--limit','2']).record.result.takes;
  assert.deepEqual(first.ids,['c','b']);assert.equal(first.nextOffset,2);
  const rest=cli(['project','inspect','--project',f.projectPath,'--limit','2','--offset',String(first.nextOffset)]).record.result.takes;
  assert.deepEqual(rest.ids,['a']);assert.equal(rest.nextOffset,null);
  assert.deepEqual(cli(['project','inspect','--project',f.projectPath]).record.result.previews,{ids:[],total:0,offset:0,nextOffset:null,truncated:false});
  await mkdir(join(f.projectPath,'previews'));
  for(const suffix of ['a','b','c'])await mkdir(join(f.projectPath,'previews',`preview-12345678-1234-1234-1234-123456789ab${suffix}`));
  await writeFile(join(f.projectPath,'previews','current.json'),'metadata, not an attempt directory');
  const previews=cli(['project','inspect','--project',f.projectPath,'--limit','2']).record.result.previews;
  assert.deepEqual(previews.ids,['preview-12345678-1234-1234-1234-123456789abc','preview-12345678-1234-1234-1234-123456789abb']);assert.equal(previews.nextOffset,2);
  const more=cli(['project','inspect','--project',f.projectPath,'--limit','2','--offset',String(previews.nextOffset)]).record.result.previews;
  assert.deepEqual(more.ids,['preview-12345678-1234-1234-1234-123456789aba']);assert.equal(more.nextOffset,null);
});
test('sealed-source inspection and edit validation require neither app nor adapter',async t=>{
  const f=await fixture(t),{project}=await createProject(f.projectPath,brief);const directory=join(f.projectPath,'sources','set');await mkdir(directory);
  const original=join(f.directory,'source.mp4');await writeFile(original,'source bytes retained for structural validation only');const media=await retainFile(original,directory,'take/source.mp4');
  const set:SourceSet={schemaVersion:1,kind:'source-set',id:'set',projectId:project.id,createdAt:new Date().toISOString(),state:'sealed',mediaReview:'agent-reviewable-synthetic',sources:[{id:'take',media,width:3200,height:1800,durationSeconds:5,frameCount:300,clock:{offsetSeconds:0,uncertaintySeconds:0.01,driftSeconds:0.01},pointer:[],usableRange:{startSeconds:1,endSeconds:4}}],marks:[],artifacts:[]};
  const sealed=await saveSourceSet(f.projectPath,set);const inspection=cli(['inspect','--project',f.projectPath,'--source-set','set']);assert.equal(inspection.code,0);assert.equal(inspection.record.result.integrity,'verified');
  const edit={schemaVersion:1,sourceSetId:'set',sourceSetSha256:sealed.sha256,title:'Explore',brief:'A structural test',voiceId:'copilot-female-1',pictures:[{id:'shot',sourceId:'take',kind:'live',transition:'cut',startSeconds:1,endSeconds:3,zoom:1,target:null}],narration:[]};
  await writeFile(join(f.directory,'edit.json'),JSON.stringify(edit));const validation=cli(['validate','--project','.walkthrough','--edit','edit.json'],f.directory);assert.equal(validation.code,0,JSON.stringify(validation.record));assert.equal(validation.record.result.valid,true);assert.equal(validation.record.result.appAccess,false);assert.equal(validation.record.result.synthesis,false);assert.equal(validation.record.result.render,false);
  const narrow={...edit,pictures:[{...edit.pictures[0],captionPlacement:{x:360,y:948,width:20}}]};
  await writeFile(join(f.directory,'narrow.json'),JSON.stringify(narrow));
  const rejected=cli(['validate','--project',f.projectPath,'--edit',join(f.directory,'narrow.json')]);
  assert.equal(rejected.code,1);assert.equal(rejected.record.error.code,'INVALID_FILM_CAPTION_PLACEMENT');
  assert.equal(rejected.record.error.caption.pictureId,'shot');assert.equal(rejected.record.error.caption.phraseId,null);
  assert.deepEqual(rejected.record.error.caption.placement,narrow.pictures[0].captionPlacement);
  await writeFile(join(directory,media.relativePath),'changed');assert.equal(cli(['validate','--project','.walkthrough','--edit','edit.json'],f.directory).record.error.code,'RETAINED_FILE_CHANGED');
});
test('composition inspection offers viewing only for a currently verified delivery',async t=>{
  const f=await fixture(t);await createProject(f.projectPath,brief);
  const directory=join(f.projectPath,'compositions','film');await mkdir(directory);
  for(const status of ['running','failed','awaiting-human-review']){
    await writeFile(join(directory,'composition.json'),JSON.stringify({id:'film',status,stage:'rendering'}));
    const inspected=cli(['inspect','--project',f.projectPath,'--composition','film']);
    assert.equal(inspected.code,0);assert.equal(inspected.record.result.manifest.status,status);
    assert.equal(inspected.record.result.renderProgress.state,'not-recorded');
    assert.equal(inspected.record.result.bundle.reviewPath,null);
    assert.doesNotMatch(inspected.record.nextStep,/watch the available film/i);
    if(status==='running')assert.match(inspected.record.nextStep,/original occurrence/);
    if(status==='failed')assert.match(inspected.record.nextStep,/retained error/);
    if(status==='awaiting-human-review')assert.match(inspected.record.nextStep,/incomplete or changed/);
  }
  const checksums:Record<string,string>={};
  for(const name of bundleFiles){await writeFile(join(directory,name),'Retained bundle fixture');checksums[name]=await fileDigest(join(directory,name));}
  await writeFile(join(directory,'checksums.json'),JSON.stringify(checksums));
  const ready=cli(['inspect','--project',f.projectPath,'--composition','film']);
  assert.equal(ready.record.result.bundle.reviewPath,join(directory,'review.html'));
  assert.match(ready.record.nextStep,/watch and listen/i);
  await writeFile(join(directory,'walkthrough.mp4'),'changed');
  const changed=cli(['inspect','--project',f.projectPath,'--composition','film']);
  assert.equal(changed.record.result.bundle.reviewPath,null);assert.match(changed.record.nextStep,/incomplete or changed/);
});
test('public preview inspection accepts current and exact failed-attempt identities',async t=>{
  const f=await fixture(t);await createProject(f.projectPath,brief);
  assert.equal(cli(['inspect','--project',f.projectPath,'--preview']).record.result.current,null);
  const id='preview-12345678-1234-1234-1234-123456789abc',directory=join(f.projectPath,'previews',id);await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'preview.json'),JSON.stringify({schemaVersion:1,kind:'preview',id,projectPath:f.projectPath,status:'failed',stage:'rendering',error:{code:'SYNTHETIC_FAILURE'}}));
  const inspected=cli(['inspect','--project',f.projectPath,'--preview',id,'--json']);
  assert.equal(inspected.code,0);assert.equal(inspected.record.result.attempt.id,id);assert.equal(inspected.record.result.attempt.error.code,'SYNTHETIC_FAILURE');assert.equal(inspected.record.result.attempt.videoPath,null);
  // This one-second phrase starts halfway through a one-second picture:
  // the retained measurement needs half a second of local clearance.
  const phrase={phraseId:'closing',outputStartSeconds:0.5,measuredDurationSeconds:1,measuredEndSeconds:1.5,occupiedDurationSeconds:1,occupiedEndSeconds:1.5,nextPhrase:null,pictureEnd:{outputEndSeconds:1,requiredClearanceSeconds:0.5}};
  await writeFile(join(directory,'narration-fit.json'),JSON.stringify({schemaVersion:1,kind:'narration-fit',status:'rejected',pictureDurationSeconds:1,phraseCount:1,conflictingPhraseCount:1,phrases:[phrase]}));
  const fit=cli(['inspect','--project',f.projectPath,'--preview',id]).record.result.narrationFit;
  assert.equal(fit.state,'recorded');assert.equal(fit.record.selection,'conflicts');assert.deepEqual(fit.record.phrases.items,[phrase]);
  assert.equal(fit.diagnosticPath,join(directory,'narration-fit.json'));
  assert.equal(cli(['inspect','--project',f.projectPath,'--preview','../outside']).record.error.code,'FILM_PREVIEW_ID_INVALID');
});
test('public composition inspection reports retained frame counts without liveness, completion or review claims',async t=>{
  const f=await fixture(t);await createProject(f.projectPath,brief);
  const directory=join(f.projectPath,'compositions','film');await mkdir(directory);await mkdir(join(directory,'render'));
  const progress={schemaVersion:1,kind:'render-progress',recordedAt:'2026-10-01T09:00:00.000Z',phase:'encoding',frames:{rendered:600,total:600}};
  await writeFile(join(directory,'render/progress.json'),JSON.stringify(progress));
  for(const [status,stage] of [['running','rendering'],['running','temporal-qa'],['failed','rendering'],['awaiting-human-review','complete-bundle-awaiting-review']]){
    await writeFile(join(directory,'composition.json'),JSON.stringify({id:'film',status,stage}));
    const inspected=cli(['inspect','--project',f.projectPath,'--composition','film']);
    assert.equal(inspected.code,0);assert.equal(inspected.record.result.statusBasis,'recorded-manifest');
    assert.equal(inspected.record.result.manifest.status,status);assert.equal(inspected.record.result.manifest.stage,stage);
    assert.deepEqual(inspected.record.result.renderProgress.record,progress);assert.equal(inspected.record.result.renderProgress.processLiveness,'not-observed');
    assert.equal(inspected.record.result.renderProgress.historical,status!=='running'||stage!=='rendering');
    assert.equal(inspected.record.result.bundle.reviewPath,null);assert.doesNotMatch(inspected.record.nextStep,/watch and listen/i);
    if(status==='failed')assert.match(inspected.record.nextStep,/retained error/);
  }
  await writeFile(join(directory,'render/progress.json'),'{');
  const invalid=cli(['inspect','--project',f.projectPath,'--composition','film']);
  assert.equal(invalid.code,0);assert.equal(invalid.record.result.manifest.status,'awaiting-human-review');
  assert.equal(invalid.record.result.renderProgress.state,'invalid');assert.equal(invalid.record.result.renderProgress.record,null);
});

test('public composition inspection exposes bounded audio failure details without raw logs or provider inputs',async t=>{
  const f=await fixture(t);await createProject(f.projectPath,brief);
  const directory=join(f.projectPath,'compositions','film'),audio=join(directory,'audio');await mkdir(audio,{recursive:true});
  const manifest={id:'film',status:'failed',stage:'narration',error:{code:'AUDIO_RUNTIME_FAILED_LOCAL_LOGS_RETAINED'}};
  await writeFile(join(directory,'composition.json'),JSON.stringify(manifest));
  const record={schemaVersion:1,kind:'audio-failure',code:'AUDIO_VOICES_COMMAND_FAILED',phraseId:'follow',operation:'align',
    child:{exitCode:4,signal:null,startFailed:false},response:'json',
    providerError:{code:'generation',message:'Forced alignment returned an invalid timeline: Alignment words overlap. [type=value_error, input_value="private words"]',truncated:false,environment:'private environment'},
    paths:{runtimeStdout:join(audio,'runtime.stdout.log'),runtimeStderr:join(audio,'runtime.stderr.log'),providerStdout:join(f.directory,'partial','align.stdout.json'),providerStderr:join(f.directory,'partial','align.stderr.log'),narrationWav:join(f.directory,'partial','narration.wav')},stderr:'private stderr'};
  await writeFile(join(audio,'failure.json'),JSON.stringify(record));
  const result=cli(['inspect','--project',f.projectPath,'--composition','film']);
  assert.equal(result.code,0);assert.deepEqual(result.record.result.manifest,manifest);
  const inspected=result.record.result.audioFailure;
  assert.equal(inspected.state,'recorded');assert.equal(inspected.record.phraseId,'follow');assert.equal(inspected.record.operation,'align');
  assert.deepEqual(inspected.record.child,{exitCode:4,signal:null,startFailed:false});
  assert.equal(inspected.record.providerError.message,'Forced alignment returned an invalid timeline: Alignment words overlap.');
  assert.equal(inspected.record.providerError.truncated,true);assert.deepEqual(inspected.record.paths,record.paths);
  assert.equal(inspected.diagnosticPath,join(audio,'failure.json'));
  assert.doesNotMatch(JSON.stringify(result.record),/private words|private environment|private stderr/);
  assert.equal(result.record.result.bundle.reviewPath,null);
  await writeFile(join(audio,'failure.json'),'{');
  const invalid=cli(['inspect','--project',f.projectPath,'--composition','film']);
  assert.equal(invalid.code,0);assert.deepEqual(invalid.record.result.manifest,manifest);assert.equal(invalid.record.result.audioFailure.state,'invalid');
  await rm(join(audio,'failure.json'));
  const missing=cli(['inspect','--project',f.projectPath,'--composition','film']);
  assert.equal(missing.code,0);assert.equal(missing.record.result.audioFailure.state,'not-recorded');
});

test('editorial inspection pages retained cross-cut viewing prompts without rewriting evidence',async t=>{
  const f=await fixture(t);await createProject(f.projectPath,brief);
  const directory=join(f.projectPath,'compositions','film');await mkdir(directory);
  await writeFile(join(directory,'composition.json'),JSON.stringify({id:'film',status:'failed',error:{code:'FILM_NARRATION_OVERLAP'}}));
  const observations=Array.from({length:23},(_,index)=>({code:'NARRATION_GAP',pictureId:`picture-${index}`,preview:{fromSeconds:index*4,toSeconds:index*4+3},speech:{spokenContentVerified:false},context:{pictures:[],totalPictures:0,picturesTruncated:false}}));
  const bytes=JSON.stringify({objectiveErrors:[],editorialObservations:observations});
  await writeFile(join(directory,'editorial-observations.json'),bytes);
  const args=['inspect','--project',f.projectPath,'--composition','film','--section','editorial'];
  const first=cli(args).record.result;assert.equal(first.editorialObservations.total,23);
  assert.equal(first.editorialObservations.items.length,20);assert.equal(first.editorialObservations.nextOffset,20);
  assert.equal(first.objectiveErrors[0].code,'FILM_NARRATION_OVERLAP');
  const last=cli([...args,'--limit','20','--offset','20']).record.result;
  assert.deepEqual(last.editorialObservations.items,observations.slice(20));assert.equal(last.editorialObservations.nextOffset,null);
  assert.equal(await readFile(join(directory,'editorial-observations.json'),'utf8'),bytes);
});
test('public narration-fit inspection identifies conflicts and pages every retained phrase offline',async t=>{
  const f=await fixture(t);await createProject(f.projectPath,brief);
  const directory=join(f.projectPath,'compositions','film');await mkdir(directory);
  await writeFile(join(directory,'composition.json'),JSON.stringify({id:'film',status:'failed',stage:'narration-fit',error:{code:'FILM_NARRATION_OVERLAP'}}));
  // Hand-worked measures: opening overlaps follow by 1s; closing overruns the
  // eight-second picture by 1s. The middle phrase fits both boundaries.
  const record={schemaVersion:1,kind:'narration-fit',status:'rejected',pictureDurationSeconds:8,phraseCount:3,conflictingPhraseCount:2,phrases:[
    {phraseId:'opening',outputStartSeconds:0,measuredDurationSeconds:3,measuredEndSeconds:3,occupiedDurationSeconds:3,occupiedEndSeconds:3,nextPhrase:{phraseId:'follow',outputStartSeconds:2,requiredClearanceSeconds:1},pictureEnd:{outputEndSeconds:8,requiredClearanceSeconds:0}},
    {phraseId:'follow',outputStartSeconds:2,measuredDurationSeconds:1,measuredEndSeconds:3,occupiedDurationSeconds:1,occupiedEndSeconds:3,nextPhrase:{phraseId:'closing',outputStartSeconds:6,requiredClearanceSeconds:0},pictureEnd:{outputEndSeconds:8,requiredClearanceSeconds:0}},
    {phraseId:'closing',outputStartSeconds:6,measuredDurationSeconds:3,measuredEndSeconds:9,occupiedDurationSeconds:3,occupiedEndSeconds:9,nextPhrase:null,pictureEnd:{outputEndSeconds:8,requiredClearanceSeconds:1}},
  ]};
  await writeFile(join(directory,'narration-fit.json'),JSON.stringify(record));
  const args=['inspect','--project',f.projectPath,'--composition','film'];
  const summary=cli(args);assert.equal(summary.code,0);
  assert.equal(summary.record.result.narrationFit.record.selection,'conflicts');
  assert.deepEqual(summary.record.result.narrationFit.record.phrases.items.map((p:any)=>p.phraseId),['opening','closing']);
  const first=cli([...args,'--section','narration-fit','--limit','1']);assert.equal(first.code,0);
  assert.equal(first.record.result.statusBasis,'retained-narration-fit');
  assert.equal(first.record.result.record.selection,'all');assert.equal(first.record.result.record.phrases.total,3);
  assert.deepEqual(first.record.result.record.phrases.items,[record.phrases[0]]);
  const next=cli([...args,'--section','narration-fit','--limit','1','--offset',String(first.record.result.record.phrases.nextOffset)]);
  assert.deepEqual(next.record.result.record.phrases.items,[record.phrases[1]]);
  assert.equal(cli([...args,'--section','unknown']).record.error.code,'INVALID_COMMAND');
  assert.equal(cli([...args,'--offset','1']).record.error.code,'INVALID_COMMAND');
});
