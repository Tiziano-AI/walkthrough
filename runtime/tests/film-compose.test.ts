import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,lstat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {composeFilm,validateFilm,previewFilm} from '../src/core/film.ts';
import {previewFrameRange} from '../src/core/film-edit.ts';
import {Failure} from '../src/core/contracts.ts';
import {executeLocal,LocalProcessFailure} from '../src/render/media.ts';
import {inspectCurrentPreview} from '../src/core/film-preview-storage.ts';
import {LOUDNESS_POLICY} from '../src/render/loudness.ts';
import type {FilmEdit} from '../src/core/film-edit.ts';
import {createProject,createCompositionDirectory,loadSourceSet,readProject,retainFile,saveSourceSet} from '../src/project/store.ts';
import type {SourceSet} from '../src/project/contracts.ts';
import {fileDigest} from '../src/core/files.ts';
import {readAudioProvision} from '../src/audio/provision.ts';
import {synthesizeNarration,type NarrationBeat} from '../src/audio/index.ts';
import {inspectRetainedNarration} from '../src/audio/retained.ts';
import {runtimePaths} from '../src/core/runtime-paths.ts';
import type {qualifyTemporalVideo} from '../src/core/quality.ts';

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'film-compose-')),projectPath=join(root,'project');
  const {project}=await createProject(projectPath,{title:'Example',brief:'Explore the real product.',audience:'A first-time viewer',mandate:{applicationUrl:'https://example.invalid/',navigationOrigins:['https://example.invalid'],network:'web',allowedEffects:'Read-only exploration',dataDescription:'Synthetic test only',inputRoots:[],mediaReview:'agent-reviewable-synthetic',delivery:'local'}});
  const directory=join(projectPath,'sources','sources-test');await mkdir(directory);
  const input=join(root,'synthetic-source.mp4');await writeFile(input,'synthetic fixture bytes; not playable media');
  const media=await retainFile(input,directory,'source.mp4');
  const sourceSet:SourceSet={schemaVersion:1,kind:'source-set',id:'sources-test',projectId:project.id,createdAt:new Date().toISOString(),state:'sealed',mediaReview:'agent-reviewable-synthetic',sources:[{id:'take-one',media,width:3200,height:1800,durationSeconds:2,frameCount:120,clock:{offsetSeconds:0,uncertaintySeconds:0,driftSeconds:0},pointer:[],usableRange:{startSeconds:0,endSeconds:2}}],marks:[],artifacts:[]};
  const saved=await saveSourceSet(projectPath,sourceSet);
  const edit:FilmEdit={schemaVersion:1,sourceSetId:sourceSet.id,sourceSetSha256:saved.sha256,title:'Explore example',brief:'See the whole product.',voiceId:'copilot-female-1',pictures:[{id:'overview',sourceId:'take-one',kind:'live',transition:'cut',startSeconds:0,endSeconds:2,zoom:1,target:null}],narration:[]};
  return {root,projectPath,edit,directory};
}
function simulatedDependencies():NonNullable<Parameters<typeof composeFilm>[1]>{
  return {loadSourceSet,readProject,createCompositionDirectory,fileDigest,readAudioProvision,inspectRetainedNarration,synthesizeNarration,
    filmRuntimeIdentity:async()=>({kind:'development-source',releaseSha256:null,digest:'f'.repeat(64),files:{}}),
    filmPreflight:async()=>({schemaVersion:1,status:'provisioned',tools:{nodePath:'/synthetic/node',browserPath:'/synthetic/browser',ffmpegPath:'/synthetic/ffmpeg',ffprobePath:'/synthetic/ffprobe'},checks:[],appAccess:false,downloads:false}),
    renderWalkthrough:async options=>{
      await mkdir(options.directory);const videoPath=join(options.directory,'walkthrough.mp4'),posterPath=join(options.directory,'poster.png'),masterPath=join(options.directory,'master.mov');
      await writeFile(videoPath,'simulated renderer output');await writeFile(posterPath,'simulated poster');await writeFile(masterPath,'regenerable master');
      assert.equal(options.timeline.segments[0].durationSeconds,2);
      return {videoPath,posterPath,masterPath,metrics:{expectedFrames:options.frameRange?options.frameRange[1]-options.frameRange[0]+1:120,master:{streams:[],format:{}},delivery:{streams:[],format:{}},audioTiming:{passed:true,masterStartSeconds:0,deliveredStartSeconds:0,masterDurationSeconds:2,deliveredDurationSeconds:2,startToleranceSeconds:1/48000,durationToleranceSeconds:1024/48000},audioLoudness:{status:'skipped-silent',policy:LOUDNESS_POLICY,input:null,normalization:null,delivered:null,acceptance:null},viewerAcceptance:'not-established',sourceCadenceAcceptance:'owned-by-capture-qualification'}};
    },
    qualifyTemporalVideo:async()=>({schemaVersion:3,presentation:'full-frame-visible-captions',sourceCadence:{},frozenCamera:{status:'not-assessed',assessmentScope:'static-framing-live-sample-pairs',decodedSamples:20,testedPairs:0,frozenPairs:0,changingCameraPairs:0,captionMaskedPairs:0,longestConsecutiveFrozenPairs:0,frozenDefectThresholdSeconds:0.3,sampleSpacingSeconds:0.1,minimumSourceMeanDifference:1,minimumTexturedTiles:6},limits:[]}) satisfies Awaited<ReturnType<typeof qualifyTemporalVideo>>,
  };
}

