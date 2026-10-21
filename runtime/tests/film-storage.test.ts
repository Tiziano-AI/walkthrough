import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink,lstat,link,cp,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {compactFilmComposition,compactFilmPreview} from '../src/core/film-storage.ts';
import {beginPreview} from '../src/core/film-preview-storage.ts';
import {bundleFiles,observeBundle} from '../src/core/bundle.ts';
import {createProject,retainFile,saveSourceSet} from '../src/project/store.ts';
import {fileDigest} from '../src/core/files.ts';
import type {SourceSet} from '../src/project/contracts.ts';
import {buildFilmTimeline,type FilmEdit} from '../src/core/film-edit.ts';
import {canonicalWords,captionCues,validateAlignment} from '../src/audio/captions.ts';
import {AUDIO_MODELS,resolveProvisionVoice,synthesisIdentity as computeSynthesisIdentity,alignmentIdentity as computeAlignmentIdentity,transcriptionIdentity,type HistoricalAudioProvision,type CurrentAudioProvision,type AudioLanguage} from '../src/audio/provision.ts';
import {compareTranscript} from '../src/audio/transcription.ts';
import {reuseRetainedNarration} from '../src/audio/retained.ts';
import {audioMetrics} from '../src/audio/wav.ts';

function narrationWav(durationSeconds:number){
  const samples=durationSeconds*24000,wav=Buffer.alloc(44+samples*2);
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);
  wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
  for(let sample=0;sample<samples;sample++)wav.writeInt16LE(Math.round(Math.sin(sample*2*Math.PI*440/24000)*5000),44+sample*2);
  return wav;
}

function historicalProvision(voiceId:string):HistoricalAudioProvision{
  // These owners deliberately do not exist: compaction must rely only on the
  // retained receipts, never an installed runtime, voice library or model cache.
  const root='/unavailable-walkthrough-storage-fixture',hub=join(root,'hub');
  const model=(role:'tts'|'aligner')=>({...AUDIO_MODELS[role],snapshotPath:join(hub,`models--${AUDIO_MODELS[role].repository.replaceAll('/','--')}`,'snapshots',AUDIO_MODELS[role].revision),files:[{path:'model.safetensors',size:4,sha256:'a'.repeat(64)}],resolverTree:{size:4,sha256:'b'.repeat(64)}});
  return {schemaVersion:2,voicesExecutable:join(root,'voices'),hubCacheDirectory:hub,cacheDirectory:join(root,'cache'),
    runtime:{python:'3.13.5',executable:join(root,'python'),platform:'synthetic-platform',voices_version:'1.0.0',source_sha256:'c'.repeat(64),source_scope:'installed-python-source-at-observation',packages:{voices:'1.0.0'},package_scope:'selected-runtime-dependencies'},
    models:{tts:model('tts'),aligner:model('aligner')},voice:{id:voiceId,libraryPath:join(root,'library'),files:{'reference.wav':'d'.repeat(64),'reference.txt':'e'.repeat(64),'voice.json':'f'.repeat(64)}}};
}
function currentProvision(voiceId:string):CurrentAudioProvision{
  const {voice,models,...base}=historicalProvision(voiceId);
  const asr={...structuredClone(models.aligner),...AUDIO_MODELS.asr,snapshotPath:join(base.hubCacheDirectory,`models--${AUDIO_MODELS.asr.repository.replaceAll('/','--')}`,'snapshots',AUDIO_MODELS.asr.revision)};
  return {...base,schemaVersion:3,runtime:{...base.runtime,voices_version:'2.0.0',source_sha256:'1'.repeat(64)},defaultVoiceId:'copilot-female-1',voices:voiceId==='copilot-female-1'?[voice]:[{...voice,id:'copilot-female-1'},voice],models:{...models,asr}};
}

