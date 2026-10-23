import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {cp,lstat,readFile,readdir,readlink,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';

export const hash=value=>createHash('sha256').update(value).digest('hex');
export const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const failure=(code,recovery)=>Object.assign(new Error(code),{code,recovery});
export const fail=(code,recovery)=>{throw failure(code,recovery);};
export const requiredInputSchemas=['project-brief','session-action','action-resolution','capture-start','capture-mark','capture-seal','film-edit'];
export const requiredProcessReaderFiles=['scripts/provision-session.mjs','src/session/native/process-reader.c','native/walkthrough-process-reader','native/process-reader.json'];
export const nativePackages=['@remotion/compositor-darwin-arm64','@rspack/binding-darwin-arm64','@esbuild/darwin-arm64'];
export const browserQualification={packageVersion:'1.64.1',revision:'1248',version:'156.0.8078.4',executable:'chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'};
// Identify the owned bytes actually shipped, independent of checkout location or
// Git availability/dirty state. The complete release inventory separately covers
// production dependencies. This makes no claim about a clean Git commit.
export function releaseSource(files){
  const owned=files.filter(entry=>entry.path!=='release.json'&&entry.path!=='runtime-tools.json'&&entry.path!=='node_modules'&&!entry.path.startsWith('node_modules/'));
  return {kind:'content-inventory',scope:'packaged-owned-files',sha256:hash(JSON.stringify(owned))};
}
export async function stat(path){try{return await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export async function fileHash(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
export function localPath(path){return typeof path==='string'&&path.length>0&&!isAbsolute(path)&&!path.includes('\\')&&!path.split('/').some(p=>!p||p==='.'||p==='..');}
export async function inventory(root,{exclude=[]}={}){
  const result=[];
  async function visit(directory,prefix=''){
    for(const name of (await readdir(directory)).sort()){
      const path=prefix?`${prefix}/${name}`:name;if(exclude.includes(path))continue;
      if(!localPath(path))fail('RELEASE_PATH_INVALID','Release paths must be ordinary relative paths.');
      const absolute=join(root,path),info=await lstat(absolute),mode=info.mode&0o777;
      if(info.isDirectory()){result.push({path,kind:'directory',mode});await visit(absolute,path);}
      else if(info.isFile())result.push({path,kind:'file',mode,size:info.size,sha256:await fileHash(absolute)});
      else if(info.isSymbolicLink()){
        const target=await readlink(absolute),resolved=resolve(dirname(absolute),target);
        if(isAbsolute(target)||!resolved.startsWith(resolve(root)+sep))fail('RELEASE_LINK_ESCAPE','Release links must stay within the release.');
        result.push({path,kind:'link',target});
      }else fail('RELEASE_FILE_INVALID','Release may contain only regular files, directories and internal relative links.');
    }
  }
  await visit(root);return result;
}
export async function fingerprint(path){
  const info=await stat(path);if(!info)return null;
  if(info.isSymbolicLink())return {kind:'link',target:await readlink(path)};
  if(info.isFile())return {kind:'file',mode:info.mode&0o777,sha256:await fileHash(path)};
  if(info.isDirectory())return {kind:'directory',mode:info.mode&0o777,sha256:hash(JSON.stringify(await inventory(path)))};
  fail('INSTALL_TARGET_COLLISION','A managed output is a special file; preserve it.');
}
export async function verifyRelease(root){
  root=await realpath(root);
  const manifestPath=join(root,'release.json'),info=await stat(manifestPath);
  if(!info?.isFile()||info.isSymbolicLink())fail('RELEASE_MANIFEST_INVALID','Use an extracted Walkthrough release archive with its regular release.json manifest.');
  const bytes=await readFile(manifestPath),manifest=JSON.parse(bytes);
  if(manifest.schemaVersion!==2||!['bootstrap','prepared'].includes(manifest.kind)||manifest.product!=='walkthrough'||!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(manifest.version)||manifest.platform!=='darwin'||manifest.arch!=='arm64'||!Array.isArray(manifest.files))fail('RELEASE_MANIFEST_INVALID','The release identity is invalid or not a macOS arm64 bootstrap/prepared release.');
  if(!equal(await inventory(root,{exclude:['release.json']}),manifest.files))fail('RELEASE_INTEGRITY_FAILED','Release bytes differ from release.json. Restore the exact archive; do not repair installed files in place.');
  for(const required of ['bin/walkthrough.mjs','src/cli.ts','src/command-help.ts','src/core/runtime-paths.ts','skills/walkthrough/SKILL.md','scripts/install-local.mjs','scripts/release-files.mjs','scripts/prepare-release.mjs','scripts/provision-renderer.ts','scripts/loopback-only.sb','README.md','package.json','package-lock.json',...requiredProcessReaderFiles,...requiredInputSchemas.map(name=>`docs/schemas/${name}.schema.json`)])if(!manifest.files.some(f=>f.path===required&&f.kind==='file'))fail('RELEASE_INCOMPLETE',`The release lacks ${required}. Rebuild the release package.`);
  if(manifest.kind==='bootstrap'&&manifest.files.some(f=>f.path==='node_modules'||f.path.startsWith('node_modules/')))fail('RELEASE_BOOTSTRAP_REDISTRIBUTION','Bootstrap archives contain owned inputs only, not acquired dependencies.');
  if(manifest.kind==='prepared'&&!/^[a-f0-9]{64}$/.test(manifest.bootstrapDigest))fail('RELEASE_PREPARATION_INVALID','The prepared closure must identify its admitted bootstrap.');
  let processReader;try{processReader=JSON.parse(await readFile(join(root,'native/process-reader.json'),'utf8'));}catch{fail('RELEASE_PROCESS_READER_INVALID','The packaged process reader manifest is unreadable. Rebuild through explicit release setup.');}
  const processReaderPath=join(root,'native/walkthrough-process-reader'),processReaderInfo=await stat(processReaderPath);
  if(processReader?.schemaVersion!==1||processReader.platform!=='darwin'||processReader.arch!=='arm64'||processReader.sourceSha256!==await fileHash(join(root,'src/session/native/process-reader.c'))||processReader.binarySha256!==await fileHash(processReaderPath)||(processReaderInfo.mode&0o777)!==0o755||(processReaderInfo.mode&0o6000)!==0)fail('RELEASE_PROCESS_READER_INVALID','The packaged process reader identity or non-privileged executable mode is invalid. Rebuild through explicit release setup.');
  for(const name of requiredInputSchemas){
    let schema;try{schema=JSON.parse(await readFile(join(root,'docs/schemas',`${name}.schema.json`),'utf8'));}catch{fail('RELEASE_SCHEMA_INVALID',`The ${name} input schema is unreadable. Rebuild the release with its public input contracts.`);}
    if(schema?.$schema!=='https://json-schema.org/draft/2020-12/schema'||schema?.$id!==`urn:walkthrough:input:${name}:1`)fail('RELEASE_SCHEMA_INVALID',`The ${name} input schema has the wrong identity. Rebuild the release with its public input contracts.`);
  }
  if(!equal(manifest.source,releaseSource(manifest.files)))fail('RELEASE_SOURCE_IDENTITY_INVALID','The source identity does not match the owned packaged file inventory. Rebuild the release rather than attributing it to different source bytes.');
  const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  if(pkg.name!=='walkthrough'||pkg.version!==manifest.version)fail('RELEASE_VERSION_MISMATCH','Package and release versions must match.');
  return {root,manifest,digest:hash(bytes),id:`${manifest.version}-${hash(bytes).slice(0,16)}`};
}
export async function copyRelease(source,target){await cp(source,target,{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false,preserveTimestamps:true});}