function measuredNarrationDependencies(durations:number[]){
  const deps=simulatedDependencies();
  // Runtime and synthesis are outside this contract test. Preserve their measured
  // result through the real planning, failure, persistence and public-result seam.
  deps.readAudioProvision=async()=>({schemaVersion:2,voice:{id:'copilot-female-1'},runtime:{}} as Awaited<ReturnType<typeof readAudioProvision>>);
  deps.fileDigest=async path=>path===runtimePaths().audioProvisionPath?'a'.repeat(64):fileDigest(path);
  deps.synthesizeNarration=async input=>{
    const directory=join(input.runDirectory,'audio');await mkdir(directory);
    const beats:NarrationBeat[]=input.beats.map((phrase,index)=>{
      const durationSeconds=durations[index];
      return {...phrase,durationSeconds,wavPath:join(directory,`${phrase.id}.wav`),words:[],captions:[{text:phrase.text,startSeconds:0,endSeconds:durationSeconds}],cacheHit:true,wavSha256:'c'.repeat(64),unresolvedWordCount:0,metrics:{durationSeconds,sampleRate:24000,channels:1,peak:0.5,rms:0.1,clippedSampleFraction:0,wordsPerMinute:120}};
    });
    const result={schemaVersion:1 as const,voiceId:input.voiceId!,language:'English' as const,beats,manifestPath:join(directory,'narration.json'),vttPath:join(directory,'captions.vtt'),spokenContentVerified:false as const,humanListeningRequired:true as const};
    await writeFile(result.manifestPath,JSON.stringify(result));return result;
  };
  return deps;
}