async function fixture(t:{after:(fn:()=>Promise<void>)=>void},options:{current?:boolean;language?:AudioLanguage;voiceId?:string;reuseHistorical?:boolean;transcript?:string;preview?:boolean}={}){
  const root=await mkdtemp(join(await realpath(tmpdir()),'film-storage-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const previousState=process.env.WALKTHROUGH_STATE_ROOT;process.env.WALKTHROUGH_STATE_ROOT=join(root,'state');
  t.after(async()=>{if(previousState===undefined)delete process.env.WALKTHROUGH_STATE_ROOT;else process.env.WALKTHROUGH_STATE_ROOT=previousState;});
  const projectPath=join(root,'.walkthrough');
  const {project}=await createProject(projectPath,{title:'Synthetic fixture',brief:'Storage only',audience:'Tests',mandate:{applicationUrl:'https://example.invalid/',navigationOrigins:['https://example.invalid'],network:'web',allowedEffects:'No application work',dataDescription:'Synthetic bytes',inputRoots:[],mediaReview:'agent-reviewable-synthetic',delivery:'local'}});
  const sources=join(projectPath,'sources','sealed');await mkdir(sources);
  await writeFile(join(root,'original.mp4'),'unique sealed picture');
  const media=await retainFile(join(root,'original.mp4'),sources,'source.mp4');
  await writeFile(join(root,'original.pdf'),'unique original download');
  const artifact=await retainFile(join(root,'original.pdf'),sources,'result.pdf');
  const set:SourceSet={schemaVersion:1,kind:'source-set',state:'sealed',id:'sealed',projectId:project.id,createdAt:'2026-10-04',mediaReview:'agent-reviewable-synthetic',sources:[{id:'take',media,width:3200,height:1800,durationSeconds:10,frameCount:600,clock:{offsetSeconds:0,uncertaintySeconds:0,driftSeconds:0},pointer:[],usableRange:{startSeconds:0,endSeconds:10}}],marks:[],artifacts:[{...artifact,id:'pdf',title:'Actual result',filename:'result.pdf',mediaType:'application/pdf',role:'deliverable'}]};
  const sealed=await saveSourceSet(projectPath,set),sourceSet={id:set.id,sha256:sealed.sha256};
  const id=options.preview?'preview-12345678-1234-1234-1234-123456789abc':'composition-test',kind=options.preview?'preview':'composition';
  if(options.preview)await mkdir(join(projectPath,'previews'));
  const directory=join(projectPath,options.preview?'previews':'compositions',id);await mkdir(directory);
  const language=options.language??'English',voiceId=options.voiceId??'copilot-female-1';
  const edit:FilmEdit={schemaVersion:1,sourceSetId:set.id,sourceSetSha256:sealed.sha256,title:'Storage fixture',brief:'No real render',voiceId,...(options.language?{language}:{}),pictures:[{id:'shot',sourceId:'take',kind:'live',transition:'cut',startSeconds:0,endSeconds:10,zoom:1,target:null}],narration:[{id:'phrase',text:language==='Italian'?'Apri il progetto e scegli i dati per confrontare i risultati finali.':'Keep this phrase.',outputStartSeconds:0}]};
  if(options.preview)edit.narration.push({id:'outside-preview',text:'This later phrase was intentionally not generated.',outputStartSeconds:8});
  // Actual worker-owned filenames and result fields, without running synthesis.
  const audio=join(directory,'audio'),phraseDirectory=join(audio,'phrase');await mkdir(phraseDirectory,{recursive:true});
  const text=edit.narration[0].text,tokens=canonicalWords(text),durationSeconds=tokens.length*.5,wavBytes=narrationWav(durationSeconds);
  const wavPath=join(phraseDirectory,'narration.wav');await writeFile(wavPath,wavBytes);
  const wavSha256=await fileDigest(wavPath);
  const provision=options.current?currentProvision(voiceId):historicalProvision(voiceId),runtime=provision.runtime;
  const generation=options.reuseHistorical?historicalProvision(voiceId):provision;
  await writeFile(join(audio,'provision.json'),JSON.stringify(provision));const provisionSha256=await fileDigest(join(audio,'provision.json'));
  const wordDuration=durationSeconds/tokens.length;
  const rawWords=tokens.map((word,index)=>({text:word.normalized,start_time:index*wordDuration,end_time:(index+1)*wordDuration})),words=validateAlignment(text,rawWords,durationSeconds),captions=captionCues(text,words,language);
  const metrics=audioMetrics(wavBytes,text);
  const generatedIdentity=computeSynthesisIdentity(generation,language,voiceId),alignedIdentity=computeAlignmentIdentity(generation,language);
  const beat={id:'phrase',text,wavPath,wavSha256,durationSeconds,words,captions,metrics,cacheHit:false,unresolvedWordCount:0,
    ...(options.current?{language,synthesisIdentity:generatedIdentity,alignmentIdentity:alignedIdentity,alignmentCacheHit:false}:{}),transcription:undefined as any};
  const synthesisIdentity=computeSynthesisIdentity(provision,language,voiceId),alignmentIdentity=computeAlignmentIdentity(provision,language);
  const narration={schemaVersion:1,voiceId:edit.voiceId,language,beats:[beat],manifestPath:join(audio,'narration.json'),vttPath:join(audio,'narration.vtt'),provisionManifestSha256:provisionSha256,provisionManifestPath:join(audio,'provision.json'),runtime,synthesisIdentity,alignmentIdentity,
    ...(provision.schemaVersion===3?{transcriptionIdentity:transcriptionIdentity(provision,language)}:{}),spokenContentVerified:false,humanListeningRequired:true};
  const provider={runtime:generation.runtime,model_id:generation.models.aligner.repository,model_revision:generation.models.aligner.revision,text,language,audio:{sha256:wavSha256,duration_seconds:durationSeconds,sample_rate:16000,channels:1,normalized_dtype:'<f4',normalized_sha256:'f'.repeat(64),waveform_basis:'ffmpeg-normalized-mono-pcm16-to-float32'},timing_basis:'qwen-forced-aligner-estimator-adjusted',spoken_content_verified:false,timing_diagnostics:null,diagnostic_limit:'Synthetic test metadata.',words:rawWords.map(word=>({text:word.text,start:word.start_time,end:word.end_time}))};
  const generationFields=options.current?{language,generationProvision:generation}:{};
  const alignment={schemaVersion:2,identity:generatedIdentity,alignmentIdentity:alignedIdentity,text,wavSha256,metrics,words,captions,timingBasis:provider.timing_basis,timingDiagnostics:null,diagnosticLimit:provider.diagnostic_limit,provider,spokenContentVerified:false,...generationFields};
  const synthesis={identity:generatedIdentity,text,wavSha256,...generationFields,artifact:{schema_version:2,runtime:generation.runtime,voice_id:edit.voiceId,reference_voice_id:edit.voiceId,text,language,base_model_id:generation.models.tts.repository,base_model_revision:generation.models.tts.revision,reference_sha256:resolveProvisionVoice(generation,voiceId).files['reference.wav']}};
  const audioFiles:Record<string,Buffer>={};
  if(provision.schemaVersion===3){
    const transcriptionPath=join(phraseDirectory,'transcription.json'),identity=transcriptionIdentity(provision,language),transcript=options.transcript??text,comparison=compareTranscript(text,transcript);
    const transcribed={runtime,transcript,language,model_id:provision.models.asr.repository,model_revision:provision.models.asr.revision,audio:provider.audio};
    const receipt={identity,language,wavSha256,provider:transcribed,transcript,comparison,generationProvision:provision};
    beat.transcription={identity,language,transcript,comparison,cacheHit:false,manifestPath:transcriptionPath,provider:transcribed};
    audioFiles['audio/phrase/transcription.json']=Buffer.from(JSON.stringify(receipt));
  }
  Object.assign(audioFiles,Object.fromEntries(Object.entries({'audio/narration.json':narration,'audio/phrase/alignment.json':alignment,'audio/phrase/synthesis.json':synthesis,'audio/provision.json':provision}).map(([path,value])=>[path,Buffer.from(JSON.stringify(value))])),{'audio/phrase/narration.wav':wavBytes});
  for(const [path,bytes] of Object.entries(audioFiles))await writeFile(join(directory,path),bytes);
  await writeFile(join(directory,'film-edit.json'),JSON.stringify(edit));
  for(const name of bundleFiles)await writeFile(join(directory,name),`delivery:${name}`);
  await writeFile(join(directory,'provenance.json'),JSON.stringify({schemaVersion:1,kind:'composition',sourceSet,editSha256:await fileDigest(join(directory,'film-edit.json')),audio:{voiceId:edit.voiceId,...(options.current?{language}:{}),provisionSha256,runtime,phrases:[{id:beat.id,text,wavSha256,cacheHit:false}]}}));
  const measured=options.preview?{...edit,narration:edit.narration.slice(0,1)}:edit;
  await writeFile(join(directory,'edit-plan.json'),JSON.stringify({edit,timeline:buildFilmTimeline(measured,{beats:[beat]},set),...(options.preview?{frameRange:[120,359],measuredPhraseIds:['phrase']}: {})}));
  await mkdir(join(directory,'deliverables'));await writeFile(join(directory,'deliverables/pdf'),'unique original download');
  await writeFile(join(directory,'deliverables.json'),JSON.stringify({schemaVersion:1,artifacts:[{name:'pdf',title:'Actual result',filename:'result.pdf',mediaType:'application/pdf',role:'deliverable',relativePath:'deliverables/pdf',sha256:artifact.sha256,bytes:artifact.bytes}]}));
  const names=[...bundleFiles,'deliverables.json','deliverables/pdf'];
  await writeFile(join(directory,'checksums.json'),JSON.stringify(Object.fromEntries(await Promise.all(names.map(async name=>[name,await fileDigest(join(directory,name))])))));
  const manifest={schemaVersion:1,kind,id,projectPath,status:'awaiting-human-review',stage:'complete-bundle-awaiting-review',sourceSet,paths:{'master.mov':join(root,'original.mp4')},...(options.preview?{range:{fromSeconds:2,toSeconds:6,frameRange:[120,359],fps:60}}:{})};
  await writeFile(join(directory,`${kind}.json`),JSON.stringify(manifest));
  const removable:Record<string,string>={
    'render/master.mov':'large regenerable master',
    'render/walkthrough.mp4':'delivery:walkthrough.mp4','render/poster.png':'delivery:poster.png',
    'render/assets/source-0.mp4':'staged source','render/assets/beat-0.wav':'staged phrase',
    'render/bundle/bundle.js':'generated code','render/bundle/bundle.js.map':'generated map',
    'render/bundle/index.html':'generated page','render/bundle/favicon.ico':'generated icon',
    'render/bundle/18.bundle.js':'generated chunk','render/bundle/18.bundle.js.map':'generated chunk map',
    'render/bundle/public/source-0.mp4':'staged source','render/bundle/public/beat-0.wav':'staged phrase',
    'temporal-qa/camera-samples.gray':'raw output samples','temporal-qa/source-0-samples.gray':'raw source samples','temporal-qa/source-0-2-samples.gray':'raw grouped source samples',
  };
  const kept=['render/progress.json','render/source-staging.json','render/render-input.json','render/media-metrics.json','render/renderer.log','render/source-0.log','render/audio-0.log','render/finish.log','render/finish-loudness-input.log','render/finish-loudness-delivery.log','temporal-qa/camera-evidence.json','temporal-qa/temporal-summary.json','temporal-qa/final-probe.json','temporal-qa/source-0-pts.json','temporal-qa/source-0-2-decode.log'];
  for(const [relative,bytes] of [...Object.entries(removable),...kept.map(name=>[name,`unique:${name}`])]){await mkdir(join(directory,relative,'..'),{recursive:true});await writeFile(join(directory,relative),bytes);}
  return {root,projectPath,directory,id,manifest,removable,kept,sources,audioFiles,compact:()=>options.preview?compactFilmPreview({projectPath,previewId:id}):compactFilmComposition({projectPath,compositionId:id})};
}

test('completed compaction removes exact scratch, retains unique inputs and useful evidence, and is idempotent',async t=>{
  const f=await fixture(t),before=await readFile(join(f.directory,'checksums.json'));
  const result=await f.compact();
  assert.equal(result.status,'compacted');assert.equal(result.removedFiles,Object.keys(f.removable).length);
  assert.equal(result.removedLogicalBytes,Object.values(f.removable).reduce((sum,text)=>sum+Buffer.byteLength(text),0));
  for(const name of Object.keys(f.removable))await assert.rejects(lstat(join(f.directory,name)),{code:'ENOENT'});
  for(const name of f.kept)assert.equal(await readFile(join(f.directory,name),'utf8'),`unique:${name}`);
  for(const [name,bytes] of Object.entries(f.audioFiles))assert.deepEqual(await readFile(join(f.directory,name)),bytes);
  assert.equal(await readFile(join(f.sources,'source.mp4'),'utf8'),'unique sealed picture');
  assert.equal(await readFile(join(f.sources,'result.pdf'),'utf8'),'unique original download');
  assert.equal(await readFile(join(f.root,'original.mp4'),'utf8'),'unique sealed picture','manifest-provided paths are never cleanup targets');
  assert.deepEqual(await readFile(join(f.directory,'checksums.json')),before);
  assert.equal((await observeBundle(f.directory,'awaiting-human-review')).integrity,'verified');
  const recorded=JSON.parse(await readFile(join(f.directory,'composition.json'),'utf8'));
  assert.equal(recorded.status,'awaiting-human-review');assert.deepEqual(recorded.storage,result);
  assert.deepEqual(await f.compact(),{status:'already-compact',removedFiles:0,removedLogicalBytes:0});
  assert.deepEqual(JSON.parse(await readFile(join(f.directory,'composition.json'),'utf8')).storage,result,'retain the original removal observation');
});
test('incomplete lifecycle and corrupted final bundle refuse all cleanup',async t=>{
  const f=await fixture(t);
  for(const status of ['running','failed']){
    await writeFile(join(f.directory,'composition.json'),JSON.stringify({...f.manifest,status}));
    await assert.rejects(f.compact(),/FILM_COMPACT_NOT_COMPLETE/);
  }
  await writeFile(join(f.directory,'composition.json'),JSON.stringify(f.manifest));
  await writeFile(join(f.directory,'walkthrough.mp4'),'corrupted final');
  await assert.rejects(f.compact(),/FILM_COMPACT_BUNDLE_NOT_VERIFIED/);
  for(const [name,bytes] of Object.entries(f.removable))assert.equal(await readFile(join(f.directory,name),'utf8'),bytes);
});
async function failFixture(f:Awaited<ReturnType<typeof fixture>>){
  const error={code:'RENDER_PROCESS_FAILED',owner:'render',recovery:'Inspect the retained renderer log.'};
  await writeFile(join(f.directory,`${f.manifest.kind}.json`),JSON.stringify({...f.manifest,status:'failed',stage:'rendering',error}));
  // Real failed renders have audio and a plan but no verified final bundle.
  for(const name of [...bundleFiles,'checksums.json'].filter(name=>name!=='edit-plan.json'))await rm(join(f.directory,name));
  return error;
}
test('completed delivery still requires final provenance even when its falsey content is checksummed',async t=>{
  const f=await fixture(t),path=join(f.directory,'provenance.json'),checksumsPath=join(f.directory,'checksums.json');
  for(const value of [null,false,0,'',[]]){
    await writeFile(path,JSON.stringify(value));
    const checksums=JSON.parse(await readFile(checksumsPath,'utf8'));checksums['provenance.json']=await fileDigest(path);await writeFile(checksumsPath,JSON.stringify(checksums));
    await assert.rejects(f.compact(),/FILM_COMPACT_INPUT_MISMATCH/);
  }
  for(const [name,bytes] of Object.entries(f.removable))assert.equal(await readFile(join(f.directory,name),'utf8'),bytes);
});
async function activity(f:Awaited<ReturnType<typeof fixture>>,record:Record<string,unknown>){
  const root=join(f.root,'state','active');await mkdir(root,{recursive:true});
  const path=join(root,'activity.json');await writeFile(path,JSON.stringify({schemaVersion:1,kind:'command',pid:99999999,coordinatorPid:99999998,projectPath:f.projectPath,status:'recovery-required',processGroupIds:[],...record}));return path;
}
test('settled failed render compacts scratch without final provenance, preserving original audio and sole encoded outputs',async t=>{
  const f=await fixture(t,{current:true,language:'Italian'}),error=await failFixture(f);
  const marker=await activity(f,{}),markerBytes=await readFile(marker);
  const result=await f.compact();
  assert.equal(result.status,'compacted');assert.equal(result.removedFiles,Object.keys(f.removable).length-2);
  for(const [name,bytes] of Object.entries(f.removable)){
    if(['render/walkthrough.mp4','render/poster.png'].includes(name))assert.equal(await readFile(join(f.directory,name),'utf8'),bytes);
    else await assert.rejects(lstat(join(f.directory,name)),{code:'ENOENT'});
  }
  for(const [name,bytes] of Object.entries(f.audioFiles))assert.deepEqual(await readFile(join(f.directory,name)),bytes);
  for(const name of f.kept)assert.equal(await readFile(join(f.directory,name),'utf8'),`unique:${name}`);
  assert.equal(await readFile(join(f.sources,'source.mp4'),'utf8'),'unique sealed picture');
  assert.deepEqual(await readFile(marker),markerBytes,'compaction never retires command custody');
  const retained=JSON.parse(await readFile(join(f.directory,'composition.json'),'utf8'));
  assert.equal(retained.status,'failed');assert.equal(retained.stage,'rendering');assert.deepEqual(retained.error,error);
  assert.equal((await f.compact()).status,'already-compact');
});
test('early failure without render intermediates is already compact, without inventing an edit plan',async t=>{
  const f=await fixture(t);await failFixture(f);
  for(const name of ['render','temporal-qa','audio','edit-plan.json'])await rm(join(f.directory,name),{recursive:true});
  assert.deepEqual(await f.compact(),{status:'already-compact',removedFiles:0,removedLogicalBytes:0});
});
test('failed compaction retains every scratch file when retained narration or source is damaged',async t=>{
  const f=await fixture(t,{current:true});await failFixture(f);
  const wav=join(f.directory,'audio/phrase/narration.wav'),bytes=await readFile(wav);
  await writeFile(wav,'damaged');await assert.rejects(f.compact(),/FILM_COMPACT_AUDIO_UNVERIFIED/);await writeFile(wav,bytes);
  await writeFile(join(f.sources,'source.mp4'),'damaged');await assert.rejects(f.compact(),/RETAINED_FILE_CHANGED/);
  for(const [name,bytes] of Object.entries(f.removable))assert.equal(await readFile(join(f.directory,name),'utf8'),bytes);
});
test('live or unresolved custody refuses failed compaction before removing anything',async t=>{
  const f=await fixture(t);await failFixture(f);
  for(const record of [
    {pid:process.pid},
    {coordinatorPid:process.pid},
    {pid:process.ppid,coordinatorPid:process.pid,processGroupIds:[process.pid],status:'running'},
    {kind:'session',status:'running'},
    {pid:'not-a-pid'},
    {processGroupIds:[-1]},
    {projectPath:null,pid:process.pid},
  ]){
    await activity(f,record);await assert.rejects(f.compact(),/FILM_COMPACT_ACTIVE_WORK/);
  }
  await writeFile(await activity(f,{}),'{');await assert.rejects(f.compact(),/FILM_COMPACT_ACTIVE_WORK/);
  for(const [name,bytes] of Object.entries(f.removable))assert.equal(await readFile(join(f.directory,name),'utf8'),bytes);
});
test('surviving process group and unobservable process identities block failed cleanup',async t=>{
  const f=await fixture(t);await failFixture(f);await activity(f,{processGroupIds:[99999997]});
  const observed:number[]=[];
  const mock=t.mock.method(process,'kill',(pid:number)=>{observed.push(pid);if(pid===-99999997)return true;throw Object.assign(new Error('absent'),{code:'ESRCH'});});
  await assert.rejects(f.compact(),/FILM_COMPACT_ACTIVE_WORK/);assert.ok(observed.includes(-99999997));
  mock.mock.restore();
  t.mock.method(process,'kill',()=>{throw Object.assign(new Error('unobservable'),{code:'EPERM'});});
  await assert.rejects(f.compact(),/FILM_COMPACT_ACTIVE_WORK/);
  assert.equal(await readFile(join(f.directory,'render/master.mov'),'utf8'),f.removable['render/master.mov']);
});
test('activity that becomes live during verification blocks the final deletion pass',async t=>{
  const f=await fixture(t);await failFixture(f);await activity(f,{coordinatorPid:undefined});let probes=0;
  t.mock.method(process,'kill',()=>{if(++probes>1)return true;throw Object.assign(new Error('absent'),{code:'ESRCH'});});
  await assert.rejects(f.compact(),/FILM_COMPACT_ACTIVE_WORK/);assert.equal(probes,2);
  for(const [name,bytes] of Object.entries(f.removable))assert.equal(await readFile(join(f.directory,name),'utf8'),bytes);
});
test('public compact excludes only its own supervisor command',async t=>{
  const f=await fixture(t);await failFixture(f);
  const entry=new URL('../bin/walkthrough.mjs',import.meta.url).pathname;
  const result=spawnSync(process.execPath,[entry,'project','compact','--project',f.projectPath,'--composition',f.id,'--json'],{cwd:f.root,encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const value=JSON.parse(result.stdout);assert.equal(value.status,'ok');assert.equal(value.result.status,'compacted');
  assert.equal(await readFile(join(f.directory,'render/walkthrough.mp4'),'utf8'),f.removable['render/walkthrough.mp4']);
});
test('changed originals, edit identity, or duplicate output retain scratch',async t=>{
  const f=await fixture(t);
  await writeFile(join(f.sources,'source.mp4'),'changed original');await assert.rejects(f.compact(),/RETAINED_FILE_CHANGED/);
  await writeFile(join(f.sources,'source.mp4'),'unique sealed picture');
  const edit=await readFile(join(f.directory,'film-edit.json'),'utf8');await writeFile(join(f.directory,'film-edit.json'),edit.replace('Storage fixture','A different edit'));
  await assert.rejects(f.compact(),/FILM_COMPACT_INPUT_MISMATCH/);
  await writeFile(join(f.directory,'film-edit.json'),edit);await writeFile(join(f.directory,'render/poster.png'),'different renderer result');
  await assert.rejects(f.compact(),/FILM_COMPACT_DUPLICATE_MISMATCH/);
  assert.equal(await readFile(join(f.directory,'render/master.mov'),'utf8'),f.removable['render/master.mov']);
});
test('symlinked or unexpected scratch entries refuse the entire operation before deletion',async t=>{
  const f=await fixture(t),outside=join(f.root,'original.mp4');
  for(const relative of ['render/master.mov','render/assets/source-0.mp4','render/bundle/18.bundle.js','temporal-qa/camera-samples.gray']){
    const path=join(f.directory,relative),bytes=await readFile(path);await unlinkForFixture(path);await symlink(outside,path);
    await assert.rejects(f.compact(),/FILM_COMPACT_UNSAFE_PATH/);await unlinkForFixture(path);await writeFile(path,bytes);
  }
  await writeFile(join(f.directory,'render/bundle/my-notes.txt'),'unique notes');
  await assert.rejects(f.compact(),/FILM_COMPACT_UNSAFE_PATH/);
  for(const [name,bytes] of Object.entries(f.removable))assert.equal(await readFile(join(f.directory,name),'utf8'),bytes);
  assert.equal(await readFile(outside,'utf8'),'unique sealed picture');
});
test('redirected scratch directories and hard-linked files are never compacted',async t=>{
  const f=await fixture(t),assets=join(f.directory,'render/assets');await rm(assets,{recursive:true});await symlink(f.sources,assets);
  await assert.rejects(f.compact(),/FILM_COMPACT_UNSAFE_PATH/);await unlinkForFixture(assets);await mkdir(assets);
  const path=join(f.directory,'render/assets/source-0.mp4');await link(join(f.sources,'source.mp4'),path);
  await assert.rejects(f.compact(),/FILM_COMPACT_UNSAFE_PATH/);
  assert.equal(await readFile(join(f.sources,'source.mp4'),'utf8'),'unique sealed picture');
});
test('missing, corrupt or redirected retained narration refuses cleanup and preserves both staged audio copies',async t=>{
  const f=await fixture(t);
  for(const [relative,bytes] of Object.entries(f.audioFiles)){
    const path=join(f.directory,relative);
    await rm(path);await assert.rejects(f.compact(),/FILM_COMPACT_AUDIO_UNVERIFIED/);await writeFile(path,bytes);
    await writeFile(path,'corrupt retained audio or metadata');await assert.rejects(f.compact(),/FILM_COMPACT_AUDIO_UNVERIFIED/);await rm(path);
    await symlink(join(f.root,'original.mp4'),path);await assert.rejects(f.compact(),/FILM_COMPACT_AUDIO_UNVERIFIED/);await rm(path);await writeFile(path,bytes);
  }
  for(const [relative,bytes] of Object.entries(f.removable))assert.equal(await readFile(join(f.directory,relative),'utf8'),bytes);
});
test('well-formed but changed narration timing or synthesis metadata refuses cleanup',async t=>{
  const f=await fixture(t);
  for(const relative of ['audio/narration.json','audio/phrase/alignment.json','audio/phrase/synthesis.json']){
    const path=join(f.directory,relative),original=await readFile(path,'utf8'),changed=JSON.parse(original);
    if(relative==='audio/narration.json')changed.beats[0].durationSeconds=1.75;
    else if(relative.endsWith('/alignment.json'))changed.words[0].endSeconds=0.75;
    else changed.artifact.text='Different canonical phrase.';
    await writeFile(path,JSON.stringify(changed));await assert.rejects(f.compact(),/FILM_COMPACT_AUDIO_UNVERIFIED/);await writeFile(path,original);
  }
  for(const [relative,bytes] of Object.entries(f.removable))assert.equal(await readFile(join(f.directory,relative),'utf8'),bytes);
});

test('Italian narration with a selected provisioned voice compacts entirely from retained receipts',async t=>{
  const f=await fixture(t,{current:true,language:'Italian',voiceId:'copper_warm'});
  const alignment=JSON.parse(f.audioFiles['audio/phrase/alignment.json'].toString('utf8'));
  assert.deepEqual(alignment.captions.map((cue:{text:string})=>cue.text),['Apri il progetto','e scegli i dati per confrontare i risultati finali.']);
  assert.notDeepEqual(alignment.captions,captionCues(alignment.text,alignment.words),'the retained multi-cue Italian result must expose an English-default verifier');
  assert.equal((await f.compact()).status,'compacted');
  for(const [relative,bytes] of Object.entries(f.audioFiles))assert.deepEqual(await readFile(join(f.directory,relative)),bytes);
  for(const relative of f.kept)assert.equal(await readFile(join(f.directory,relative),'utf8'),`unique:${relative}`);
  assert.equal((await f.compact()).status,'already-compact');
});

test('reused historical speech keeps its original generation while current provision owns ASR',async t=>{
  const f=await fixture(t,{current:true,reuseHistorical:true});
  const narration=JSON.parse(f.audioFiles['audio/narration.json'].toString('utf8')),synthesis=JSON.parse(f.audioFiles['audio/phrase/synthesis.json'].toString('utf8'));
  assert.notEqual(narration.synthesisIdentity,narration.beats[0].synthesisIdentity,'fixture must distinguish the two real generation owners');
  assert.notDeepEqual(narration.runtime,synthesis.generationProvision.runtime);
  for(const [relative,mutate] of [
    ['audio/phrase/synthesis.json',(value:any)=>{delete value.generationProvision;}],
    ['audio/phrase/alignment.json',(value:any)=>{delete value.generationProvision;}],
    ['audio/narration.json',(value:any)=>{value.beats[0].synthesisIdentity=value.synthesisIdentity;}],
    ['audio/phrase/transcription.json',(value:any)=>{value.provider.runtime=synthesis.generationProvision.runtime;}],
  ] as const){
    const value=JSON.parse(f.audioFiles[relative].toString('utf8'));mutate(value);
    await writeFile(join(f.directory,relative),JSON.stringify(value));
    await assert.rejects(f.compact(),/FILM_COMPACT_AUDIO_UNVERIFIED/);
    await writeFile(join(f.directory,relative),f.audioFiles[relative]);
  }
  for(const [relative,bytes] of Object.entries(f.removable))assert.equal(await readFile(join(f.directory,relative),'utf8'),bytes);
  assert.equal((await f.compact()).status,'compacted');
  for(const [relative,bytes] of Object.entries(f.audioFiles))assert.deepEqual(await readFile(join(f.directory,relative)),bytes);
});

test('current ASR receipts are required and their language, audio and comparison cannot drift',async t=>{
  const f=await fixture(t,{current:true,language:'Italian',voiceId:'copper_warm'});
  const relative='audio/phrase/transcription.json',receiptPath=join(f.directory,relative),original=f.audioFiles[relative];
  await rm(receiptPath);await assert.rejects(f.compact(),/FILM_COMPACT_AUDIO_UNVERIFIED/);await writeFile(receiptPath,original);
  for(const mutate of [
    (value:any)=>{value.language='English';},
    (value:any)=>{value.wavSha256='0'.repeat(64);},
    (value:any)=>{value.provider.model_revision='0'.repeat(40);},
    (value:any)=>{value.comparison.status='mismatch';},
    (value:any)=>{value.transcript='Different retained transcript.';},
  ]){
    const value=JSON.parse(original.toString('utf8'));mutate(value);await writeFile(receiptPath,JSON.stringify(value));
    await assert.rejects(f.compact(),/FILM_COMPACT_AUDIO_UNVERIFIED/);await writeFile(receiptPath,original);
  }
  const narrationRelative='audio/narration.json',narration=JSON.parse(f.audioFiles[narrationRelative].toString('utf8'));
  narration.beats[0].transcription.manifestPath='/outside/transcription.json';
  await writeFile(join(f.directory,narrationRelative),JSON.stringify(narration));
  await assert.rejects(f.compact(),/FILM_COMPACT_AUDIO_UNVERIFIED/);
  for(const [relative,bytes] of Object.entries(f.removable))assert.equal(await readFile(join(f.directory,relative),'utf8'),bytes);
});

test('an honestly retained ASR mismatch remains review evidence, not a reason to discard the finished film',async t=>{
  const f=await fixture(t,{current:true,transcript:'Keep another phrase.'});
  const receipt=JSON.parse(f.audioFiles['audio/phrase/transcription.json'].toString('utf8'));
  assert.equal(receipt.comparison.status,'mismatch');
  assert.equal((await f.compact()).status,'compacted');
  assert.deepEqual(await readFile(join(f.directory,'audio/phrase/transcription.json')),f.audioFiles['audio/phrase/transcription.json']);
});

test('a retained-only editorial revision compacts from the actual reuse producer without installed audio owners',async t=>{
  const f=await fixture(t,{current:true,reuseHistorical:true}),id='composition-revised',directory=join(f.projectPath,'compositions',id);
  await mkdir(directory);
  for(const name of await readdir(f.directory))if(name!=='audio')await cp(join(f.directory,name),join(directory,name),{recursive:true});
  const edit=JSON.parse(await readFile(join(directory,'film-edit.json'),'utf8')) as FilmEdit;
  const narration=await reuseRetainedNarration({directory:join(f.directory,'audio'),outputDirectory:join(directory,'audio'),beats:edit.narration,voiceId:edit.voiceId,language:'English'});
  assert.ok(narration);assert.equal(narration.reuseOnly,true);
  assert.equal('synthesisIdentity' in narration,false,'retained-only manifests preserve identities per phrase, not a fabricated aggregate owner');
  const provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
  provenance.audio={...provenance.audio,mode:'retained-only',reuseCompositionId:f.id,phrases:narration.beats.map(beat=>({id:beat.id,text:beat.text,wavSha256:beat.wavSha256,cacheHit:true}))};
  await writeFile(join(directory,'provenance.json'),JSON.stringify(provenance));
  const plan=JSON.parse(await readFile(join(directory,'edit-plan.json'),'utf8'));
  plan.timeline=buildFilmTimeline(edit,narration,JSON.parse(await readFile(join(f.sources,'source-set.json'),'utf8')));
  await writeFile(join(directory,'edit-plan.json'),JSON.stringify(plan));
  const checksumsPath=join(directory,'checksums.json'),checksums=JSON.parse(await readFile(checksumsPath,'utf8'));
  for(const name of ['provenance.json','edit-plan.json'])checksums[name]=await fileDigest(join(directory,name));
  await writeFile(checksumsPath,JSON.stringify(checksums));
  await writeFile(join(directory,'composition.json'),JSON.stringify({...f.manifest,id}));
  // The current shared selection has drifted and cannot even be parsed. Neither
  // it nor the nonexistent Voices/model/reference paths may be consulted.
  await mkdir(join(f.root,'state','audio'),{recursive:true});await writeFile(join(f.root,'state','audio','provision.json'),'unavailable current runtime');
  const compact=()=>compactFilmComposition({projectPath:f.projectPath,compositionId:id});
  for(const name of ['narration.wav','synthesis.json','alignment.json','transcription.json'])assert.deepEqual(await readFile(join(directory,'audio/phrase',name)),await readFile(join(f.directory,'audio/phrase',name)));
  for(const name of ['narration.wav','synthesis.json','alignment.json','transcription.json']){
    const path=join(directory,'audio/phrase',name),original=await readFile(path);
    await rm(path);await assert.rejects(compact(),/FILM_COMPACT_AUDIO_UNVERIFIED/);await writeFile(path,original);
    await writeFile(path,name==='narration.wav'?Buffer.from('corrupt retained WAV'):Buffer.from('{}'));
    await assert.rejects(compact(),/FILM_COMPACT_AUDIO_UNVERIFIED/);await writeFile(path,original);
  }
  const before=await readFile(checksumsPath);
  const result=await compact();assert.equal(result.status,'compacted');assert.equal(result.removedFiles,Object.keys(f.removable).length);
  for(const name of ['narration.wav','synthesis.json','alignment.json','transcription.json'])assert.deepEqual(await readFile(join(directory,'audio/phrase',name)),await readFile(join(f.directory,'audio/phrase',name)));
  assert.deepEqual(await readFile(checksumsPath),before);
  assert.equal((await observeBundle(directory,'awaiting-human-review')).integrity,'verified');
});

test('duplicate-text phrases verify each retained receipt directory before compacting',async t=>{
  for(const corruption of ['none','synthesis','alignment'] as const)await t.test(corruption,async t=>{
    const f=await fixture(t,{current:true});
    const edit=JSON.parse(await readFile(join(f.directory,'film-edit.json'),'utf8')) as FilmEdit;
    edit.narration.push({...edit.narration[0],id:'repeat',outputStartSeconds:3});
    const audio=join(f.directory,'audio'),repeat=join(audio,'repeat');
    await cp(join(audio,'phrase'),repeat,{recursive:true});
    const narration=JSON.parse(await readFile(join(audio,'narration.json'),'utf8'));
    const second=structuredClone(narration.beats[0]);
    Object.assign(second,{id:'repeat',wavPath:join(repeat,'narration.wav'),cacheHit:true,alignmentCacheHit:true});
    Object.assign(second.transcription,{manifestPath:join(repeat,'transcription.json'),cacheHit:true});
    narration.beats.push(second);
    await writeFile(join(audio,'narration.json'),JSON.stringify(narration));
    await writeFile(join(f.directory,'film-edit.json'),JSON.stringify(edit));
    const provenance=JSON.parse(await readFile(join(f.directory,'provenance.json'),'utf8'));
    provenance.editSha256=await fileDigest(join(f.directory,'film-edit.json'));
    provenance.audio.phrases.push({id:'repeat',text:second.text,wavSha256:second.wavSha256,cacheHit:true});
    await writeFile(join(f.directory,'provenance.json'),JSON.stringify(provenance));
    const plan=JSON.parse(await readFile(join(f.directory,'edit-plan.json'),'utf8'));
    plan.edit=edit;
    plan.timeline=buildFilmTimeline(edit,narration,JSON.parse(await readFile(join(f.sources,'source-set.json'),'utf8')));
    await writeFile(join(f.directory,'edit-plan.json'),JSON.stringify(plan));
    const checksumsPath=join(f.directory,'checksums.json'),checksums=JSON.parse(await readFile(checksumsPath,'utf8'));
    for(const name of ['provenance.json','edit-plan.json'])checksums[name]=await fileDigest(join(f.directory,name));
    await writeFile(checksumsPath,JSON.stringify(checksums));
    if(corruption==='none'){
      assert.equal((await f.compact()).status,'compacted');
      for(const relative of Object.keys(f.removable))await assert.rejects(lstat(join(f.directory,relative)),{code:'ENOENT'});
    }else{
      const path=join(repeat,`${corruption}.json`),receipt=JSON.parse(await readFile(path,'utf8'));
      // The first phrase remains intact, with identical text, WAV and identities.
      // Its receipt cannot establish the validity of this second concrete owner.
      if(corruption==='synthesis')receipt.artifact={};else receipt.provider={};
      await writeFile(path,JSON.stringify(receipt));
      await assert.rejects(f.compact(),/FILM_COMPACT_AUDIO_UNVERIFIED/);
      for(const [relative,bytes] of Object.entries(f.removable))assert.equal(await readFile(join(f.directory,relative),'utf8'),bytes);
    }
  });
});

test('public project compact targets one exact occurrence and reports bounded byte removal',async t=>{
  const f=await fixture(t);
  const command=(args:string[])=>{
    const result=spawnSync(process.execPath,[join(import.meta.dirname,'../bin/walkthrough.mjs'),...args,'--project',f.projectPath,'--json'],{encoding:'utf8',env:{...process.env,WALKTHROUGH_STATE_ROOT:join(f.root,'state')},timeout:15000});
    assert.ifError(result.error);assert.equal(result.stderr,'');assert.equal(result.stdout.trim().split('\n').length,1);
    return {code:result.status,record:JSON.parse(result.stdout)};
  };
  assert.equal(command(['project','compact','--composition','../outside']).record.error.code,'INVALID_ID');
  const compacted=command(['project','compact','--composition',f.id]);assert.equal(compacted.code,0,JSON.stringify(compacted.record));
  assert.equal(compacted.record.result.status,'compacted');assert.equal(compacted.record.result.removedFiles,Object.keys(f.removable).length);
  assert.equal(command(['project','compact','--composition',f.id]).record.result.status,'already-compact');
  await writeFile(join(f.directory,'walkthrough.mp4'),'changed');
  const invalid=command(['project','compact','--composition',f.id]);assert.equal(invalid.code,1);assert.equal(invalid.record.error.code,'FILM_COMPACT_BUNDLE_NOT_VERIFIED');
  assert.equal(JSON.parse(await readFile(join(f.directory,'composition.json'),'utf8')).status,'awaiting-human-review');
});

async function unlinkForFixture(path:string){await rm(path);}

test('failed preview compacts verified subset narration offline and retains sole encoded outputs and evidence',async t=>{
  const f=await fixture(t,{preview:true,current:true,language:'Italian'}),error=await failFixture(f);
  const edit=await readFile(join(f.directory,'film-edit.json')),plan=await readFile(join(f.directory,'edit-plan.json'));
  assert.equal(JSON.parse(edit.toString()).narration.length,2);
  await assert.rejects(lstat(join(f.directory,'audio/outside-preview')),{code:'ENOENT'});
  await writeFile(join(f.directory,'preview.mp4'),'sole copied preview');
  const result=await f.compact();
  assert.equal(result.status,'compacted');assert.equal(result.removedFiles,Object.keys(f.removable).length-2);
  for(const [name,bytes] of Object.entries(f.removable)){
    if(['render/walkthrough.mp4','render/poster.png'].includes(name))assert.equal(await readFile(join(f.directory,name),'utf8'),bytes);
    else await assert.rejects(lstat(join(f.directory,name)),{code:'ENOENT'});
  }
  assert.equal(await readFile(join(f.directory,'preview.mp4'),'utf8'),'sole copied preview');
  for(const [name,bytes] of Object.entries(f.audioFiles))assert.deepEqual(await readFile(join(f.directory,name)),bytes);
  for(const name of f.kept)assert.equal(await readFile(join(f.directory,name),'utf8'),`unique:${name}`);
  assert.deepEqual(await readFile(join(f.directory,'film-edit.json')),edit);assert.deepEqual(await readFile(join(f.directory,'edit-plan.json')),plan);
  assert.equal(await readFile(join(f.sources,'source.mp4'),'utf8'),'unique sealed picture');
  const retained=JSON.parse(await readFile(join(f.directory,'preview.json'),'utf8'));
  assert.equal(retained.status,'failed');assert.deepEqual(retained.error,error);assert.deepEqual(retained.storage,result);
  assert.deepEqual(await f.compact(),{status:'already-compact',removedFiles:0,removedLogicalBytes:0});
});
test('failed preview rejects changed selected audio, source, range and measured selection before removing anything',async t=>{
  const f=await fixture(t,{preview:true,current:true});await failFixture(f);
  for(const relative of ['audio/phrase/narration.wav','audio/phrase/synthesis.json','audio/phrase/alignment.json','audio/phrase/transcription.json']){
    const path=join(f.directory,relative),bytes=await readFile(path);
    await writeFile(path,'corrupt');await assert.rejects(f.compact(),/FILM_COMPACT_AUDIO_UNVERIFIED/);await writeFile(path,bytes);
  }
  const source=join(f.sources,'source.mp4'),sourceBytes=await readFile(source);
  await writeFile(source,'corrupt');await assert.rejects(f.compact(),/RETAINED_FILE_CHANGED/);await writeFile(source,sourceBytes);
  const planPath=join(f.directory,'edit-plan.json'),planBytes=await readFile(planPath),plan=JSON.parse(planBytes.toString());
  for(const changed of [
    {...plan,measuredPhraseIds:['outside-preview']},
    {...plan,measuredPhraseIds:['phrase','outside-preview']},
    {...plan,frameRange:[120,360]},
    {...plan,edit:{...plan.edit,title:'different edit'}},
  ]){await writeFile(planPath,JSON.stringify(changed));await assert.rejects(f.compact(),/FILM_COMPACT_INPUT_MISMATCH/);}
  await writeFile(planPath,planBytes);
  const manifestPath=join(f.directory,'preview.json'),manifestBytes=await readFile(manifestPath),manifest=JSON.parse(manifestBytes.toString());
  for(const range of [{...manifest.range,frameRange:[121,359]},{...manifest.range,fps:30}]){
    await writeFile(manifestPath,JSON.stringify({...manifest,range}));await assert.rejects(f.compact(),/FILM_COMPACT_INPUT_MISMATCH/);
  }
  await writeFile(manifestPath,JSON.stringify({...manifest,range:{...manifest.range,toSeconds:11}}));await assert.rejects(f.compact(),/FILM_PREVIEW_RANGE/);
  await writeFile(manifestPath,manifestBytes);
  for(const [name,bytes] of Object.entries(f.removable))assert.equal(await readFile(join(f.directory,name),'utf8'),bytes);
});
test('preview compaction rejects ready, running, current and live-owned attempts without altering current or active metadata',async t=>{
  const f=await fixture(t,{preview:true}),root=join(f.projectPath,'previews'),manifestPath=join(f.directory,'preview.json');await failFixture(f);
  const manifest=await readFile(manifestPath),failed=JSON.parse(manifest.toString());
  for(const status of ['ready','running']){await writeFile(manifestPath,JSON.stringify({...failed,status}));await assert.rejects(f.compact(),/FILM_COMPACT_NOT_FAILED_PREVIEW/);}
  await writeFile(manifestPath,manifest);
  const currentPath=join(root,'current.json'),current=JSON.stringify({schemaVersion:1,kind:'current-preview',id:f.id});await writeFile(currentPath,current);
  await assert.rejects(f.compact(),/FILM_COMPACT_CURRENT_PREVIEW/);assert.equal(await readFile(currentPath,'utf8'),current);await rm(currentPath);
  const currentId='preview-87654321-1234-1234-1234-123456789abc',currentDirectory=join(root,currentId);await mkdir(currentDirectory);
  await writeFile(join(currentDirectory,'preview.mp4'),'current sample');await writeFile(currentPath,JSON.stringify({schemaVersion:1,kind:'current-preview',id:currentId}));
  await activity(f,{coordinatorPid:process.pid});await assert.rejects(f.compact(),/FILM_COMPACT_ACTIVE_WORK/);
  await rm(join(f.root,'state','active','activity.json'));
  const owner=await beginPreview(f.projectPath),activePath=join(root,'active.json'),active=await readFile(activePath);
  try{await assert.rejects(f.compact(),/FILM_PREVIEW_ACTIVE/);assert.deepEqual(await readFile(activePath),active);}finally{await owner.release();}
  assert.equal((await f.compact()).status,'compacted');
  assert.equal(await readFile(join(currentDirectory,'preview.mp4'),'utf8'),'current sample');
  assert.equal(JSON.parse(await readFile(currentPath,'utf8')).id,currentId);
});
test('early failed preview without render scratch is already compact without a plan or narration',async t=>{
  const f=await fixture(t,{preview:true});await failFixture(f);
  for(const name of ['render','temporal-qa','audio','edit-plan.json','film-edit.json'])await rm(join(f.directory,name),{recursive:true});
  assert.deepEqual(await f.compact(),{status:'already-compact',removedFiles:0,removedLogicalBytes:0});
});
test('preview with only later narration verifies a silent selected timeline without audio or current setup',async t=>{
  const f=await fixture(t,{preview:true});await failFixture(f);
  const editPath=join(f.directory,'film-edit.json'),edit=JSON.parse(await readFile(editPath,'utf8'));
  edit.narration[0].outputStartSeconds=7;
  const planPath=join(f.directory,'edit-plan.json'),plan=JSON.parse(await readFile(planPath,'utf8'));
  const set=JSON.parse(await readFile(join(f.sources,'source-set.json'),'utf8'));
  plan.edit=edit;plan.measuredPhraseIds=[];plan.timeline=buildFilmTimeline({...edit,narration:[]},{beats:[]},set);
  await writeFile(editPath,JSON.stringify(edit));await writeFile(planPath,JSON.stringify(plan));
  await rm(join(f.directory,'audio'),{recursive:true});
  for(const relative of ['render/assets/beat-0.wav','render/bundle/public/beat-0.wav'])await rm(join(f.directory,relative));
  const config=join(f.root,'config');await mkdir(config);await writeFile(join(config,'toolchain.json'),'invalid current setup must not be read');
  const previous=process.env.WALKTHROUGH_CONFIG_ROOT;process.env.WALKTHROUGH_CONFIG_ROOT=config;
  t.after(async()=>{if(previous===undefined)delete process.env.WALKTHROUGH_CONFIG_ROOT;else process.env.WALKTHROUGH_CONFIG_ROOT=previous;});
  const valid=await readFile(planPath);plan.timeline.durationSeconds=999;await writeFile(planPath,JSON.stringify(plan));
  await assert.rejects(f.compact(),/FILM_COMPACT_INPUT_MISMATCH/);await writeFile(planPath,valid);
  assert.equal((await f.compact()).status,'compacted');
});
test('preview admission binds project, kind, schema, exact attempt identity and recorded failure',async t=>{
  const f=await fixture(t,{preview:true});await failFixture(f);
  const path=join(f.directory,'preview.json'),manifest=JSON.parse(await readFile(path,'utf8'));
  for(const delta of [{schemaVersion:2},{kind:'composition'},{id:'preview-87654321-1234-1234-1234-123456789abc'},{projectPath:f.root},{error:null}]){
    await writeFile(path,JSON.stringify({...manifest,...delta}));await assert.rejects(f.compact(),/FILM_COMPACT_NOT_FAILED_PREVIEW/);
  }
  assert.equal(await readFile(join(f.directory,'render/master.mov'),'utf8'),f.removable['render/master.mov']);
});
test('failed preview refuses unexpected and redirected scratch before any removal',async t=>{
  const f=await fixture(t,{preview:true});await failFixture(f);
  const master=join(f.directory,'render/master.mov'),bytes=await readFile(master);await rm(master);await symlink(join(f.sources,'source.mp4'),master);
  await assert.rejects(f.compact(),/FILM_COMPACT_UNSAFE_PATH/);await rm(master);await writeFile(master,bytes);
  await writeFile(join(f.directory,'render/bundle/notes.txt'),'not regenerable');await assert.rejects(f.compact(),/FILM_COMPACT_UNSAFE_PATH/);
  assert.deepEqual(await readFile(master),bytes);
});
test('failed preview retains bounded interrupted atomic progress writes without parsing or adopting them',async t=>{
  const name='progress.json.71743404-da00-434a-ac02-bf479a650838.tmp';
  for(const [kind,bytes] of [
    ['empty',''],
    ['partial','{"schemaVersion":1,"kind":"render-progress",'],
    ['valid',JSON.stringify({schemaVersion:1,kind:'render-progress',recordedAt:'2026-10-21T10:00:00.000Z',phase:'rendering-and-encoding',frames:{rendered:0,total:2520}})],
    ['maximum-opaque','x'.repeat(4096)],
  ])await t.test(kind,async t=>{
    const f=await fixture(t,{preview:true}),error=await failFixture(f),path=join(f.directory,'render',name);
    const progress=await readFile(join(f.directory,'render/progress.json'));await writeFile(path,bytes);
    const result=await f.compact();
    assert.equal(result.status,'compacted');assert.equal(result.removedFiles,Object.keys(f.removable).length-2);
    assert.equal(await readFile(path,'utf8'),bytes);
    assert.deepEqual(await readFile(join(f.directory,'render/progress.json')),progress,'a temporary write never replaces the retained observation');
    const manifest=JSON.parse(await readFile(join(f.directory,'preview.json'),'utf8'));
    assert.equal(manifest.status,'failed');assert.deepEqual(manifest.error,error);
    assert.equal((await f.compact()).status,'already-compact');assert.equal(await readFile(path,'utf8'),bytes);
  });
});
test('redirected, hard-linked, unrecognized or oversized progress temporaries refuse all failed-preview removal',async t=>{
  const name='progress.json.71743404-da00-434a-ac02-bf479a650838.tmp';
  for(const kind of ['symlink','hardlink','unrecognized','uppercase-uuid','oversized'])await t.test(kind,async t=>{
    const f=await fixture(t,{preview:true});await failFixture(f);
    const progress=await readFile(join(f.directory,'render/progress.json')),outside=join(f.root,'interrupted-progress.txt');
    await writeFile(outside,'retained outside diagnostic');
    const path=join(f.directory,'render',kind==='unrecognized'?'progress.json.not-a-uuid.tmp':kind==='uppercase-uuid'?name.replace('da00','DA00'):name);
    if(kind==='symlink')await symlink(outside,path);
    else if(kind==='hardlink')await link(outside,path);
    else await writeFile(path,kind==='oversized'?'x'.repeat(4097):'unrecognized diagnostic');
    await assert.rejects(f.compact(),/FILM_COMPACT_UNSAFE_PATH/);
    for(const [relative,bytes] of Object.entries(f.removable))assert.equal(await readFile(join(f.directory,relative),'utf8'),bytes);
    assert.deepEqual(await readFile(join(f.directory,'render/progress.json')),progress);
    assert.equal(await readFile(outside,'utf8'),'retained outside diagnostic');
    assert.equal(JSON.parse(await readFile(join(f.directory,'preview.json'),'utf8')).storage,undefined);
  });
});
test('public compact preview selects one exact failed target and rejects missing or competing target flags',async t=>{
  const f=await fixture(t,{preview:true});await failFixture(f);
  const command=(args:string[])=>{
    const result=spawnSync(process.execPath,[join(import.meta.dirname,'../bin/walkthrough.mjs'),'project','compact','--project',f.projectPath,...args,'--json'],{encoding:'utf8',env:{...process.env,WALKTHROUGH_STATE_ROOT:join(f.root,'state')},timeout:15000});
    assert.ifError(result.error);assert.equal(result.stderr,'');assert.equal(result.stdout.trim().split('\n').length,1);
    return {code:result.status,record:JSON.parse(result.stdout)};
  };
  for(const args of [[],['--preview'],['--preview',f.id,'--composition','other']])assert.equal(command(args).record.error.code,'INVALID_COMMAND');
  assert.equal(command(['--preview','../outside']).record.error.code,'FILM_PREVIEW_ID_INVALID');
  const compacted=command(['--preview',f.id]);assert.equal(compacted.code,0,JSON.stringify(compacted.record));assert.equal(compacted.record.result.status,'compacted');
  assert.equal(command(['--preview',f.id]).record.result.status,'already-compact');
  assert.equal(await readFile(join(f.directory,'render/walkthrough.mp4'),'utf8'),f.removable['render/walkthrough.mp4']);
});
