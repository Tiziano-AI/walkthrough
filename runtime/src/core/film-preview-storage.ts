import {constants} from 'node:fs';
import {mkdir,lstat,realpath,readdir,unlink,rmdir,open} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Failure} from './contracts.ts';
import {fileDigest} from './files.ts';
import {saveJson,projectDirectory} from '../project/store.ts';

const unsafe=()=>new Failure('FILM_PREVIEW_STORAGE_UNSAFE','storage','Keep the preview material intact: an owned path or file changed. Inspect the exact preview directory before continuing.');
const absent=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
async function directory(path:string){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw unsafe();}
async function regular(path:string){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||await realpath(path)!==path)throw unsafe();return info;}
async function unlinkVerified(path:string,digest:string){await regular(path);if(await fileDigest(path)!==digest)throw unsafe();await unlink(path);}
async function json(path:string){const info=await regular(path);if(info.size>16*1024*1024)throw unsafe();const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{return JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}}
const previewId=(id:unknown):id is string=>typeof id==='string'&&/^preview-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id);
export function checkedPreviewId(id:unknown):string{
  if(!previewId(id))throw new Failure('FILM_PREVIEW_ID_INVALID','preview','Use the exact preview ID returned by preview or project inspect.');
  return id;
}

const activePreview=()=>new Failure('FILM_PREVIEW_ACTIVE','preview','Follow the current preview attempt before starting another. Inspect --preview reports its retained identity.');

/** macOS lockf's descriptor-only mode locks the inherited open-file description.
 * The helper exits immediately; this handle keeps the BSD flock until close or
 * process death. Never unlink this inode: active.json is metadata, not the lock. */
export async function previewOwnership(root:string){
  const path=join(root,'ownership.lock');
  const handle=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  try{
    const expected=await handle.stat(),literal=await regular(path);
    if(!expected.isFile()||expected.dev!==literal.dev||expected.ino!==literal.ino)throw unsafe();
    const result=spawnSync('/usr/bin/lockf',['-s','-t','0','3'],{stdio:['ignore','ignore','ignore',handle.fd],env:{PATH:'/usr/bin:/bin'},timeout:5000});
    if(result.status===75)throw activePreview();
    if(result.error||result.status!==0)throw new Failure('FILM_PREVIEW_LOCK_UNAVAILABLE','preview','Restore the macOS /usr/bin/lockf primitive before starting a preview. No preview attempt was created; do not delete ownership.lock or the retained attempts.');
    const current=await regular(path);
    if(expected.dev!==current.dev||expected.ino!==current.ino)throw unsafe();
    return handle;
  }catch(error){await handle.close();throw error;}
}

/** One working attempt at a time. A stopped process leaves its diagnostic
 * directory; its metadata can be replaced only while holding the kernel lock. */