test('validation uses a project outside the checkout and does not create a composition',async()=>{
  const {projectPath,edit}=await fixture();const result=await validateFilm({projectPath,edit});
  assert.equal(result.valid,true);assert.equal(result.synthesis,false);assert.equal(result.render,false);assert.equal(result.durationSeconds,2);
  await assert.rejects(validateFilm({projectPath,edit:{...edit,sourceSetSha256:'0'.repeat(64)}}),/FILM_SOURCE_DIGEST_MISMATCH/);
});
test('offline composition writes a portable bundle and preserves human acceptance as unknown',async()=>{
  const {projectPath,edit}=await fixture();const result=await composeFilm({projectPath,edit},simulatedDependencies());
  assert.equal(result.status,'awaiting-human-review');assert.equal(result.bundle.integrity,'verified');assert.equal(result.bundle.availability,'complete');
  assert.ok(result.bundle.reviewPath?.startsWith(join(result.projectPath,'compositions')));
  assert.deepEqual(result.proof.human,{watchedComplete:false,listenedComplete:false,comprehension:null});
  const provenance=JSON.parse(await readFile(result.paths['provenance.json'],'utf8'));
  assert.equal(provenance.appAccess,false);assert.equal(provenance.automaticReplay,false);
  assert.equal(JSON.parse(await readFile(result.paths['qa.json'],'utf8')).automated.frozenCamera,'not-assessed');
  assert.equal(result.storage?.status,'compacted');assert.equal(result.storage.removedFiles,3);
  await assert.rejects(lstat(join(projectPath,'compositions',result.id,'render/master.mov')),{code:'ENOENT'});
});
test('failed preflight retains the occurrence without invoking synthesis or renderer',async()=>{
  const {projectPath,edit}=await fixture(),deps=simulatedDependencies();
  deps.filmPreflight=async()=>({schemaVersion:1,status:'not-ready',tools:{nodePath:'',browserPath:'',ffmpegPath:'',ffprobePath:''},checks:[{name:'renderer',ok:false,code:'DEPENDENCY_UNAVAILABLE'}],appAccess:false,downloads:false});
  deps.renderWalkthrough=async()=>{assert.fail('renderer must not run');};deps.synthesizeNarration=async()=>{assert.fail('synthesis must not run');};
  const result=await composeFilm({projectPath,edit},deps);
  assert.equal(result.status,'failed');assert.equal(result.error?.code,'FILM_PREFLIGHT_NOT_READY');assert.equal(result.bundle.reviewPath,null);
  const recorded=JSON.parse(await readFile(join(projectPath,'compositions',result.id,'composition.json'),'utf8'));assert.equal(recorded.id,result.id);assert.equal(recorded.stage,'preflight');
});
test('rejected measured narration retains actionable phrase fit before rendering',async()=>{
  const {projectPath,edit}=await fixture(),deps=measuredNarrationDependencies([1.004,1.009]);
  edit.narration=[{id:'intro',text:'The overview.',outputStartSeconds:0},{id:'result',text:'The result.',outputStartSeconds:1}];
  deps.renderWalkthrough=async()=>{assert.fail('unfitted narration must not render');};
  const result=await composeFilm({projectPath,edit},deps);
  assert.equal(result.status,'failed');assert.equal(result.error?.code,'FILM_NARRATION_OVERLAP');
  assert.equal(result.error?.owner,'film-edit');assert.equal(result.stage,'narration-fit');
  assert.equal(result.narrationFit?.status,'rejected');
  assert.equal(result.narrationFit?.conflictingPhraseCount,2);
  const fit=result.narrationFitDiagnostics?.record;
  assert.equal(fit?.pictureDurationSeconds,2);
  assert.deepEqual(fit?.phrases.items.map(phrase=>({phraseId:phrase.phraseId,measured:phrase.measuredDurationSeconds,occupied:phrase.occupiedDurationSeconds})),[
    {phraseId:'intro',measured:1.004,occupied:61/60},{phraseId:'result',measured:1.009,occupied:61/60},
  ]);
  assert.deepEqual(fit?.phrases.items[0].nextPhrase,{phraseId:'result',outputStartSeconds:1,requiredClearanceSeconds:1/60});
  assert.deepEqual(fit?.phrases.items[1].pictureEnd,{outputEndSeconds:2,requiredClearanceSeconds:1/60});
  const directory=join(projectPath,'compositions',result.id);
  const retained=JSON.parse(await readFile(join(directory,'narration-fit.json'),'utf8'));
  assert.equal(retained.phrases.length,2);
  const manifest=JSON.parse(await readFile(join(directory,'composition.json'),'utf8'));
  assert.deepEqual(manifest.narrationFit,result.narrationFit);
  assert.equal(manifest.narrationFit.phrases,undefined,'phrase details have one durable owner');
  const audio=JSON.parse(await readFile(join(directory,'audio/narration.json'),'utf8'));
  assert.deepEqual(audio.beats.map((beat:NarrationBeat)=>beat.durationSeconds),[1.004,1.009]);
  assert.deepEqual(audio.beats.map((beat:NarrationBeat)=>beat.cacheHit),[true,true]);
  assert.equal(JSON.stringify(result).includes('The overview.'),false,'diagnostics do not repeat speech text');
});
test('compose and preview bypass live audio readiness only when explicit retained phrases fully verify',async()=>{
  const {projectPath,edit}=await fixture(),initial=measuredNarrationDependencies([0.5]);
  edit.narration=[{id:'intro',text:'The overview.',outputStartSeconds:0}];
  const original=await composeFilm({projectPath,edit},initial);assert.equal(original.status,'awaiting-human-review');
  for(const mode of ['compose','preview'] as const){
    const deps=measuredNarrationDependencies([0.5]);
    deps.inspectRetainedNarration=async input=>{assert.equal(input.directory,join(original.projectPath,'compositions',original.id,'audio'));assert.deepEqual(input.beats.map(beat=>beat.text),['The overview.']);return {complete:true,voiceId:edit.voiceId,language:'English',beats:[],narration:{provisionManifestSha256:'a'.repeat(64)},provision:{schemaVersion:2,runtime:{voices_version:'historical-only'}} as Awaited<ReturnType<typeof readAudioProvision>>,provisionPath:join(projectPath,'historical-provision.json')};};
    await writeFile(join(projectPath,'historical-provision.json'),'retained original identity');
    deps.readAudioProvision=async()=>{assert.fail('a retained-only editorial revision must not load selected provisioning');};
    deps.filmPreflight=async input=>{assert.equal(input.narration,false,'Voices readiness is not a renderer prerequisite');return simulatedDependencies().filmPreflight(input);};
    const result=mode==='compose'?await composeFilm({projectPath,edit,reuseAudio:original.id},deps):await previewFilm({projectPath,edit,reuseAudio:original.id,from:0,to:1},deps);
    assert.equal(result.status,mode==='compose'?'awaiting-human-review':'ready',JSON.stringify(result));
    if(mode==='compose'){
      const provenance=JSON.parse(await readFile((result as any).paths['provenance.json'],'utf8'));
      assert.equal(provenance.audio.mode,'retained-only');assert.equal(provenance.audio.runtime.voices_version,'historical-only');
    }
  }
});
test('picture overrun returns measured fit and editing starts preserves the synthesis request',async()=>{
  const {projectPath,edit}=await fixture(),deps=measuredNarrationDependencies([1.009]),requests:unknown[]=[];
  edit.narration=[{id:'intro',text:'The overview.',outputStartSeconds:1}];
  const synthesize=deps.synthesizeNarration;deps.synthesizeNarration=async input=>{requests.push(input.beats);return synthesize(input);};
  const rejected=await composeFilm({projectPath,edit},deps);
  assert.equal(rejected.error?.code,'FILM_NARRATION_EXCEEDS_PICTURES');
  assert.deepEqual(rejected.narrationFitDiagnostics?.record?.phrases.items[0].pictureEnd,{outputEndSeconds:2,requiredClearanceSeconds:1/60});
  edit.narration[0].outputStartSeconds=59/60;
  const fitted=await composeFilm({projectPath,edit},deps);
  assert.equal(fitted.status,'awaiting-human-review');assert.equal(fitted.narrationFit?.status,'fits');
  assert.equal(fitted.narrationFitDiagnostics,undefined,'successful response keeps only the summary');
  assert.deepEqual(requests,[[{id:'intro',text:'The overview.'}],[{id:'intro',text:'The overview.'}]],'output placement never enters or invalidates the audio request');
  const measured=JSON.parse(await readFile(fitted.paths['narration-fit.json'],'utf8'));
  assert.equal(measured.phrases[0].measuredDurationSeconds,1.009);assert.equal(measured.phrases[0].occupiedEndSeconds,2);
});
test('rejected compose bounds returned conflicts while retaining every measured phrase',async()=>{
  const {projectPath,edit}=await fixture(),deps=measuredNarrationDependencies(Array(23).fill(3));
  edit.narration=Array.from({length:23},(_,index)=>({id:`phrase-${index}`,text:'A phrase.',outputStartSeconds:0}));
  deps.renderWalkthrough=async()=>{assert.fail('unfitted narration must not render');};
  const result=await composeFilm({projectPath,edit},deps),page=result.narrationFitDiagnostics?.record?.phrases;
  assert.equal(result.narrationFit?.phraseCount,23);assert.equal(page?.total,23);assert.equal(page?.items.length,20);assert.equal(page?.nextOffset,20);
  const retained=JSON.parse(await readFile(result.paths['narration-fit.json'],'utf8'));
  assert.equal(retained.phrases.length,23);assert.equal(retained.phrases.at(-1).phraseId,'phrase-22');
});
test('measured caption defects retain exact editorial ownership and never reach rendering',async()=>{
  for(const defect of ['fit','subject'] as const){
    const {projectPath,edit}=await fixture(),deps=measuredNarrationDependencies([1]);
    edit.narration=[{id:'intro',text:'The overview.',outputStartSeconds:0}];
    if(defect==='fit')edit.pictures[0].captionPlacement={x:0,y:0,width:40};
    else edit.pictures[0].target={x:1550,y:1630,width:100,height:60};
    deps.renderWalkthrough=async()=>{assert.fail('caption defects must fail before rendering');};
    const result=await composeFilm({projectPath,edit},deps);
    assert.equal(result.status,'failed');assert.equal(result.stage,'film-edit');assert.equal(result.error?.owner,'film-edit');
    assert.equal(result.error?.code,defect==='fit'?'FILM_CAPTION_DOES_NOT_FIT':'FILM_CAPTION_SUBJECT_OVERLAP');
    assert.equal(result.error?.caption?.pictureId,'overview');assert.equal(result.error?.caption?.phraseId,'intro');
    assert.equal(result.narrationFit?.status,'fits','successful speech-fit remains distinct from caption failure');
    const retained=JSON.parse(await readFile(join(projectPath,'compositions',result.id,'composition.json'),'utf8'));
    assert.deepEqual(retained.error,result.error);
  }
});
test('structurally impossible caption placement rejects compose before synthesis',async()=>{
  const {projectPath,edit}=await fixture(),deps=measuredNarrationDependencies([1]);
  edit.narration=[{id:'intro',text:'The overview.',outputStartSeconds:0}];edit.pictures[0].captionPlacement={x:0,y:0,width:28};
  deps.synthesizeNarration=async()=>{assert.fail('invalid placement must fail before synthesis');};
  await assert.rejects(composeFilm({projectPath,edit},deps),{code:'INVALID_FILM_CAPTION_PLACEMENT',owner:'film-edit',caption:{pictureId:'overview',phraseId:null,placement:{x:0,y:0,width:28}}});
});
test('changed sealed bytes invalidate completion and do not trigger a fresh acquisition',async()=>{
  const {projectPath,edit,directory}=await fixture(),deps=simulatedDependencies(),render=deps.renderWalkthrough;
  deps.renderWalkthrough=async options=>{const result=await render(options);await writeFile(join(directory,'source.mp4'),'changed source');return result;};
  const result=await composeFilm({projectPath,edit},deps);
  assert.equal(result.status,'failed');assert.equal(result.error?.code,'RETAINED_FILE_CHANGED');assert.equal(result.bundle.reviewPath,null);
  assert.equal(await readFile(join(projectPath,'compositions',result.id,'render/master.mov'),'utf8'),'regenerable master');
});
test('scratch cleanup refusal never relabels or hides a useful completed film',async()=>{
  const {projectPath,edit}=await fixture(),deps=simulatedDependencies(),render=deps.renderWalkthrough;
  deps.renderWalkthrough=async options=>{const result=await render(options);await writeFile(join(options.directory,'unrecognized-input.txt'),'keep this unique input');return result;};
  const result=await composeFilm({projectPath,edit},deps);
  assert.equal(result.status,'awaiting-human-review');assert.equal(result.bundle.integrity,'verified');assert.ok(result.bundle.reviewPath);
  assert.equal(result.storage?.status,'retained');assert.equal(result.storage.error?.code,'FILM_COMPACT_UNSAFE_PATH');
  assert.equal(await readFile(join(projectPath,'compositions',result.id,'render/master.mov'),'utf8'),'regenerable master');
});
test('preview uses the exact absolute half-open frame range and preserves speech begun earlier',async()=>{
  const {projectPath,edit}=await fixture(),deps=measuredNarrationDependencies([1.5]);
  edit.narration=[{id:'earlier',text:'Speech crossing the preview start.',outputStartSeconds:0},{id:'later',text:'Not in this preview.',outputStartSeconds:1.9}];
  const render=deps.renderWalkthrough,synthesize=deps.synthesizeNarration;
  deps.synthesizeNarration=async input=>{assert.deepEqual(input.beats.map(beat=>beat.id),['earlier']);return synthesize(input);};
  deps.renderWalkthrough=async options=>{assert.deepEqual(options.frameRange,[60,107]);assert.equal(options.timeline.narration[0].outputStartSeconds,0);assert.equal(options.timeline.narration[0].durationSeconds,1.5);assert.equal(options.timeline.segments[0].outputStartSeconds,0);return render(options);};
  const result=await previewFilm({projectPath,edit,from:1,to:1.8},deps);
  assert.equal(result.status,'ready');assert.deepEqual(result.range.frameRange,[60,107]);
  assert.equal((await inspectCurrentPreview(projectPath) as any).current.id,result.id);
  assert.equal(await readFile(result.videoPath,'utf8'),'simulated renderer output');
  await assert.rejects(lstat(join(projectPath,'previews',result.id,'render/master.mov')),{code:'ENOENT'});
  const original=JSON.parse(await readFile(join(projectPath,'previews',result.id,'film-edit.json'),'utf8'));assert.deepEqual(original,edit,'the retained complete edit is not replaced by preview-selected narration');
});
test('preview gap context preserves unmeasured narration beginning outside the excerpt',async()=>{
  const {projectPath,edit}=await fixture(),deps=measuredNarrationDependencies([0.5]);
  edit.pictures=Array.from({length:5},(_,index)=>({...edit.pictures[0],id:`picture-${index}`}));
  edit.narration=[{id:'before',text:'Start here.',outputStartSeconds:0},{id:'later',text:'Continue here.',outputStartSeconds:5}];
  const result=await previewFilm({projectPath,edit,from:0,to:4},deps);
  assert.equal(result.status,'ready');
  const gap=result.editorialObservations.find((item:any)=>item.code==='NARRATION_GAP');
  assert.deepEqual([gap.outputStartSeconds,gap.outputEndSeconds],[0.5,5]);
  assert.equal(gap.speech.after.phraseId,'later');
  assert.equal(gap.speech.after.timingBasis,'unmeasured-narration');
  assert.equal(gap.speech.after.outputEndSeconds,null);
});
test('preview publication replaces only a successful current preview; failure remains inspectable',async()=>{
  const {projectPath,edit}=await fixture(),deps=simulatedDependencies();
  const first=await previewFilm({projectPath,edit,from:0,to:1},deps);
  const broken=simulatedDependencies();broken.renderWalkthrough=async()=>{throw new Error('synthetic renderer failure');};
  const failed=await previewFilm({projectPath,edit,from:0,to:1},broken);
  assert.equal(failed.status,'failed');assert.equal((await inspectCurrentPreview(projectPath) as any).current.id,first.id);
  assert.equal((await inspectCurrentPreview(projectPath,failed.id) as any).attempt.status,'failed');
  const next=await previewFilm({projectPath,edit,from:1,to:2},deps);
  assert.equal(next.publication.retirement,'retired');assert.equal((await inspectCurrentPreview(projectPath) as any).current.id,next.id);
  await assert.rejects(lstat(join(projectPath,'previews',first.id)),{code:'ENOENT'});
  assert.ok(await lstat(join(projectPath,'previews',failed.id,'preview.json')),'failure diagnostics survive replacement');
  assert.deepEqual(await import('node:fs/promises').then(fs=>fs.readdir(join(projectPath,'compositions'))),[],'previews are not composition attempts');
});
test('changed previous preview bytes are retained rather than deleted during replacement',async()=>{
  const {projectPath,edit}=await fixture(),deps=simulatedDependencies(),first=await previewFilm({projectPath,edit,from:0,to:1},deps);
  await writeFile(first.videoPath,'externally changed preview');
  const next=await previewFilm({projectPath,edit,from:1,to:2},deps);
  assert.equal(next.status,'ready');assert.equal(next.publication.retirement,'retained');assert.equal(await readFile(first.videoPath,'utf8'),'externally changed preview');
});
test('preview range rejects off-grid, empty, negative and out-of-film intervals before rendering',()=>{
  assert.deepEqual(previewFrameRange(1/60,2/60,2),[1,1]);
  for(const [from,to] of [[0.01,1],[1,1],[-1,1],[1,3],[NaN,1],[0,Infinity]])assert.throws(()=>previewFrameRange(from,to,2),/FILM_PREVIEW_RANGE/);
});
test('failed preview returns and later inspects bounded measured narration clearance without synthesis',async()=>{
  const {projectPath,edit}=await fixture(),durations=Array.from({length:25},()=>0.1),deps=measuredNarrationDependencies(durations);
  edit.narration=durations.map((_,index)=>({id:`phrase-${index}`,text:`Measured phrase ${index}.`,outputStartSeconds:index/60}));
  deps.renderWalkthrough=async()=>{assert.fail('overlapping measured speech must not render');};
  const result=await previewFilm({projectPath,edit,from:0,to:1},deps);
  assert.equal(result.status,'failed');assert.equal(result.stage,'narration-fit');assert.equal(result.error.code,'FILM_NARRATION_OVERLAP');
  assert.equal(result.narrationFit.status,'rejected');
  assert.equal(result.narrationFitDiagnostics.record.phrases.items.length,20);assert.equal(result.narrationFitDiagnostics.record.phrases.total,24);
  assert.equal(result.narrationFitDiagnostics.record.phrases.nextOffset,20);
  assert.equal(result.narrationFitDiagnostics.record.phrases.items[0].nextPhrase.requiredClearanceSeconds,5/60);
  const inspected=await inspectCurrentPreview(projectPath,result.id);
  assert.deepEqual(inspected.narrationFit,result.narrationFitDiagnostics);
  assert.equal(inspected.narrationFit?.diagnosticPath,result.narrationFit.diagnosticPath);
  assert.equal(JSON.parse(await readFile(result.narrationFit.diagnosticPath,'utf8')).phrases.length,25);
  assert.equal(JSON.stringify(inspected).includes('Measured phrase'),false,'inspection exposes fit, not speech text');
});
test('missing or changed preview video retains selected identity without offering playback',async()=>{
  const {projectPath,edit}=await fixture(),result=await previewFilm({projectPath,edit,from:0,to:1},simulatedDependencies());
  await writeFile(result.videoPath,'changed preview bytes');
  for(const id of [undefined,result.id]){
    const observed=await inspectCurrentPreview(projectPath,id) as any,selected=id?observed.attempt:observed.current;
    assert.equal(selected.id,result.id);assert.equal(selected.integrity,'changed');assert.equal(selected.videoPath,null);
  }
  await unlink(result.videoPath);
  for(const id of [undefined,result.id]){
    const observed=await inspectCurrentPreview(projectPath,id) as any,selected=id?observed.attempt:observed.current;
    assert.equal(selected.id,result.id);assert.equal(selected.status,'ready');assert.equal(selected.integrity,'missing');assert.equal(selected.videoPath,null);
  }
  await unlink(join(result.projectPath,'previews',result.id,'preview.json'));
  await assert.rejects(inspectCurrentPreview(projectPath),/FILM_PREVIEW_MANIFEST_MISSING/);
});
test('composition and preview retain specific finishing failures with their actual diagnostics',async()=>{
  const failures=[
    {cause:'render:audio_loudness_unmeasurable',code:'FILM_AUDIO_LOUDNESS_UNMEASURABLE',diagnostic:'finish-loudness-input.log'},
    {cause:'render:delivery_audio_loudness_nonconformant',code:'FILM_DELIVERY_AUDIO_LOUDNESS_NONCONFORMANT',diagnostic:'media-metrics.json'},
    {cause:'render:delivery_audio_timing_nonconformant',code:'FILM_DELIVERY_AUDIO_TIMING_NONCONFORMANT',diagnostic:'media-metrics.json'},
  ];
  for(const kind of ['composition','preview'] as const)for(const failure of failures){
    const {projectPath,edit}=await fixture(),deps=simulatedDependencies();
    deps.renderWalkthrough=async options=>{await mkdir(options.directory);await writeFile(join(options.directory,failure.diagnostic),'retained measurement evidence');throw new Error(failure.cause);};
    const result=kind==='composition'?await composeFilm({projectPath,edit},deps):await previewFilm({projectPath,edit,from:0,to:1/60},deps);
    assert.equal(result.status,'failed');assert.equal(result.error?.code,failure.code);assert.equal(result.error?.causeCode,failure.cause);assert.equal(result.error?.owner,'render');
    assert.ok(result.error?.diagnosticPath.endsWith(`/render/${failure.diagnostic}`));
    assert.equal(await readFile(result.error!.diagnosticPath!,'utf8'),'retained measurement evidence');
    assert.match(result.error!.recovery,/offline/);
    const retained=JSON.parse(await readFile(join(result.projectPath,kind==='preview'?'previews':'compositions',result.id,`${kind}.json`),'utf8'));
    assert.deepEqual(retained.error,result.error);
  }
});
test('unmeasurable delivery loudness points to the latest literal report and missing evidence stays a directory',async()=>{
  const {projectPath,edit}=await fixture();
  for(const logs of [[],['finish-loudness-input.log','finish.log','finish-loudness-delivery.log']]){
    const deps=simulatedDependencies();
    deps.renderWalkthrough=async options=>{await mkdir(options.directory);for(const log of logs)await writeFile(join(options.directory,log),'retained measurement');throw new Error('render:audio_loudness_unmeasurable');};
    const result=await composeFilm({projectPath,edit},deps);
    assert.equal(result.error?.code,'FILM_AUDIO_LOUDNESS_UNMEASURABLE');
    assert.equal(result.error?.diagnosticPath,join(result.projectPath,'compositions',result.id,'render',...(logs.length?['finish-loudness-delivery.log']:[])));
  }
});

