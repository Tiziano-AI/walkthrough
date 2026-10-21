import {readFile,lstat,realpath,stat} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {commandHelp} from './command-help.ts';
import {Failure} from './core/contracts.ts';
import {fileDigest} from './core/files.ts';
import {validArtifactFilename,validMediaType} from './core/deliverables.ts';
import {runtimePaths} from './core/runtime-paths.ts';
import {checkedId,createProject,readProject,projectDirectory,inspectProject,loadSourceSet,newId} from './project/store.ts';
import {inspectSourceSet,pageItems,takeSummary,captureSummary} from './project/inspection.ts';

const controller=new AbortController();
const cancel=()=>controller.abort(new Failure('COMMAND_CANCELLED','runtime','Inspect the original occurrence before continuing. No input was automatically replayed.'));
process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
const invalid=(message='Use walkthrough help for commands and walkthrough help <topic> for input shapes.')=>new Failure('INVALID_COMMAND','input',message);
const raw=process.argv.slice(2),positionals:string[]=[],flags=new Map<string,string|true>();
const emit=(record:Record<string,unknown>)=>{console.log(JSON.stringify({schemaVersion:1,...record}));if(['failed','not-ready'].includes(String(record.status)))process.exitCode=1;};
const need=(name:string)=>{const v=flags.get(name);if(typeof v!=='string'||!v)throw invalid('Supply --'+name+'. See walkthrough help.');return v;};
const optional=(name:string)=>flags.has(name)?need(name):undefined;
const accept=(...names:string[])=>{for(const n of flags.keys())if(!['json',...names].includes(n))throw invalid('--'+n+' is not valid for this command.');};
const integer=(name:string,max:number,def:number)=>{if(!flags.has(name))return def;const v=need(name);if(!/^\d+$/.test(v)||Number(v)<1||Number(v)>max)throw invalid('--'+name+' must be 1..'+max);return Number(v);};
const offset=()=>{if(!flags.has('offset'))return 0;const v=need('offset');if(!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v)))throw invalid('--offset must be a nonnegative safe integer.');return Number(v);};
const jsonFile=async(path:string)=>{const info=await stat(path);if(!info.isFile()||info.size>16*1024*1024)throw invalid('Use a JSON file no larger than 16 MiB.');return JSON.parse(await readFile(path,'utf8'));};
const input=async(required=true)=>{if(flags.has('input')&&flags.has('data'))throw invalid('Choose --input or --data.');if(flags.has('data'))return JSON.parse(need('data'));if(flags.has('input'))return jsonFile(resolve(need('input')));if(required)throw invalid('Supply --input <JSON-file> or --data <JSON>.');return {};};
const project=async()=>{const path=await projectDirectory(need('project'));return {path,record:await readProject(path)};};
async function ownedPath(root:string,...parts:string[]){const path=join(root,...parts);if(await realpath(path)!==path)throw new Failure('PROJECT_PATH_REDIRECT','project','Restore project-owned child paths; redirected files and directories are not accepted.');return path;}
const sessionDirectory=(path:string)=>ownedPath(path,'sessions',checkedId(need('session')));
function admitReview(review:string){if(review==='private-local')throw new Failure('MEDIA_REVIEW_NOT_AUTHORIZED','authority','This project is private-local. Retain its content locally for its authorized reviewer.');}
const scope=(p:{path:string;record:{id:string}})=>({projectId:p.record.id,projectPath:p.path});
const result=(value:unknown,nextStep:string,identity:Record<string,unknown>={})=>emit({status:'ok',...identity,result:value,nextStep});
async function download(directory:string,id:string){
  const {listSessionArtifacts}=await import('./session/index.ts'),entries=await listSessionArtifacts(directory);
  const entry=entries.find(e=>e.artifactId===id);
  if(!entry||typeof entry.path!=='string'||typeof entry.sha256!=='string'||typeof entry.bytes!=='number'||!validArtifactFilename(entry.filename)||!validMediaType(entry.mediaType))throw new Failure('ARTIFACT_NOT_AVAILABLE','artifact','List this session’s completed retained downloads.');
  const path=await realpath(entry.path),info=await lstat(entry.path);
  if(path!==entry.path||!path.startsWith(directory+sep)||!info.isFile()||info.isSymbolicLink()||info.size!==entry.bytes||await fileDigest(path)!==entry.sha256)throw new Failure('ARTIFACT_CHANGED','artifact','Restore the exact retained download. No replacement is fetched or generated.');
  return {artifactId:id,path,sha256:entry.sha256,bytes:entry.bytes,filename:entry.filename,mediaType:entry.mediaType};
}
try{
  for(let i=0;i<raw.length;i++){
    const arg=raw[i]!;
    if(arg==='--version'){positionals.push('--version');continue;}
    if(arg==='--help'||arg==='-h'){positionals.push('help');continue;}
    if(!arg.startsWith('--')){positionals.push(arg);continue;}
    const key=arg.slice(2);if(flags.has(key))throw invalid('Duplicate --'+key);
    if(['json','headed'].includes(key)){flags.set(key,true);continue;}
    if(key==='preview'){if(raw[i+1]&&!raw[i+1].startsWith('--'))flags.set(key,raw[++i]);else flags.set(key,true);continue;}
    const value=raw[++i];if(!value||value.startsWith('--'))throw invalid('--'+key+' requires a value.');flags.set(key,value);
  }
  const [command,subcommand,...extra]=positionals;
  if(extra.length&&!(command==='audio'&&subcommand==='attempt'&&extra.length===1))throw invalid();
  if(command==='help'||!command){accept();emit(commandHelp(subcommand));}
  else if(command==='--version'&&!subcommand){
    accept();const paths=runtimePaths(),pkg=await jsonFile(join(paths.runtimeRoot,'package.json'));
    let release:any=null;try{release=await jsonFile(join(paths.runtimeRoot,'release.json'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    result({name:pkg.name,version:pkg.version,node:process.version,platform:process.platform,architecture:process.arch,runtimeRoot:paths.runtimeRoot,kind:release?'installed-release':'development-source',releaseSha256:release?await fileDigest(join(paths.runtimeRoot,'release.json')):null,source:release?.source??null},'Use help for this runtime’s public command contract.');
  }else if(command==='doctor'&&!subcommand){
    accept('phase');const phase=optional('phase');if(phase&&!['capture','compose','all'].includes(phase))throw invalid('Choose capture, compose or all.');
    const {inspectPrerequisites}=await import('./core/preflight.ts');emit(await inspectPrerequisites({phase:phase as 'capture'|'compose'|'all'|undefined,signal:controller.signal}));
  }else if(command==='project'&&subcommand==='create'){
    accept('path','brief');const created=await createProject(resolve(need('path')),await jsonFile(resolve(need('brief'))));
    result(created,'Open a session, then observe before choosing an action.',{projectId:created.project.id,projectPath:created.directory});
  }else if(command==='project'&&subcommand==='inspect'||command==='inspect'&&!subcommand&&!['source-set','composition','take','preview'].some(f=>flags.has(f))){
    accept('project','limit','offset');const p=await project();admitReview(p.record.mandate.mediaReview);
    result(await inspectProject(p.path,integer('limit',100,20),offset()),'Inspect a retained source set, take, composition, preview or session by identity. Pass nextOffset as --offset to read the remaining identities.',scope(p));
  }else if(command==='project'&&subcommand==='compact'){
    accept('project','composition','preview');
    if(flags.has('composition')===flags.has('preview'))throw invalid('Choose exactly one target: --composition <composition-id> or --preview <failed-preview-id>.');
    const p=await project(),{compactFilmComposition,compactFilmPreview}=await import('./core/film-storage.ts');
    const storage=flags.has('preview')?await compactFilmPreview({projectPath:p.path,previewId:need('preview')}):await compactFilmComposition({projectPath:p.path,compositionId:need('composition')});
    emit({status:storage.error?'failed':'ok',...scope(p),result:storage,...(storage.error?{error:storage.error}:{}),nextStep:storage.error?storage.error.recovery:'Sealed sources, edit, audio, diagnostics and any delivered film remain. Failed occurrences also retain encoded output when present. Removed logical bytes do not measure physical space reclaimed.'});
  }else if(command==='setup'&&['inspect','prepare','apply'].includes(subcommand??'')){
    const api=await import('./core/setup.ts');
    if(subcommand==='inspect'){accept();emit(await api.setupInspect({signal:controller.signal}));}
    else if(subcommand==='prepare'){
      accept('candidate','input','data');const request=await input();
      emit(await api.setupPrepare({...request,candidatePath:resolve(need('candidate')),signal:controller.signal}));
    }else{
      accept('candidate','sha256');emit(await api.setupApply({candidatePath:resolve(need('candidate')),candidateSha256:need('sha256'),signal:controller.signal}));
    }
  }else if(command==='audio'&&subcommand==='attempt'){
    const operation=extra[0];if(!['inspect','resolve'].includes(operation??''))throw invalid('Use audio attempt inspect or audio attempt resolve; see help audio.');
    accept('attempt',...(operation==='resolve'?['resolution','note']:[]));
    const api=await import('./audio/attempts.ts'),attemptPath=resolve(need('attempt'));
    if(operation==='inspect')result(await api.inspectAudioAttempt({attemptPath}),'Inspect retained process custody and stage outputs before resolving this exact attempt. No synthesis or retry was performed.');
    else{
      const resolution=need('resolution');if(resolution!=='adopt'&&resolution!=='retry')throw invalid('--resolution must be adopt or retry.');
      result(await api.resolveAudioAttempt({attemptPath,resolution,note:need('note')}),'The original attempt and diagnostics remain. A later compose may reuse adopted output or retry only the explicitly released stage.');
    }
  }else if(command==='session'&&subcommand==='open'){
    accept('project','id','headed','profile');const p=await project(),{localTools}=await import('./core/preflight.ts'),{openSession}=await import('./session/index.ts');
    const id=checkedId(optional('id')??newId('session'));await ownedPath(p.path,'sessions');const directory=join(p.path,'sessions',id);
    const profile=optional('profile')?resolve(need('profile')):undefined;
    if(profile&&(profile===p.path||profile.startsWith(p.path+sep)))throw invalid('Profiles must remain outside the film project.');
    const session=await openSession({directory,projectId:p.record.id,projectPath:p.path,startUrl:p.record.mandate.applicationUrl,allowedOrigins:p.record.mandate.navigationOrigins,uploadRoots:p.record.mandate.inputRoots,network:p.record.mandate.network,mediaReview:p.record.mandate.mediaReview,profileDirectory:profile,tools:localTools,headless:!flags.has('headed')});
    result(session,'Observe this session for current control and surface references.',{...scope(p),sessionId:id});
  }else if(command==='session'&&['inspect','handoff','resume','close'].includes(subcommand??'')){
    accept('project','session',...(['handoff','resume'].includes(subcommand!)?['id']:[]));const p=await project(),directory=await sessionDirectory(p.path),api=await import('./session/index.ts');
    if(subcommand==='inspect'){
      const inspected=await api.inspectSession(directory);
      const nextStep=inspected.live?'Observe the page or inspect an original action. Liveness is separate from recorded state.'
        :inspected.session.status==='closed'&&inspected.worker==='stopped'?'The session is closed. Inspect retained takes, source sets or original actions.'
        :inspected.recovery??'Inspect this original session and its worker log before continuing; worker shutdown is not established.';
      result(inspected,nextStep,scope(p));
    }
    else if(subcommand==='close')result(await api.closeSession(directory),'The session stopped; retained takes and actions remain available.',scope(p));
    else result(await api.dispatchSession(directory,{actionId:need('id'),action:{kind:subcommand==='handoff'?'auth-begin':'auth-resume'}}),subcommand==='handoff'?'Authentication is off camera. Complete it in the browser, then resume.':'Observe the intended state before starting a new take.',scope(p));
  }else if(command==='observe'&&!subcommand){
    accept('project','session','page','limit','observation','offset','ref');if(flags.has('ref')&&!flags.has('observation'))throw invalid('--ref requires --observation <observationId> from the retained snapshot.');const p=await project();admitReview(p.record.mandate.mediaReview);const {observeSession}=await import('./session/index.ts');
    result(await observeSession(await sessionDirectory(p.path),{pageId:optional('page'),limit:integer('limit',1000,100),observationId:optional('observation'),ref:optional('ref'),offset:offset(),screenshot:true}),'Use current refs or screenshot coordinates for one deliberate action, then observe its response. Page refs with --observation <observationId> --offset <nextOffset>; page a select’s options with --ref <select-ref> --offset <optionsNextOffset>. Both read the same retained snapshot, not current application state.',scope(p));
  }else if(command==='act'&&!subcommand){
    accept('project','session','id','input','data');const p=await project();admitReview(p.record.mandate.mediaReview);const {dispatchSession}=await import('./session/index.ts'),actionId=need('id');
    result(await dispatchSession(await sessionDirectory(p.path),{actionId,action:await input()}),'Observe the response. input-completed is input delivery, not application success.',{...scope(p),actionId});
  }else if(command==='action'&&['inspect','resolve'].includes(subcommand??'')){
    accept('project','session','id',...(subcommand==='resolve'?['input','data']:[]));const p=await project();admitReview(p.record.mandate.mediaReview);const api=await import('./session/index.ts'),directory=await sessionDirectory(p.path),id=need('id');
    result(subcommand==='inspect'?await api.inspectAction(directory,id):await api.resolveAction(directory,id,await input()),'Reconcile observed state; never replace an uncertain action identity to retry input.',{...scope(p),actionId:id});
  }else if(command==='capture'&&['start','mark','stop'].includes(subcommand??'')){
    accept('project','session','id','input','data');const p=await project();admitReview(p.record.mandate.mediaReview);const {captureSession}=await import('./session/index.ts'),operationId=need('id');
    const captured=await captureSession(await sessionDirectory(p.path),{operationId,kind:subcommand as 'start'|'mark'|'stop',request:await input(false)}) as {status?:string;error?:unknown};
    const nextStep=captured.status==='completed'?(subcommand==='stop'?'Seal completed takes, preserving actual observed states.':'Recording continues between calls. Act and mark useful observed moments.'):'Inspect this original operation and session before continuing. Its outcome is unresolved; no input or recording was automatically repeated.';
    emit({status:captured.status==='completed'?'ok':'attention-required',...scope(p),operationId,result:captureSummary(captured),nextStep});
  }else if(command==='capture'&&subcommand==='recover'){
    accept('project','take');const p=await project();admitReview(p.record.mandate.mediaReview);
    const {recoverTake}=await import('./project/capture.ts'),{localTools}=await import('./core/preflight.ts');
    const take=await recoverTake({projectPath:p.path,takeId:need('take'),tools:localTools,signal:controller.signal});
    result(takeSummary(take),'Seal this same recovered take. Original capture operations and failed-state evidence remain retained; no browser was opened or input repeated.',{...scope(p),takeId:take.id});
  }else if(command==='capture'&&subcommand==='seal'){
    accept('project','input','data');const p=await project(),selection=await input();
    if(!selection||!Array.isArray(selection.takeIds)||!selection.takeIds.length||!Array.isArray(selection.artifacts??[]))throw invalid('Supply takeIds and optional artifacts. See help capture.');
    const artifacts=[];
    for(const item of selection.artifacts??[]){
      if(!item||typeof item.title!=='string'||!item.title.trim()||!['deliverable','source'].includes(item.role))throw invalid('Selected downloads need sessionId, artifactId, title and role.');
      const directory=await ownedPath(p.path,'sessions',checkedId(item.sessionId)),retained=await download(directory,checkedId(item.artifactId));
      artifacts.push({path:retained.path,id:item.artifactId,title:item.title,filename:retained.filename,mediaType:retained.mediaType,role:item.role});
    }
    const {sealTakes}=await import('./project/capture.ts');const sealed=await sealTakes({projectPath:p.path,takeIds:selection.takeIds,artifactPaths:artifacts});
    result({sourceSetId:sealed.sourceSet.id,sha256:sealed.sha256,path:sealed.path,directory:sealed.directory,sources:sealed.sourceSet.sources.length,marks:sealed.sourceSet.marks.length,artifacts:sealed.sourceSet.artifacts.length},'Inspect the source set and compose pictures/narration from actual sources.',scope(p));
  }else if(command==='artifact'&&['list','inspect'].includes(subcommand??'')){
    accept('project','session','source-set','id',...(subcommand==='list'?['limit','offset']:[]));const p=await project();admitReview(p.record.mandate.mediaReview);
    if(flags.has('session')&&flags.has('source-set'))throw invalid('Choose a session or source set.');
    let entries:unknown[];
    if(flags.has('session')){const directory=await sessionDirectory(p.path);if(subcommand==='inspect')entries=[await download(directory,checkedId(need('id')))];else{const {listSessionArtifacts}=await import('./session/index.ts');entries=await listSessionArtifacts(directory);}}
    else if(flags.has('source-set')){const retained=await loadSourceSet(p.path,need('source-set'));admitReview(retained.sourceSet.mediaReview);entries=retained.sourceSet.artifacts.filter(a=>subcommand==='list'||a.id===need('id')).map(a=>({...a,path:retained.artifactPaths[a.id]}));}
    else{if(subcommand==='inspect')throw invalid('Select --session or --source-set.');const {listProjectArtifacts}=await import('./project/capture.ts');entries=await listProjectArtifacts(p.path);}
    const limit=integer('limit',100,20);if(subcommand==='inspect'&&!entries.length)throw new Failure('ARTIFACT_NOT_FOUND','artifact','List the owner’s artifacts and choose its exact identity.');
    result(pageItems(entries,limit,offset()),'Reimport or deliver the actual retained bytes, not regenerated equivalents. Pass nextOffset as --offset for remaining entries.',scope(p));
  }else if(['validate','compose','preview'].includes(command)&&!subcommand){
    accept('project','edit',...(command==='validate'?[]:['reuse-audio']),...(command==='preview'?['from','to']:[]));const p=await project(),edit=await jsonFile(resolve(need('edit'))),film=await import('./core/film.ts');
    if(command==='validate')result(await film.validateFilm({projectPath:p.path,edit}),'Compose when the edit is ready. Validation opened no app and synthesized no audio.',scope(p));
    else if(command==='preview')emit({...await film.previewFilm({projectPath:p.path,edit,from:Number(need('from')),to:Number(need('to')),reuseAudio:optional('reuse-audio'),signal:controller.signal}),...scope(p)});
    else emit({...await film.composeFilm({projectPath:p.path,edit,reuseAudio:optional('reuse-audio'),signal:controller.signal}),...scope(p)});
  }else if(command==='inspect'&&!subcommand&&flags.has('preview')){
    accept('project','preview');const p=await project();admitReview(p.record.mandate.mediaReview);const {inspectCurrentPreview}=await import('./core/film-preview-storage.ts');
    result(await inspectCurrentPreview(p.path,typeof flags.get('preview')==='string'?need('preview'):undefined),'View the current successful preview or inspect this exact attempt. A failed replacement does not remove the current preview; full-film acceptance remains separate.',scope(p));
  }else if(command==='inspect'&&!subcommand){
    accept('project','source-set','composition','take',...(flags.has('source-set')?['section','source','limit','offset']:flags.has('composition')?['section','limit','offset']:[]));const p=await project();admitReview(p.record.mandate.mediaReview);const kinds=['source-set','composition','take'].filter(key=>flags.has(key));if(kinds.length!==1)throw invalid('Choose exactly one source set, composition or take.');
    if(kinds[0]==='source-set'){const retained=await loadSourceSet(p.path,need('source-set'));admitReview(retained.sourceSet.mediaReview);result(inspectSourceSet(retained,{section:optional('section'),sourceId:optional('source'),limit:integer('limit',1000,20),offset:offset()}),'Choose real intervals using usableRange and marks. Read a section with --section sources|marks|artifacts|records|pointer and its nextOffset with --offset. Pointer samples require --source <id>. Integrity is not viewing acceptance.',scope(p));}
    else if(kinds[0]==='take')result(takeSummary(await jsonFile(await ownedPath(p.path,'takes',checkedId(need('take')),'take.json'))),'Stopped takes can be sealed. In-flight recording is not a completed source. The take.json file retains the complete event and mark references.',scope(p));
    else{
      const section=optional('section');if(section&&!['narration-fit','editorial'].includes(section))throw invalid('Use --section narration-fit or editorial for retained diagnostics.');
      if(!section&&(flags.has('limit')||flags.has('offset')))throw invalid('--limit and --offset require --section narration-fit or editorial for a composition.');
      const directory=await ownedPath(p.path,'compositions',checkedId(need('composition'))),manifest=await jsonFile(await ownedPath(directory,'composition.json')),{observeBundle}=await import('./core/bundle.ts');
      const {inspectNarrationFit,inspectFilmEditorial}=await import('./core/film.ts');
      if(section==='editorial'){
        result(await inspectFilmEditorial(directory,manifest,{limit:integer('limit',1000,20),offset:offset()}),'Inspect each observation using its preview range and context; pass editorialObservations.nextOffset as --offset for the remaining prompts. Objective errors block delivery, not editorial observations.',scope(p));
      }else if(section){
        result(await inspectNarrationFit(directory,{limit:integer('limit',1000,20),offset:offset()}),'Read each phrase’s measured placement and clearance. Adjust text or edit timing explicitly, then compose from the same sealed sources; unchanged speech reuses cached audio. Pass phrases.nextOffset as --offset for remaining measures.',scope(p));
      }else{
      const {inspectRenderProgress}=await import('./render/progress.ts');
      const renderProgress=await inspectRenderProgress(directory,manifest);
      const {inspectAudioFailure}=await import('./audio/failure.ts');
      const audioFailure=await inspectAudioFailure(directory);
      const bundle=await observeBundle(directory,manifest.status);
      const nextStep=bundle.reviewPath?'Watch and listen to the available film at normal speed. Integrity does not establish acceptance.'
        :manifest.status==='running'?'Follow the original occurrence before starting another composition. Recorded state alone does not establish liveness.'
        :manifest.status==='failed'?'Inspect the retained error and repair its cause using the sealed sources; do not reopen the application for an editorial repair.'
        :'The delivery is incomplete or changed. Inspect its file observations and restore exact files or recompose from the sealed sources without reopening the application.';
      const narrationFit=await inspectNarrationFit(directory,{conflictsOnly:manifest.status==='failed'});
      const editorial=await inspectFilmEditorial(directory,manifest);
      result({manifest,statusBasis:'recorded-manifest',renderProgress,audioFailure,narrationFit,editorial,bundle},nextStep,scope(p));
      }
    }
  }else throw invalid();
}catch(error){
  const e=error as {code?:string;message?:string};
  const {FilmCaptionFailure,FilmEditFailure}=await import('./core/film-edit.ts');
  const diagnostic=error instanceof Failure?{code:error.code,owner:error.owner,recovery:error.recovery,...(error instanceof FilmCaptionFailure?{caption:error.caption}:{}),...(error instanceof FilmEditFailure?{location:error.location}:{})}:{code:typeof e.code==='string'?e.code:'CLI_INPUT_OR_RUNTIME_FAILED',owner:'runtime',recovery:e.message??'Inspect original state and local inputs; no automatic replay occurred.'};
  emit({status:'failed',...(flags.has('project')?{projectPath:flags.get('project')}:{}),...(flags.has('session')?{sessionId:flags.get('session')}:{}),...(flags.has('id')?{attemptId:flags.get('id')}:{}),error:diagnostic,...(positionals[0]==='validate'?{objectiveErrors:[diagnostic],editorialObservations:[]}:{})});
}
