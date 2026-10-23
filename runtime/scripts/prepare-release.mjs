import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {browserQualification,equal,fail,fileHash,hash,inventory,nativePackages,releaseSource,stat,verifyRelease} from './release-files.mjs';

export async function preparationProcesses(reader){
  const info=await stat(reader.path);
  if(!info?.isFile()||(info.mode&0o7777)!==0o755||await fileHash(reader.path)!==reader.binarySha256)fail('INSTALL_PROCESS_READER_CHANGED','Restore the admitted package process reader before inspecting installation custody.');
  const result=spawnSync(reader.path,[],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'},maxBuffer:16*1024*1024});
  let snapshot;try{snapshot=JSON.parse(result.stdout);}catch{}
  if(result.status!==0||snapshot?.schemaVersion!==1||!Array.isArray(snapshot.processes)||snapshot.processes.some(row=>!Number.isInteger(row.pid)||row.pid<1||!Number.isInteger(row.pgid)||row.pgid<0||!['A','Z','?'].includes(row.state)))fail('INSTALL_PROCESS_SNAPSHOT_UNPROVEN','The native reader could not establish process-group absence. Preserve the pending installation.');
  return snapshot.processes;
}
const gatedCommand=`import {spawn} from 'node:child_process';
let input='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{input+=chunk;if(input==='run\\n'){process.stdin.removeAllListeners('data');process.stdin.pause();const child=spawn(process.argv[1],JSON.parse(process.argv[2]),{stdio:['ignore','inherit','inherit']});child.on('error',()=>process.exit(125));child.on('exit',(code,signal)=>process.exit(code??(signal?126:125)));}else if(input.length>4)process.exit(124);});
process.stdin.on('end',()=>{if(input!=='run\\n')process.exit(124);});`;
async function run(runtime,args,{cwd,env,custody,name}){
  const command={name,token:randomUUID(),identity:null,status:'starting'};
  custody.journal.preparation.commands??=[];custody.journal.preparation.commands.push(command);await custody.save();
  const child=spawn(runtime,['--input-type=module','-e',gatedCommand,runtime,JSON.stringify(args),command.token],{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
  const completed=new Promise(resolve=>{child.on('error',()=>resolve(null));child.on('close',code=>resolve(code));});
  // Drain output without copying possible upstream credentials into receipts.
  child.stdout.resume();child.stderr.resume();child.stdin.on('error',()=>{});
  try{
    const row=(await preparationProcesses(custody.reader)).find(row=>row.pid===child.pid&&row.pgid===child.pid&&row.lastArgumentSha256===hash(command.token)&&/^\d+:\d+$/.test(row.startedAt)&&/^[a-f0-9]{64}$/.test(row.commandSha256));
    if(!row)fail('INSTALL_COMMAND_IDENTITY_UNPROVEN','The acquisition worker did not establish its exact native identity. No command was authorized.');
    command.identity={pid:row.pid,pgid:row.pgid,startedAt:row.startedAt,commandSha256:row.commandSha256};command.status='running';await custody.save();
    child.stdin.end('run\n');
  }catch(error){child.stdin.end();await completed;throw error;}
  const status=await completed;
  command.status='stopped';await custody.save();
  const survivors=(await preparationProcesses(custody.reader)).filter(row=>row.pgid===command.identity.pgid&&row.state!=='Z');
  if(survivors.length)fail('INSTALL_COMMAND_SURVIVORS','The acquisition worker left a surviving process group. Preserve custody; recovery will not touch the stage while a member remains.');
  if(status!==0)fail('INSTALL_PREPARATION_FAILED',`Explicit ${name} preparation failed with exit ${status??'unavailable'}. Preserve the pending journal and preparation directory; inspect the upstream command before recovery.`);
}
export async function qualifiedNode(runtime){
  if(typeof runtime!=='string'||!runtime)fail('INSTALL_NODE_SELECTION_REQUIRED','Install requires --node <absolute-invocation-path> selecting Node 24.22.1 or later on the 24 line. Choose the operator-managed path that should survive prerequisite upgrades; the current process executable may be a removable versioned path. The installer never acquires Node.');
  runtime=resolve(runtime);
  // Validate the current referent without freezing an operator-managed link to
  // a removable versioned installation in the launcher or tool selection.
  const executable=await realpath(runtime).catch(()=>null),version=executable?spawnSync(executable,['--version'],{encoding:'utf8'}):null;
  const match=version?.status===0?/^v24\.(\d+)\.(\d+)\s*$/.exec(version.stdout):null;
  if(!match||!(Number(match[1])>22||Number(match[1])===22&&Number(match[2])>=1))fail('INSTALL_NODE_UNQUALIFIED','Select Node 24.22.1 or later on the 24 line. The installer never acquires Node.');
  return runtime;
}
export async function npmForNode(runtime,requested){
  const candidate=requested?resolve(requested):join(dirname(runtime),'../lib/node_modules/npm/bin/npm-cli.js');
  const path=await realpath(candidate).catch(()=>null);
  if(!path||(await stat(path))?.isFile()!==true)fail('INSTALL_NPM_MISSING','Select the npm-cli.js shipped with the chosen Node using --npm. The installer does not download npm.');
  const version=spawnSync(runtime,[path,'--version'],{encoding:'utf8'});
  if(version.status!==0||!/^\d+\.\d+\.\d+\s*$/.test(version.stdout))fail('INSTALL_NPM_UNQUALIFIED','The selected npm CLI cannot execute with the chosen Node.');
  return path;
}
export async function verifyPreparedDependencies(root){
  const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
  for(const name of nativePackages){
    const expected=lock.packages?.[`node_modules/${name}`];
    let actual;try{actual=JSON.parse(await readFile(join(root,'node_modules',name,'package.json'),'utf8'));}catch{}
    if(!expected?.integrity||actual?.version!==expected.version)fail('INSTALL_NATIVE_DEPENDENCY_MISSING',`Explicit npm preparation must retain the locked optional native package ${name}. No runtime acquisition is permitted.`);
  }
  const playwright=JSON.parse(await readFile(join(root,'node_modules/playwright-core/package.json'),'utf8'));
  const browsers=JSON.parse(await readFile(join(root,'node_modules/playwright-core/browsers.json'),'utf8'));
  const chromium=browsers.browsers?.find(browser=>browser.name==='chromium');
  if(playwright.version!==browserQualification.packageVersion||chromium?.revision!==browserQualification.revision||chromium?.browserVersion!==browserQualification.version)fail('INSTALL_BROWSER_QUALIFICATION_CHANGED','The locked Playwright browser identity differs from the qualified Chromium. Deliberately qualify that change before packaging.');
}
/** Explicit installer preparation only. Authoring never calls this module. */
export async function prepareRelease({root,runtime,npmPath,home,tools,custody}){
  const bootstrap=await verifyRelease(root);
  if(bootstrap.manifest.kind!=='bootstrap')fail('INSTALL_BOOTSTRAP_REQUIRED','Dependency acquisition requires a verified bootstrap archive.');
  const env={...process.env,HOME:home,PATH:`${dirname(runtime)}:/usr/bin:/bin`,PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1',npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'};
  await run(runtime,[npmPath,'ci','--omit=dev','--include=optional','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,env,custody,name:'npm-production-dependencies'});
  await verifyPreparedDependencies(root);
  await run(runtime,[join(root,'scripts/provision-renderer.ts')],{cwd:root,env,custody,name:'renderer-patches'});
  // Only dependency bytes may change during setup. The package lock and every
  // owned byte stay bound to the admitted public bootstrap inventory.
  const files=await inventory(root,{exclude:['release.json']});
  if(!equal(releaseSource(files),bootstrap.manifest.source))fail('INSTALL_BOOTSTRAP_CHANGED','Dependency preparation changed an owned bootstrap input. Preserve the stage instead of activating it.');
  await writeFile(join(root,'runtime-tools.json'),JSON.stringify({schemaVersion:1,tools},null,2)+'\n',{flag:'wx',mode:0o644});
  await writeFile(join(root,'release.json'),JSON.stringify({...bootstrap.manifest,kind:'prepared',bootstrapDigest:bootstrap.digest,files:await inventory(root,{exclude:['release.json']})},null,2)+'\n',{mode:0o644});
  return verifyRelease(root);
}
export async function qualifiedTool(requested,name){
  const candidates=requested?[resolve(requested)]:(process.env.PATH??'').split(':').filter(Boolean).map(directory=>resolve(directory,name));
  for(const candidate of candidates){
    const path=await realpath(candidate).catch(()=>null);if(!path)continue;
    const result=spawnSync(path,['-version'],{encoding:'utf8'});
    if(result.status===0&&result.stdout.startsWith(`${name} version `))return candidate;
  }
  fail('INSTALL_TOOL_MISSING',`Provide a working ${name} executable using --${name}. The installer does not acquire system tools.`);
}
/** The stable package path is registered before current is activated. */
export async function prepareBrowser({root,runtime,browserRoot,home,custody}){
  await mkdir(browserRoot,{recursive:true,mode:0o755});
  await verifyPreparedDependencies(root);
  await run(runtime,[join(root,'node_modules/playwright/cli.js'),'install','chromium','--no-shell'],{cwd:root,custody,name:'qualified-browser',env:{...process.env,HOME:home,PATH:`${dirname(runtime)}:/usr/bin:/bin`,PLAYWRIGHT_BROWSERS_PATH:browserRoot}});
  const executable=join(browserRoot,browserQualification.executable),info=await stat(executable);
  if(!info?.isFile()||!(info.mode&0o111))fail('INSTALL_BROWSER_INCOMPLETE','The pinned Playwright downloader did not produce the qualified browser executable. Preserve preparation and inspect its result.');
  return executable;
}