test('compose, preview and inspection retain the actual failed child log and observed exit',async()=>{
  const privateOutput='private child diagnostic',privateArgument='private command argument';
  const failures=[
    {name:'source-0.log',script:`console.error(${JSON.stringify(privateOutput)});process.exit(23)`,timeout:10000,code:'FILM_RENDER_PROCESS_FAILED',causeCode:'render:local_process_failed',child:{exitCode:23,signal:null}},
    {name:'renderer.log',script:`console.error(${JSON.stringify(privateOutput)});process.kill(process.pid,'SIGTERM')`,timeout:10000,code:'FILM_RENDER_PROCESS_FAILED',causeCode:'render:local_process_failed',child:{exitCode:null,signal:'SIGTERM'}},
    {name:'finish.log',script:`process.on('SIGTERM',()=>process.exit(0));console.error(${JSON.stringify(privateOutput)});setInterval(()=>{},1000)`,timeout:1000,code:'FILM_RENDER_PROCESS_TIMEOUT',causeCode:'render:local_process_timeout',child:{exitCode:0,signal:null}},
  ];
  for(const kind of ['composition','preview'] as const)for(const failure of failures){
    const {projectPath,edit}=await fixture(),deps=simulatedDependencies();let diagnosticPath='';
    // The renderer is outside this test; the real subprocess, error projection,
    // persistence and public inspection are the seam under test.
    deps.renderWalkthrough=async options=>{
      await mkdir(options.directory);diagnosticPath=join(options.directory,failure.name);
      await executeLocal(process.execPath,['-e',failure.script,privateArgument],diagnosticPath,failure.timeout);
      assert.fail('the child must fail before any film is delivered');
    };
    const result=kind==='composition'?await composeFilm({projectPath,edit},deps):await previewFilm({projectPath,edit,from:0,to:1/60},deps);
    assert.equal(result.status,'failed');assert.equal(result.error?.code,failure.code);assert.equal(result.error?.causeCode,failure.causeCode);
    assert.equal(result.error?.diagnosticPath,diagnosticPath);assert.deepEqual(result.error?.child,failure.child);
    assert.equal(await readFile(diagnosticPath,'utf8'),`${privateOutput}\n`);
    const inspected=JSON.parse(execFileSync(process.execPath,[join(import.meta.dirname,'../bin/walkthrough.mjs'),'inspect','--project',projectPath,`--${kind}`,result.id],{encoding:'utf8'})).result;
    const manifest=kind==='composition'?inspected.manifest:inspected.attempt;
    assert.deepEqual(manifest.error,result.error);
    for(const publicRecord of [result,inspected]){
      assert.equal(JSON.stringify(publicRecord).includes(privateOutput),false);
      assert.equal(JSON.stringify(publicRecord).includes(privateArgument),false);
    }
  }
});