export async function beginPreview(projectPath:string){
  const root=join(projectPath,'previews');try{await mkdir(root,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}await directory(root);
  const ownership=await previewOwnership(root),lock=join(root,'active.json'),id=`preview-${randomUUID()}`;
  try{
    let active;try{active=await json(lock);}catch(error){if(!absent(error))throw error;}
    if(active){
      if(!previewId(active.id)||!Number.isSafeInteger(active.pid)||active.pid<1)throw unsafe();
      let running=true;try{process.kill(active.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')running=false;else throw error;}
      if(running)throw activePreview();
    }
    const path=join(root,id);await mkdir(path,{mode:0o700});
    await saveJson(lock,{schemaVersion:1,id,pid:process.pid});
    let released=false;
    return {id,directory:path,release:async()=>{
      if(released)return;released=true;
      try{const active=await json(lock);if(active.id!==id||active.pid!==process.pid)throw unsafe();await unlink(lock);}
      finally{await ownership.close();}
    }};
  }catch(error){await ownership.close();throw error;}
}

async function inventory(root:string){
  await directory(root);const files:Record<string,string>={},directories:string[]=[];
  const visit=async(relative:string)=>{const path=join(root,relative),info=await lstat(path);if(info.isDirectory()){await directory(path);directories.push(relative);for(const name of await readdir(path))await visit(relative?`${relative}/${name}`:name);}else{await regular(path);files[relative]=await fileDigest(path);}};
  for(const name of await readdir(root))if(name!=='owned-files.json')await visit(name);
  return {files,directories};
}
/** Only after success: remove regenerable render media/assets. Logs and inputs
 * remain for failed attempts. Never traverse redirects or delete foreign files. */
export async function compactPreviewScratch(path:string){
  const render=join(path,'render');try{await directory(render);}catch(error){if(absent(error))return;throw error;}
  const removable=['assets','bundle','master.mov','walkthrough.mp4','poster.png'];
  for(const name of removable){
    const target=join(render,name);let info;try{info=await lstat(target);}catch(error){if(absent(error))continue;throw error;}
    if(info.isDirectory()){
      const owned=await inventory(target);
      const asset=(relative:string)=>/^(?:source-\d+\.mp4|beat-\d+\.wav)$/.test(relative);
      if(name==='assets'&&(owned.directories.length||Object.keys(owned.files).some(relative=>!asset(relative))))throw unsafe();
      if(name==='bundle'&&(owned.directories.some(relative=>relative!=='public')||Object.keys(owned.files).some(relative=>relative.startsWith('public/')?!asset(relative.slice(7)):!/^(?:(?:\d+\.)?bundle\.js(?:\.map)?|index\.html|favicon\.ico)$/.test(relative))))throw unsafe();
      for(const [relative,digest] of Object.entries(owned.files))await unlinkVerified(join(target,relative),digest);
      for(const relative of owned.directories.sort((a,b)=>b.length-a.length))await rmdir(join(target,relative));await rmdir(target);
    }else{await regular(target);await unlink(target);}
  }
}
async function retirePreview(path:string){
  const expected=await json(join(path,'owned-files.json')),actual=await inventory(path);
  if(JSON.stringify(Object.entries(expected.files??{}).sort())!==JSON.stringify(Object.entries(actual.files).sort()))throw unsafe();
  for(const [relative,digest] of Object.entries(actual.files))await unlinkVerified(join(path,relative),digest);
  await unlink(join(path,'owned-files.json'));
  for(const relative of actual.directories.sort((a,b)=>b.length-a.length))await rmdir(join(path,relative));await rmdir(path);
}
export async function publishPreview(projectPath:string,id:string){
  if(!previewId(id))throw unsafe();const root=join(projectPath,'previews'),path=join(root,id);await directory(path);
  const manifest=await json(join(path,'preview.json'));if(manifest.kind!=='preview'||manifest.id!==id||manifest.projectPath!==projectPath||manifest.status!=='ready')throw unsafe();
  await saveJson(join(path,'owned-files.json'),await inventory(path),true);
  let previous:any;try{previous=await json(join(root,'current.json'));}catch(error){if(!absent(error))throw error;}
  await saveJson(join(root,'current.json'),{schemaVersion:1,kind:'current-preview',id});
  let retirement:'none'|'retired'|'retained'='none';
  if(previous){
    if(!previewId(previous.id)||previous.kind!=='current-preview')return {retirement:'retained' as const};
    try{await retirePreview(join(root,previous.id));retirement='retired';}catch{retirement='retained';}
  }
  return {retirement};
}

async function inspectedPreview(projectPath:string,id:string){
  const path=join(projectPath,'previews',id);let manifest;
  try{await directory(path);manifest=await json(join(path,'preview.json'));}
  catch(error){if(absent(error))throw new Failure('FILM_PREVIEW_MANIFEST_MISSING','preview',`The selected preview ${id} has no readable retained manifest at ${join(path,'preview.json')}. Restore its exact retained files or create another preview from sealed sources; do not repeat application work.`);throw error;}
  if(manifest.kind!=='preview'||manifest.id!==id||manifest.projectPath!==projectPath)throw unsafe();
  let integrity='not-complete',videoPath:string|null=null;
  if(manifest.status==='ready'){
    const video=join(path,'preview.mp4');
    try{await regular(video);integrity=await fileDigest(video)===manifest.videoSha256?'verified':'changed';if(integrity==='verified')videoPath=video;}
    catch(error){if(absent(error))integrity='missing';else throw error;}
  }
  const {inspectNarrationFit}=await import('./film.ts');
  const narrationFit=await inspectNarrationFit(path,{conflictsOnly:manifest.status==='failed'});
  return {manifest:{...manifest,integrity,integrityScope:'preview-video-sha256',videoPath},diagnosticPath:join(path,'preview.json'),narrationFit};
}

export async function inspectCurrentPreview(projectPath:string,attemptId?:string){
  projectPath=await projectDirectory(projectPath);
  const root=join(projectPath,'previews');let active:unknown=null,current:unknown=null;
  const basis={statusBasis:'retained-preview-manifest',processLiveness:'not-observed'};
  if(attemptId&&!previewId(attemptId))throw new Failure('FILM_PREVIEW_ID_INVALID','preview','Use the exact preview ID returned by preview.');
  if(attemptId){
    await directory(root);const {manifest,...diagnostics}=await inspectedPreview(projectPath,attemptId);
    return {attempt:manifest,...diagnostics,...basis};
  }
  try{await directory(root);}catch(error){if(absent(error))return {current,active,narrationFit:null,...basis};throw error;}
  try{active=await json(join(root,'active.json'));}catch(error){if(!absent(error))throw error;}
  let pointer;try{pointer=await json(join(root,'current.json'));}catch(error){if(!absent(error))throw error;}
  if(!pointer)return {current,active,narrationFit:null,...basis};
  if(!previewId(pointer.id)||pointer.kind!=='current-preview')throw unsafe();
  const {manifest,...diagnostics}=await inspectedPreview(projectPath,pointer.id);
  if(manifest.status!=='ready')throw unsafe();
  return {current:manifest,active,...diagnostics,...basis};
}
