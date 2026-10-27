#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {chmod,mkdir,realpath,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {browserQualification,fail,fileHash,inventory,releaseSource,stat,verifyRelease} from './release-files.mjs';

const runtimeRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// Public owned inputs only. Historical operational records and broad docs/
// copies are not release inputs. Git supplies a reviewed committed inventory,
// never private history or untracked workstation material.
const runtimeReleasePaths=['bin','src','scripts/install-local.mjs','scripts/release-files.mjs','scripts/prepare-release.mjs','scripts/install-browser.mjs','scripts/provision-renderer.ts','scripts/provision-session.mjs','scripts/loopback-only.sb','docs/schemas','package.json','package-lock.json'];
const guidanceReleasePaths=['skills/walkthrough','README.md','LICENSE','THIRD_PARTY_NOTICES.md','VISION.md','ARCHITECTURE.md','QUALITY.md','SECURITY.md','docs/browser-authoring.md'];
export const publicReleasePaths=[...runtimeReleasePaths.map(path=>`runtime/${path}`),...guidanceReleasePaths];
/** Build owned bootstrap bytes only. No dependency acquisition or redistribution. */
export async function packageRelease({sourceRoot=runtimeRoot,outputRoot,platform=process.platform,arch=process.arch}){
  if(platform!=='darwin'||arch!=='arm64')fail('PACKAGE_PLATFORM_UNQUALIFIED','Build the macOS arm64 archive on macOS arm64 with the Apple C toolchain.');
  let repositoryRoot,owned,commit;
  try{
    repositoryRoot=execFileSync('/usr/bin/git',['rev-parse','--show-toplevel'],{cwd:sourceRoot,encoding:'utf8'}).trim();
    commit=execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim();
    execFileSync('/usr/bin/git',['diff','--quiet',commit,'--',...publicReleasePaths],{cwd:repositoryRoot,stdio:'pipe'});
    owned=execFileSync('/usr/bin/git',['ls-tree','-r','--name-only','-z',commit,'--',...publicReleasePaths],{cwd:repositoryRoot,encoding:'utf8'}).split('\0').filter(Boolean);
  }catch{fail('PACKAGE_SOURCE_UNCOMMITTED','Commit the reviewed public input inventory before packaging. Packaging does not publish private history or working-tree changes.');}
  if(await realpath(sourceRoot)!==join(await realpath(repositoryRoot),'runtime'))fail('PACKAGE_SOURCE_LAYOUT','Build from the repository runtime/ directory. The plugin root must not need a package.json.');
  for(const path of publicReleasePaths)if(!owned.some(name=>name===path||name.startsWith(path+'/')))fail('PACKAGE_SOURCE_UNCOMMITTED',`The committed public input inventory lacks ${path}. Commit the complete reviewed input inventory before packaging.`);
  // Metadata and both mapped trees use this one captured commit, even if the
  // working tree or HEAD changes after admission. No root package.json is read.
  const committedJson=path=>JSON.parse(execFileSync('/usr/bin/git',['show',`${commit}:runtime/${path}`],{cwd:repositoryRoot,encoding:'utf8'}));
  const pkg=committedJson('package.json'),lock=committedJson('package-lock.json');
  if(lock.packages?.['']?.version!==pkg.version)fail('PACKAGE_LOCK_DRIFT','Update the runtime lockfile version and dependencies with the intentional source release.');
  for(const [name,version] of Object.entries(pkg.dependencies??{}))if(lock.packages['']?.dependencies?.[name]!==version)fail('PACKAGE_LOCK_DRIFT',`The dependency ${name} differs from the lockfile.`);
  const name=`walkthrough-${pkg.version}-darwin-arm64`,destination=join(resolve(outputRoot),name),archive=destination+'.tar.gz';
  if(await stat(destination)||await stat(archive))fail('PACKAGE_OUTPUT_EXISTS','Choose a new output directory; release artifacts are never overwritten.');
  await mkdir(destination,{recursive:true,mode:0o755});
  // The repository root is a guidance-only plugin. Flatten its runtime subtree
  // into the independent CLI archive, then add only named public root inputs.
  // Tree object arguments keep private commit IDs out of Git's tar pax headers.
  for(const [tree,paths] of [[`${commit}:runtime`,owned.filter(path=>path.startsWith('runtime/')).map(path=>path.slice('runtime/'.length))],[`${commit}^{tree}`,owned.filter(path=>!path.startsWith('runtime/'))]]){
    const committedArchive=execFileSync('/usr/bin/git',['archive','--format=tar',tree,'--',...paths],{cwd:repositoryRoot,maxBuffer:64*1024*1024});
    execFileSync('/usr/bin/tar',['-xf','-','-C',destination],{input:committedArchive,env:{...process.env,COPYFILE_DISABLE:'1'}});
  }
  // Explicit release setup compiles the one-shot process reader in the staged
  // package. Installed operation never invokes a compiler or downloads inputs.
  execFileSync(process.execPath,[join(destination,'scripts/provision-session.mjs')],{cwd:destination,encoding:'utf8'});
  await chmod(join(destination,'bin/walkthrough.mjs'),0o755);
  const files=await inventory(destination);
  const manifest={schemaVersion:2,kind:'bootstrap',product:'walkthrough',version:pkg.version,platform:'darwin',arch:'arm64',node:'24.22.1 <= version < 25',
    preparation:{npm:'ci --omit=dev --include=optional --ignore-scripts --no-audit --no-fund',browser:`@puppeteer/browsers ${browserQualification.installerVersion} install chrome@${browserQualification.version}`},
    externalPrerequisites:['Node >= 24.22.1 on the 24 line with npm','FFmpeg and ffprobe','Installed Voices and selected provision in user state'],
    source:releaseSource(files),files};
  await writeFile(join(destination,'release.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o644});
  const release=await verifyRelease(destination);
  // Copyfile suppression alone does not omit PAX xattrs. Public archives retain
  // file bytes and modes, not workstation provenance or builder ownership.
  execFileSync('/usr/bin/tar',['-czf',archive,'--no-xattrs','--uid','0','--gid','0','--uname','root','--gname','root','-C',dirname(destination),name],{env:{...process.env,COPYFILE_DISABLE:'1'}});
  const sha256=await fileHash(archive);
  await writeFile(archive+'.sha256',`${sha256}  ${name}.tar.gz\n`,{flag:'wx'});
  return {schemaVersion:1,status:'packaged',releaseId:release.id,releasePath:destination,archivePath:archive,sha256,dependencies:0,downloads:false,kind:'bootstrap'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--out')fail('INVALID_COMMAND','Use node scripts/package-release.mjs --out <new-output-directory>.');console.log(JSON.stringify(await packageRelease({outputRoot:args[1]})));}
  catch(error){console.log(JSON.stringify({schemaVersion:1,status:'failed',error:{code:error.code??'PACKAGE_FAILED',recovery:error.recovery??'Preserve the partial package and inspect its build inputs. Nothing was installed.'}}));process.exitCode=1;}
}