test('streaming refusal survives later browser cleanup with its exact numeric admission in compose, preview and inspection',async()=>{
  const memoryAdmission={kind:'walkthrough-render-memory-admission',schemaVersion:1,platform:'darwin',memorySource:'node:process.availableMemory',sampleValid:true,availableBytes:4_073_600_000,
    estimatedUsageBytes:2_073_600_000,minimumRemainingBytes:2_000_000_000,requiredAvailableBytesExclusive:4_073_600_000,width:1920,height:1080,hasEnoughMemory:false};
  for(const kind of ['composition','preview'] as const){
    const {projectPath,edit}=await fixture(),deps=simulatedDependencies();let diagnosticPath='';
    deps.renderWalkthrough=async options=>{
      await mkdir(options.directory);diagnosticPath=join(options.directory,'renderer.log');
      // The actual child fails with a secondary cleanup error after retaining
      // the primary refusal; no browser or encoder is needed for this seam.
      await executeLocal(process.execPath,['-e',`console.error(${JSON.stringify(JSON.stringify({...memoryAdmission,privateText:'excluded child text'}))});console.error('render:streaming_encoding_required');throw Error('Target.createTarget: Target closed');`],diagnosticPath);
      assert.fail('a refused encoder cannot deliver a movie');
    };
    const result=kind==='composition'?await composeFilm({projectPath,edit},deps):await previewFilm({projectPath,edit,from:0,to:1/60},deps);
    assert.equal(result.status,'failed');assert.equal(result.error?.code,'FILM_RENDER_STREAMING_ENCODING_REQUIRED');
    assert.equal(result.error?.causeCode,'render:streaming_encoding_required');assert.equal(result.error?.diagnosticPath,diagnosticPath);
    assert.deepEqual(result.error?.memoryAdmission,memoryAdmission);assert.deepEqual(result.error?.child,{exitCode:1,signal:null});
    assert.match(result.error!.recovery,/Reuse sealed sources and audio/);assert.doesNotMatch(result.error!.recovery,/OOM|crash/);
    const inspected=JSON.parse(execFileSync(process.execPath,[join(import.meta.dirname,'../bin/walkthrough.mjs'),'inspect','--project',projectPath,`--${kind}`,result.id],{encoding:'utf8'})).result;
    const manifest=kind==='composition'?inspected.manifest:inspected.attempt;
    assert.deepEqual(manifest.error,result.error);
    assert.equal(JSON.stringify(inspected).includes('excluded child text'),false);
    assert.equal(JSON.stringify(inspected).includes('Target.createTarget'),false);
  }
});

