import {randomUUID} from 'node:crypto';
import {mkdir,readFile,open,rename,realpath,lstat,readdir,copyFile,chmod,stat} from 'node:fs/promises';
import {constants,type Dirent} from 'node:fs';
import {resolve,join,isAbsolute,sep} from 'node:path';
import {Failure} from '../core/contracts.ts';
import {fileDigest,sha256} from '../core/files.ts';
import type {FilmProject,ProjectBrief,SourceSet,RetainedFile} from './contracts.ts';

export const newId=(prefix:string)=>`${prefix}-${randomUUID()}`;
export function checkedId(id:unknown):string{if(typeof id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)||id==='.'||id==='..')throw new Failure('INVALID_ID','project','Use an identity returned by this project.');return id;}
export async function saveJson(path:string,value:unknown,exclusive=false){
  const bytes=JSON.stringify(value,null,2)+'\n';
  if(exclusive){const f=await open(path,'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}
  else {const temp=`${path}.${randomUUID()}.tmp`;const f=await open(temp,'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}await rename(temp,path);}
  const dir=await open(resolve(path,'..'),'r');try{await dir.sync();}finally{await dir.close();}
}
export function validateBrief(value:unknown):ProjectBrief{
  const b=value as ProjectBrief,m=b?.mandate;
  const text=(s:unknown):s is string=>typeof s==='string'&&!!s.trim();
  if(!b||![b.title,b.brief,b.audience].every(text)||!m||![m.allowedEffects,m.dataDescription].every(text)||!['web','loopback-only'].includes(m.network)||!['private-local','agent-reviewable','agent-reviewable-synthetic'].includes(m.mediaReview)||m.delivery!=='local'||!Array.isArray(m.navigationOrigins)||!m.navigationOrigins.length||!Array.isArray(m.inputRoots)||m.inputRoots.some(p=>typeof p!=='string'||!isAbsolute(p)))throw new Failure('INVALID_PROJECT_BRIEF','authoring','Provide title, brief, audience and the application/data/effect/file/review/delivery mandate. See walkthrough help project.');
  const url=(raw:string)=>{try{const u=new URL(raw);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw 0;return u;}catch{throw new Failure('INVALID_APPLICATION_URL','project','Use an HTTP(S) URL without credentials.');}};
  const start=url(m.applicationUrl);
  if(m.navigationOrigins.some(o=>url(o).origin!==o)||!m.navigationOrigins.includes(start.origin))throw new Failure('INVALID_NAVIGATION_ORIGINS','project','Declare exact HTTP(S) navigation origins including the application URL origin. These are not subresource/API allowlists.');
  if(m.network==='loopback-only'&&m.navigationOrigins.some(o=>!['localhost','127.0.0.1','[::1]'].includes(url(o).hostname)))throw new Failure('LOOPBACK_MANDATE_REQUIRED','project','Loopback projects can navigate only loopback origins.');
  return structuredClone(b);
}
export async function projectDirectory(path:string){
  const full=resolve(path),actual=await realpath(full);
  if(!(await lstat(actual)).isDirectory())throw new Failure('PROJECT_PATH_NOT_DIRECTORY','project','Use the explicit project directory.');return actual;
}
/** Canonicalize the admitted root, then check each child before creating the next.
 * Recursive mkdir must not follow a redirected parent before we inspect it. */
export async function ownedDirectory(root:string,...parts:string[]){
  let directory=await projectDirectory(root);
  for(const part of parts){
    checkedId(part);directory=join(directory,part);
    try{await mkdir(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory)throw new Failure('RETAINED_DIRECTORY_REDIRECT','sources','Restore the project-owned directory; redirected child paths are not accepted.');
  }
  return directory;
}
export async function createProject(path:string,brief:ProjectBrief){
  brief=validateBrief(brief);await mkdir(resolve(path),{recursive:true,mode:0o700});const directory=await projectDirectory(path);
  try{await lstat(join(directory,'project.json'));throw Object.assign(new Error('Project already exists.'),{code:'EEXIST'});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const project:FilmProject={...brief,schemaVersion:1,kind:'walkthrough-project',id:newId('project'),createdAt:new Date().toISOString()};
  for(const name of ['sessions','takes','sources','edits','compositions'])await ownedDirectory(directory,name);
  await saveJson(join(directory,'project.json'),project,true);
  return {project,directory};
}
export async function readProject(path:string):Promise<FilmProject>{
  const directory=await projectDirectory(path);const file=join(directory,'project.json');
  if((await lstat(file)).isSymbolicLink())throw new Failure('PROJECT_MANIFEST_SYMLINK','project','Restore the project-owned manifest.');
  const p=JSON.parse(await readFile(file,'utf8')) as FilmProject;validateBrief(p);
  if(p.schemaVersion!==1||p.kind!=='walkthrough-project'||!p.createdAt)throw new Failure('INVALID_PROJECT','project','Use a supported Walkthrough project.');checkedId(p.id);return p;
}
export async function retainedPath(directory:string,ref:RetainedFile){
  directory=await realpath(directory);
  const bad=()=>new Failure('RETAINED_FILE_INVALID','sources','Restore the exact retained regular file; paths must remain inside their source set.');
  if(!ref||typeof ref.relativePath!=='string'||isAbsolute(ref.relativePath)||ref.relativePath.includes('\\')||ref.relativePath.split('/').some(p=>!p||p==='.'||p==='..')||!/^[a-f0-9]{64}$/.test(ref.sha256)||!Number.isSafeInteger(ref.bytes)||ref.bytes<0)throw bad();
  const full=join(directory,ref.relativePath),actual=await realpath(full);
  if(actual!==full||!actual.startsWith(resolve(directory)+sep))throw bad();const s=await lstat(full);
  if(!s.isFile()||s.isSymbolicLink()||s.size!==ref.bytes||await fileDigest(full)!==ref.sha256)throw new Failure('RETAINED_FILE_CHANGED','sources','Restore the file matching its retained size and hash. No application call or replacement is made.');return full;
}
export async function retainFile(source:string,directory:string,relativePath:string):Promise<RetainedFile>{
  if(isAbsolute(relativePath)||relativePath.includes('\\')||relativePath.split('/').some(p=>!p||p==='.'||p==='..'))throw new Failure('INVALID_RETAINED_DESTINATION','sources','Use a relative path inside the new source set.');
  if(!(await lstat(source)).isFile()||(await lstat(source)).isSymbolicLink())throw new Failure('SOURCE_FILE_NOT_LITERAL','sources','Retain a regular file, not a symlink.');
  source=await realpath(source);directory=await realpath(directory);
  const hash=await fileDigest(source),target=join(directory,relativePath);
  await ownedDirectory(directory,...relativePath.split('/').slice(0,-1));
  await copyFile(source,target,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);await chmod(target,0o600);const bytes=(await stat(target)).size;
  if(await fileDigest(target)!==hash||await fileDigest(source)!==hash)throw new Failure('SOURCE_CHANGED_DURING_RETENTION','sources','Keep the failed occurrence and restore the original bytes before another retention attempt.');
  return {relativePath,sha256:hash,bytes};
}
export function validateSourceSet(value:unknown):SourceSet{
  const s=value as SourceSet;const bad=()=>new Failure('INVALID_SOURCE_SET','sources','Use a sealed source set with verified media, clocks, marks and artifacts.');
  if(!s||s.schemaVersion!==1||s.kind!=='source-set'||s.state!=='sealed'||!s.createdAt||!['private-local','agent-reviewable','agent-reviewable-synthetic'].includes(s.mediaReview)||!Array.isArray(s.sources)||!s.sources.length||!Array.isArray(s.marks)||!Array.isArray(s.artifacts))throw bad();checkedId(s.id);checkedId(s.projectId);
  const ids=new Set<string>();
  for(const source of s.sources){checkedId(source.id);if(ids.has(source.id))throw bad();ids.add(source.id);
    if(source.width!==3200||source.height!==1800||!Number.isFinite(source.durationSeconds)||source.durationSeconds<=0||!Number.isSafeInteger(source.frameCount)||source.frameCount<1||!source.clock||![source.clock.offsetSeconds,source.clock.uncertaintySeconds,source.clock.driftSeconds].every(Number.isFinite)||source.clock.uncertaintySeconds<0||source.clock.driftSeconds<0||!source.usableRange||![source.usableRange.startSeconds,source.usableRange.endSeconds].every(Number.isFinite)||source.usableRange.startSeconds<0||source.usableRange.endSeconds>source.durationSeconds||source.usableRange.endSeconds<=source.usableRange.startSeconds||!Array.isArray(source.pointer))throw bad();
    let last=-Infinity;for(const p of source.pointer){if(![p.timeSeconds,p.x,p.y].every(Number.isFinite)||p.timeSeconds<0||p.timeSeconds>source.durationSeconds||p.timeSeconds<last||!['move','down','up'].includes(p.type)||(p.gesture!==undefined&&p.gesture!=='drag')||p.x<0||p.y<0||p.x>source.width||p.y>source.height)throw bad();last=p.timeSeconds;}
  }
  const markIds=new Set<string>();for(const m of s.marks){checkedId(m.id);const identity=JSON.stringify([m.sourceId,m.id]),source=s.sources.find(source=>source.id===m.sourceId);if(markIds.has(identity)||!source||typeof m.title!=='string'||!m.title.trim()||!Number.isFinite(m.timeSeconds)||m.timeSeconds<0||m.timeSeconds>source.durationSeconds)throw bad();markIds.add(identity);
    if(m.target!==null&&(!m.target||![m.target.x,m.target.y,m.target.width,m.target.height].every(Number.isFinite)||m.target.x<0||m.target.y<0||m.target.width<=0||m.target.height<=0||m.target.x+m.target.width>source.width||m.target.y+m.target.height>source.height))throw bad();
    if(m.targetObservation!==undefined){
      const observed=m.targetObservation;if(!observed||typeof observed!=='object'||Array.isArray(observed))throw bad();
      const viewport=observed.viewport,box=observed.box,pixels=observed.screenshotPixels;
      for(const id of [observed.observationId,observed.pageId,observed.frameId,observed.documentId,observed.markId])checkedId(id);
      if(!m.target||typeof observed.observedAt!=='string'||!Number.isFinite(Date.parse(observed.observedAt))||!viewport||viewport.width!==1600||viewport.height!==900||!['css','screenshot'].includes(observed.coordinateSpace)||!box||![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.x<0||box.y<0||box.width<=0||box.height<=0)throw bad();
      if(observed.coordinateSpace==='css'){checkedId(observed.ref);if(pixels!==undefined)throw bad();}
      else if(observed.ref!==undefined||!pixels||!Number.isSafeInteger(pixels.width)||!Number.isSafeInteger(pixels.height)||pixels.width<=0||pixels.height<=0)throw bad();
      const width=observed.coordinateSpace==='css'?viewport.width:pixels!.width,height=observed.coordinateSpace==='css'?viewport.height:pixels!.height;
      if(box.x+box.width>width||box.y+box.height>height)throw bad();
      const expected={x:box.x*source.width/width,y:box.y*source.height/height,width:box.width*source.width/width,height:box.height*source.height/height};
      if((['x','y','width','height'] as const).some(key=>Math.abs(m.target![key]-expected[key])>1e-7))throw bad();
    }
    if(m.settled&&(m.settled.method!=='observed-stability'||!Number.isFinite(m.settled.startSeconds)||!Number.isFinite(m.settled.endSeconds)||m.settled.startSeconds<source.usableRange.startSeconds||m.settled.endSeconds>source.usableRange.endSeconds||m.settled.endSeconds<m.settled.startSeconds))throw bad();}
  const artifactIds=new Set<string>();for(const a of s.artifacts){checkedId(a.id);if(artifactIds.has(a.id)||!a.title||!a.filename||!a.mediaType||!['deliverable','source'].includes(a.role))throw bad();artifactIds.add(a.id);}
  return s;
}
export async function saveSourceSet(projectPath:string,sourceSet:SourceSet){
  validateSourceSet(sourceSet);const project=await readProject(projectPath);
  if(sourceSet.projectId!==project.id)throw new Failure('SOURCE_PROJECT_MISMATCH','sources','Seal sources into the project that retained them.');
  const directory=join(await projectDirectory(projectPath),'sources',checkedId(sourceSet.id));if(await realpath(directory)!==directory)throw new Failure('SOURCE_DIRECTORY_REDIRECT','sources','Restore the project-owned source directory.');
  for(const ref of [...sourceSet.sources.map(s=>s.media),...sourceSet.artifacts,...(sourceSet.records??[])])await retainedPath(directory,ref);
  const path=join(directory,'source-set.json');await saveJson(path,sourceSet,true);return {directory,path,sha256:await fileDigest(path)};
}
export async function loadSourceSet(projectPath:string,id:string){
  const project=await readProject(projectPath),directory=join(await projectDirectory(projectPath),'sources',checkedId(id));if(await realpath(directory)!==directory)throw new Failure('SOURCE_DIRECTORY_REDIRECT','sources','Restore the project-owned source directory.');
  const manifest=join(directory,'source-set.json');if((await lstat(manifest)).isSymbolicLink())throw new Failure('SOURCE_MANIFEST_REDIRECT','sources','Restore the literal sealed source manifest.');
  const bytes=await readFile(manifest),sourceSet=validateSourceSet(JSON.parse(bytes.toString()));
  if(sourceSet.id!==id||sourceSet.projectId!==project.id)throw new Failure('SOURCE_PROJECT_MISMATCH','sources','Use a source set belonging to this project.');
  const sourcePaths:Record<string,string>={},artifactPaths:Record<string,string>={};
  for(const source of sourceSet.sources)sourcePaths[source.id]=await retainedPath(directory,source.media);
  for(const artifact of sourceSet.artifacts)artifactPaths[artifact.id]=await retainedPath(directory,artifact);
  for(const ref of sourceSet.records??[])await retainedPath(directory,ref);
  return {sourceSet,sha256:sha256(bytes),directory,sourcePaths,artifactPaths};
}
export async function createCompositionDirectory(projectPath:string){
  await readProject(projectPath);const id=newId('composition'),directory=await ownedDirectory(projectPath,'compositions',id);return {id,directory};
}
export async function inspectProject(projectPath:string,limit=20,offset=0){
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Failure('INVALID_LIMIT','project','Use a limit from 1 to 100.');
  if(!Number.isSafeInteger(offset)||offset<0)throw new Failure('INVALID_OFFSET','project','Use a nonnegative integer offset.');
  const project=await readProject(projectPath);const lists:Record<string,{ids:string[];total:number;offset:number;nextOffset:number|null;truncated:boolean}>={};
  for(const kind of ['sessions','takes','sources','compositions','previews']){
    let entries:Dirent[];try{entries=await readdir(join(resolve(projectPath),kind),{withFileTypes:true});}catch(error){if(kind!=='previews'||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;entries=[];}
    const items=entries.filter(e=>e.isDirectory()&&!e.isSymbolicLink()).map(e=>e.name).sort().reverse(),end=Math.min(items.length,offset+limit);
    lists[kind]={ids:items.slice(offset,end),total:items.length,offset,nextOffset:end<items.length?end:null,truncated:end<items.length};
  }
  return {project,directory:resolve(projectPath),...lists};
}