test('a retained marker in another child or interrupted attempt does not replace its actual outcome',async()=>{
  for(const failure of [
    {name:'source-0.log',cause:'render:local_process_failed',code:'FILM_RENDER_PROCESS_FAILED'},
    {name:'renderer.log',cause:'render:cancelled',code:'FILM_ABORTED'},
    {name:'renderer.log',cause:'render:local_process_timeout',code:'FILM_RENDER_PROCESS_TIMEOUT'},
  ] as const){
    const {projectPath,edit}=await fixture(),deps=simulatedDependencies();
    deps.renderWalkthrough=async options=>{
      await mkdir(options.directory);const log=join(options.directory,failure.name);
      await writeFile(log,'render:streaming_encoding_required\n');
      throw new LocalProcessFailure(failure.cause,log,{exitCode:null,signal:'SIGTERM'});
    };
    const result=await composeFilm({projectPath,edit},deps);
    assert.equal(result.error?.code,failure.code);assert.equal(result.error?.causeCode,failure.cause);assert.equal(result.error?.memoryAdmission,undefined);
  }
});

test('unknown and non-render failures do not invent child diagnostics',async()=>{
  for(const kind of ['composition','preview'] as const)for(const failure of [
    new Error('render:probe_failed'),
    Object.assign(new Error('private failure message'),{diagnosticPath:'/not-an-observed-log',child:{exitCode:99,signal:null}}),
    new Failure('FILM_SOURCE_CHANGED','sources','Restore the retained source bytes.'),
  ]){
    const {projectPath,edit}=await fixture(),deps=simulatedDependencies();
    deps.renderWalkthrough=async()=>{throw failure;};
    const result=kind==='composition'?await composeFilm({projectPath,edit},deps):await previewFilm({projectPath,edit,from:0,to:1/60},deps);
    assert.equal(result.status,'failed');
    assert.equal(result.error?.code,failure instanceof Failure?failure.code:kind==='composition'?'FILM_COMPOSITION_FAILED':'FILM_PREVIEW_FAILED');
    assert.equal(result.error?.diagnosticPath,undefined);assert.equal(result.error?.child,undefined);assert.equal(result.error?.causeCode,undefined);
    assert.equal(JSON.stringify(result).includes('private failure message'),false);
  }
});
