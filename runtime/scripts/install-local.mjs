#!/usr/bin/env node
import {randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,readFile,realpath,rename,rm,symlink,writeFile,readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {browserQualification,copyRelease,equal,fail,fingerprint,hash,inventory,stat,verifyRelease} from './release-files.mjs';
import {npmForNode,preparationProcesses,prepareBrowser,prepareRelease,qualifiedNode,qualifiedTool} from './prepare-release.mjs';

const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
const usage='Use node scripts/install-local.mjs install --release <extracted-bootstrap> --node <Node24-invocation-path> [--home <isolated-home>] [--npm <npm-cli.js>] [--ffmpeg <executable>] [--ffprobe <executable>] [--plugin-discovery <host-qualification.json>], check, recover or uninstall. Install explicitly acquires locked dependencies and the qualified browser; runtime never downloads.';
export function installationPaths(home){
  const state=join(home,'.local/state/walkthrough'),installRoot=join(home,'.local/share/walkthrough');
  return {home,state,installRoot,releases:join(installRoot,'releases'),browsers:join(installRoot,'browsers'),current:join(installRoot,'current'),active:join(state,'active'),receipt:join(state,'installation.json'),pending:join(state,'installation-pending.json'),
    skill:join(home,'.agents/skills/walkthrough'),launcher:join(home,'.local/bin/walkthrough'),claude:join(home,'.claude/skills/walkthrough')};
}
async function parents(p,path,create=false){
  if(!resolve(path).startsWith(p.home+'/'))fail('INSTALL_PATH_INVALID','All installer outputs must be inside the selected home.');
  let current=p.home;
  for(const part of relative(p.home,dirname(path)).split('/').filter(Boolean)){
    if(part==='..')fail('INSTALL_PATH_INVALID','Installation paths must stay within the selected home.');
    current=join(current,part);let info=await stat(current);
    if(!info&&create){await mkdir(current,{mode:0o755});info=await lstat(current);}
    if(info&&(!info.isDirectory()||info.isSymbolicLink()))fail('INSTALL_PARENT_COLLISION','An installation parent is not a real directory. Resolve its owner without following it.');
  }
}
async function readJson(path){const info=await stat(path);if(!info)return null;if(!info.isFile()||info.isSymbolicLink())fail('INSTALL_RECORD_INVALID','Installation records must be regular files. Preserve the unexpected object.');try{return JSON.parse(await readFile(path,'utf8'));}catch{fail('INSTALL_RECORD_INVALID','The installation record is unreadable; preserve it for recovery.');}}
async function atomicJson(path,value){const temp=`${path}.${randomUUID()}.next`;await writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temp,path);}
const outputPaths=p=>[p.current,p.launcher];
const legacyOutputPaths=p=>[p.current,p.skill,p.launcher,p.claude];
const receiptOutputPaths=(p,receipt)=>receipt?.schemaVersion===1?[p.skill,p.launcher,p.claude]:receipt?.schemaVersion===2?legacyOutputPaths(p):outputPaths(p);
function validateReceipt(receipt,p){
  if(receipt===null)return;
  if(receipt.product!=='walkthrough'||!Array.isArray(receipt.outputs))fail('INSTALL_OWNER_CONFLICT','The receipt does not identify this Walkthrough installation.');
  if(receipt.schemaVersion===1){
    if(typeof receipt.repositoryRoot!=='string'||!receipt.repositoryRoot.startsWith('/')||resolve(receipt.repositoryRoot)!==receipt.repositoryRoot||typeof receipt.nodePath!=='string'||receipt.outputs.length!==3||receipt.outputs.some((o,i)=>o.path!==[p.skill,p.launcher,p.claude][i]||o.fingerprint?.kind!==['directory','file','link'][i]))fail('INSTALL_OWNER_CONFLICT','Legacy outputs do not match the exact owned installation.');
    return;
  }
  const expected=receipt.schemaVersion===2?legacyOutputPaths(p):outputPaths(p);
  if(![2,3].includes(receipt.schemaVersion)||receipt.installRoot!==p.installRoot||receipt.outputs.length!==expected.length||receipt.outputs.some((o,i)=>o.path!==expected[i]||!o.fingerprint)||!Array.isArray(receipt.releases)||receipt.releases.some(r=>!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?-[a-f0-9]{16}$/.test(r.id)||r.path!==join(p.releases,r.id)||!r.fingerprint))fail('INSTALL_OWNER_CONFLICT','The receipt does not match the exact installation paths and releases.');
}
async function legacyFingerprint(path){
  const current=await fingerprint(path);if(current?.kind!=='directory')return current;
  // The previous installer omitted regular Finder metadata and file sizes from
  // its receipt hash. Reproduce that contract only for admission. The transaction
  // below fingerprints every byte, including Finder metadata, for exact rollback.
  const tree=await inventory(path);
  if(tree.some(e=>e.kind==='link'))fail('INSTALL_TARGET_CHANGED','The source-backed skill contains a link its installer never admitted. Preserve it.');
  const entries=tree.filter(e=>!(e.kind==='file'&&e.path.split('/').at(-1)==='.DS_Store')).map(e=>e.kind==='file'?{path:e.path,kind:e.kind,mode:e.mode,sha256:e.sha256}:e);
  return {...current,sha256:hash(JSON.stringify(entries))};
}
async function verifyOwned(p,receipt){
  validateReceipt(receipt,p);
  for(const target of new Set([...outputPaths(p),...receiptOutputPaths(p,receipt)])){
    await parents(p,target);
    const expected=receipt?.outputs.find(o=>o.path===target)?.fingerprint??null;
    const current=receipt?.schemaVersion===1?await legacyFingerprint(target):await fingerprint(target);
    if(!equal(current,expected))fail('INSTALL_TARGET_CHANGED','A managed output is foreign, missing or changed. Preserve it and resolve its owner before install or uninstall.');
  }
  for(const release of receipt?.releases??[]){await parents(p,release.path);if(!equal(await fingerprint(release.path),release.fingerprint))fail('INSTALL_RELEASE_CHANGED','An immutable installed release changed. Preserve it and repair through a new reviewed release.');}
}
export async function assertIdle(p){
  await parents(p,join(p.active,'probe'));
  if(!await stat(p.active))return;
  for(const name of await readdir(p.active)){
    const record=await readJson(join(p.active,name));
    if(!record||record.schemaVersion!==1||!['command','session'].includes(record.kind)||!Number.isInteger(record.pid)||record.pid<1)fail('INSTALL_ACTIVITY_UNKNOWN','A runtime activity record is unreadable. Resolve that exact session or command before changing the installation.');
    const processIds=[record.pid,...(record.coordinatorPid?[record.coordinatorPid]:[])],groupIds=record.processGroupIds??[];
    if(!Array.isArray(groupIds)||[...processIds,...groupIds].some(pid=>!Number.isInteger(pid)||pid<1))fail('INSTALL_ACTIVITY_UNKNOWN','The activity process identities are invalid. Preserve the activity record.');
    let alive=false;
    for(const pid of [...processIds,...groupIds.map(pid=>-pid)])try{process.kill(pid,0);alive=true;}catch(error){if(error.code==='EPERM')alive=true;else if(error.code!=='ESRCH')throw error;}
    if(alive||record.kind==='session'&&record.status!=='closed')fail('INSTALL_ACTIVE_WORK','Close or recover the recorded Walkthrough session, and let running commands settle before installing or uninstalling.');
  }
}
function validateJournal(journal,p){
  if(!journal||journal.schemaVersion!==2||journal.product!=='walkthrough'||journal.installRoot!==p.installRoot||!/^[a-f0-9-]{36}$/.test(journal.id)||!Number.isInteger(journal.pid)||journal.pid<1||!['preparing','verifying','applying','committed'].includes(journal.phase)||!Array.isArray(journal.outputs))fail('INSTALL_RECOVERY_INVALID','Preserve the pending installation; its transaction identity is invalid.');
  validateReceipt(journal.previousReceipt,p);validateReceipt(journal.nextReceipt,p);
  const allowed=new Set([...outputPaths(p),...receiptOutputPaths(p,journal.previousReceipt),...(journal.previousReceipt?.releases??[]).map(r=>r.path)]);
  if(new Set(journal.outputs.map(o=>o.path)).size!==journal.outputs.length)fail('INSTALL_RECOVERY_INVALID','Pending outputs are duplicated. Preserve the record.');
  for(const output of journal.outputs)if(!allowed.has(output.path)||output.stage!==`${output.path}.next-${journal.id}`||output.backup!==`${output.path}.previous-${journal.id}`)fail('INSTALL_RECOVERY_INVALID','Pending output paths are not owned by this exact transaction.');
  if(journal.preparation&&(journal.preparation.stage!==join(p.releases,`.preparing-${journal.id}`)||!/^[a-f0-9]{64}$/.test(journal.preparation.bootstrapDigest)||!Array.isArray(journal.preparation.commands)||!/^[a-f0-9]{64}$/.test(journal.preparation.reader?.binarySha256)||journal.preparation.commands.some(command=>typeof command.token!=='string'||!['starting','running','stopped'].includes(command.status)||command.identity&&(!Number.isInteger(command.identity.pid)||command.identity.pgid!==command.identity.pid||!/^\d+:\d+$/.test(command.identity.startedAt)||!/^[a-f0-9]{64}$/.test(command.identity.commandSha256)))))fail('INSTALL_RECOVERY_INVALID','The pending preparation does not belong to this transaction.');
  if(journal.releaseStage){
    const stage=journal.releaseStage,release=journal.nextReceipt?.releases.find(r=>r.path===stage.path);
    if(dirname(stage.path)!==p.releases||!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?-[a-f0-9]{16}$/.test(stage.path.split('/').at(-1))||![`${stage.path}.next-${journal.id}`,journal.preparation?.stage].includes(stage.stage)||release&&!equal(release.fingerprint,stage.expected)||!stage.expected||!Array.isArray(stage.files))fail('INSTALL_RECOVERY_INVALID','The pending release staging path is not part of the intended immutable release.');
  }
}
async function removeMatching(path,expected){const current=await fingerprint(path);if(current===null)return;if(!equal(current,expected))fail('INSTALL_RECOVERY_COLLISION','A retained output changed. Preserve the pending operation and all predecessors.');await rm(path,{recursive:current.kind==='directory'});}
async function settle(p,journal,commit){
  validateJournal(journal,p);
  const receipt=await readJson(p.receipt);
  if(!equal(receipt,journal.previousReceipt)&&!equal(receipt,journal.nextReceipt))fail('INSTALL_RECOVERY_COLLISION','The installation receipt changed; preserve pending state.');
  for(const output of journal.outputs)for(const path of [output.path,output.stage,output.backup])await parents(p,path);
  if(commit){for(const output of journal.outputs)if(!equal(await fingerprint(output.path),output.after))fail('INSTALL_RECOVERY_COLLISION','A committed output changed; preserve pending state.');}
  else {
    for(const output of [...journal.outputs].reverse()){
      const current=await fingerprint(output.path),backup=await fingerprint(output.backup);
      if(backup!==null){
        if(!equal(backup,output.before)||current!==null&&!equal(current,output.after))fail('INSTALL_RECOVERY_COLLISION','A predecessor or output changed; preserve both.');
        if(current!==null)await removeMatching(output.path,output.after);
        await rename(output.backup,output.path);
      }else if(output.before===null){if(current!==null)await removeMatching(output.path,output.after);}
      else if(!equal(current,output.before))fail('INSTALL_RECOVERY_COLLISION','The predecessor is unavailable; retain the installation journal.');
    }
    if(journal.previousReceipt)await atomicJson(p.receipt,journal.previousReceipt);else if(receipt)await rm(p.receipt);
  }
  for(const output of journal.outputs){await removeMatching(output.stage,output.after);if(commit)await removeMatching(output.backup,output.before);}
  if(journal.releaseStage){
    const release=journal.releaseStage;
    await parents(p,release.stage);await parents(p,release.path);
    if(commit){if(!equal(await fingerprint(release.path),release.expected))fail('INSTALL_RECOVERY_COLLISION','The committed release changed; preserve it.');}
    else await removeMatching(release.path,release.expected);
    if(await stat(release.stage)){
      const observed=await inventory(release.stage);
      if(observed.some(entry=>!release.files.some(expected=>equal(entry,expected))))fail('INSTALL_RECOVERY_COLLISION','The staged release includes changed or incomplete files. Preserve the stage for exact recovery.');
      await rm(release.stage,{recursive:true});
    }
  }
  // An interrupted acquisition has no sealed inventory. Do not reinterpret it
  // as a release or delete unverified partial bytes. Recovery relinquishes the
  // exact preparation path and reports it for inspection; activation is undone.
  await rm(p.pending);
}
async function transact(p,{previousReceipt,nextReceipt,desired,prepare,releaseStage,existingJournal}){
  for(const path of [...desired.map(o=>o.path),p.pending])await parents(p,path,true);
  const id=existingJournal?.id??randomUUID(),outputs=[];
  for(const output of desired){
    const before=await fingerprint(output.path),ownedRelease=previousReceipt?.releases?.find(r=>r.path===output.path);
    if(ownedRelease&&!equal(before,ownedRelease.fingerprint))fail('INSTALL_RELEASE_CHANGED','An immutable installed release changed before retirement. Preserve it and repair through a new reviewed release.');
    outputs.push({...output,before,stage:`${output.path}.next-${id}`,backup:`${output.path}.previous-${id}`});
  }
  const journal={...existingJournal,schemaVersion:2,product:'walkthrough',installRoot:p.installRoot,id,pid:process.pid,phase:'applying',previousReceipt,nextReceipt,outputs,...(releaseStage?{releaseStage:{...releaseStage,stage:`${releaseStage.path}.next-${id}`}}:{})};
  if(existingJournal)await atomicJson(p.pending,journal);
  else try{await writeFile(p.pending,JSON.stringify(journal,null,2)+'\n',{flag:'wx',mode:0o600});}catch(error){if(error.code==='EEXIST')fail('INSTALL_RECOVERY_REQUIRED','Use check and recover for the existing installation occurrence after its process stops.');throw error;}
  try{
    await assertIdle(p);await prepare?.(journal);
    for(const output of outputs){
      if(output.after?.kind==='link')await symlink(output.after.target,output.stage);
      else if(output.after?.kind==='file'){await writeFile(output.stage,output.content,{flag:'wx',mode:output.after.mode});await chmod(output.stage,output.after.mode);}
      if(!equal(await fingerprint(output.stage),output.after))fail('INSTALL_STAGE_CHANGED','The staged output does not match the intended release.');
    }
    await assertIdle(p);
    for(const output of outputs){
      if(!equal(await fingerprint(output.path),output.before))fail('INSTALL_TARGET_CHANGED','A concurrent writer changed an installation output.');
      if(output.before!==null)await rename(output.path,output.backup);
      if(output.after!==null)await rename(output.stage,output.path);
    }
    if(!equal(await readJson(p.receipt),previousReceipt))fail('INSTALL_TARGET_CHANGED','The installation receipt changed during publication.');
    if(nextReceipt)await atomicJson(p.receipt,nextReceipt);else if(previousReceipt)await rm(p.receipt);
    journal.phase='committed';await atomicJson(p.pending,journal);
  }catch(error){try{await settle(p,journal,false);}catch{fail('INSTALL_RECOVERY_REQUIRED','The interrupted install retains its exact predecessors. Use check, then recover after its process stops.');}throw error;}
  try{await settle(p,journal,true);}catch{fail('INSTALL_RECOVERY_REQUIRED','The installation committed, but retained predecessor cleanup needs recover.');}
}
async function pluginDiscovery(path,p,receipt){
  if(!receipt||receipt.schemaVersion===3)return null;
  if(!path)fail('INSTALL_PLUGIN_DISCOVERY_REQUIRED','Qualify native Codex and Claude plugin discovery, then supply --plugin-discovery before removing the exact receipt-owned legacy skill projections.');
  const bytes=await readFile(path),proof=JSON.parse(bytes);
  if(proof?.schemaVersion!==1)fail('INSTALL_PLUGIN_DISCOVERY_INVALID','Use the host qualification record for both native plugin installations.');
  for(const [host,manifestName] of [['codex','plugin.json'],['claude','.claude-plugin/plugin.json']]){
    const item=proof.hosts?.[host];
    if(!item||typeof item.pluginRoot!=='string'||resolve(item.pluginRoot)!==item.pluginRoot||item.skillPath!==join(item.pluginRoot,'skills/walkthrough')||! /^[a-f0-9]{64}$/.test(item.manifestSha256))fail('INSTALL_PLUGIN_DISCOVERY_INVALID','The host qualification must identify each native plugin root, canonical skill and exact manifest.');
    const pluginRoot=await realpath(item.pluginRoot),skillPath=await realpath(item.skillPath);
    const legacySkills=await Promise.all([p.skill,p.claude].map(path=>realpath(path).catch(()=>null)));
    if(!skillPath.startsWith(pluginRoot+'/')||legacySkills.includes(skillPath)||[p.skill,p.claude,p.installRoot].some(path=>pluginRoot===path||skillPath===path||pluginRoot.startsWith(path+'/')))fail('INSTALL_PLUGIN_DISCOVERY_INVALID','Native discovery must not depend on a legacy installer-owned projection.');
    const manifestBytes=await readFile(join(pluginRoot,manifestName)),manifest=JSON.parse(manifestBytes);
    if(hash(manifestBytes)!==item.manifestSha256||manifest.name!=='walkthrough'||!await stat(join(skillPath,'SKILL.md')))fail('INSTALL_PLUGIN_DISCOVERY_CHANGED','The qualified native plugin bytes changed. Requalify host discovery before migration.');
  }
  return {sha256:hash(bytes),hosts:proof.hosts};
}
async function browserStore(p){
  await parents(p,join(p.browsers,'probe'),true);
  const marker=join(p.browsers,'.walkthrough-store.json'),expected={schemaVersion:1,product:'walkthrough',owner:'pinned-playwright-registry'};
  const existing=await readJson(marker);
  if(existing){if(!equal(existing,expected))fail('INSTALL_BROWSER_STORE_FOREIGN','Preserve the unrecognized browser-store owner. The installer never runs Playwright cache maintenance in an unowned store.');return;}
  if((await readdir(p.browsers)).length)fail('INSTALL_BROWSER_STORE_FOREIGN','The product browser directory contains unowned bytes. Resolve their owner before acquisition.');
  await writeFile(marker,JSON.stringify(expected)+'\n',{flag:'wx',mode:0o644});
}
async function assertPreparationStopped(journal){
  if(!journal.preparation)return;
  const reader={...journal.preparation.reader};
  for(const path of [reader.path,join(journal.preparation.stage,'native/walkthrough-process-reader'),...(journal.releaseStage?[join(journal.releaseStage.path,'native/walkthrough-process-reader')]:[])]){
    if(await stat(path)){reader.path=path;break;}
  }
  let table=await preparationProcesses(reader);
  const parent=table.find(row=>row.pid===journal.pid),expected=journal.processIdentity;
  if(!expected||parent?.state!=='Z'&&parent?.startedAt===expected.startedAt)fail('INSTALL_STILL_ACTIVE','The original installer lifetime still exists or cannot be distinguished. Preserve its acquisition custody.');
  // Read again after proving the launcher stopped: the first enumeration may
  // have begun before it launched a gated worker.
  table=await preparationProcesses(reader);
  for(const command of journal.preparation.commands){
    if(table.some(row=>row.state!=='Z'&&(command.identity?row.pgid===command.identity.pgid:row.lastArgumentSha256===hash(command.token))))fail('INSTALL_PREPARATION_ACTIVE','A retained acquisition worker or process-group member still exists. Let that exact command settle before recovering; no process was signalled.');
  }
}
async function prepareBootstrap(p,bootstrap,previousReceipt,{runtime,npm,ffmpeg,ffprobe}){
  const npmPath=await npmForNode(runtime,npm),tools={nodePath:runtime,browserPath:join(p.browsers,browserQualification.executable),ffmpegPath:await qualifiedTool(ffmpeg,'ffmpeg'),ffprobePath:await qualifiedTool(ffprobe,'ffprobe')};
  // Reuse a receipt-owned exact closure; reinstalling current must not repeat
  // network acquisition or change its content identity.
  for(const owned of previousReceipt?.releases??[]){
    const release=await verifyRelease(owned.path).catch(()=>null);
    if(release?.manifest.bootstrapDigest===bootstrap.digest&&equal((await readJson(join(release.root,'runtime-tools.json')))?.tools,tools))return {release,existingJournal:null};
  }
  await parents(p,p.pending,true);await parents(p,join(p.releases,'probe'),true);
  const id=randomUUID(),stage=join(p.releases,`.preparing-${id}`);
  const readerManifest=await readJson(join(bootstrap.root,'native/process-reader.json')),reader={path:join(bootstrap.root,'native/walkthrough-process-reader'),binarySha256:readerManifest.binarySha256};
  const parent=(await preparationProcesses(reader)).find(row=>row.pid===process.pid&&/^\d+:\d+$/.test(row.startedAt)&&/^[a-f0-9]{64}$/.test(row.commandSha256));
  if(!parent)fail('INSTALL_PROCESS_IDENTITY_UNPROVEN','The installer must establish its exact native process identity before acquisition.');
  const journal={schemaVersion:2,product:'walkthrough',installRoot:p.installRoot,id,pid:process.pid,processIdentity:{pid:parent.pid,pgid:parent.pgid,startedAt:parent.startedAt,commandSha256:parent.commandSha256},phase:'preparing',previousReceipt,nextReceipt:null,outputs:[],preparation:{stage,bootstrapDigest:bootstrap.digest,reader,commands:[]}};
  try{await writeFile(p.pending,JSON.stringify(journal,null,2)+'\n',{flag:'wx',mode:0o600});}catch(error){if(error.code==='EEXIST')fail('INSTALL_RECOVERY_REQUIRED','Recover the existing installation occurrence first.');throw error;}
  try{
    await copyRelease(bootstrap.root,stage);
    const custody={reader,journal,save:()=>atomicJson(p.pending,journal)};
    const release=await prepareRelease({root:stage,runtime,npmPath,home:p.home,tools,custody});
    journal.phase='verifying';
    const destination=join(p.releases,release.id),expected=await fingerprint(stage);
    journal.releaseStage={path:destination,stage,expected,files:await inventory(stage)};
    await atomicJson(p.pending,journal);
    if(await stat(destination))fail('INSTALL_RELEASE_COLLISION','The prepared release destination already exists without this receipt ownership.');
    await rename(stage,destination);
    await browserStore(p);
    await prepareBrowser({root:destination,runtime,browserRoot:p.browsers,home:p.home,custody});
    if(!equal(await fingerprint(destination),expected))fail('INSTALL_RELEASE_CHANGED','Browser acquisition changed the sealed runtime closure. Preserve it for inspection.');
    return {release:await verifyRelease(destination),existingJournal:journal};
  }catch(error){
    // Acquisition may have been interrupted before a complete inventory. Keep
    // its path and the journal; recover never activates an unverified closure.
    error.recovery=`${error.recovery??'Preparation did not establish a complete closure.'} Preserve ${stage} and ${p.pending}. Run check, then recover after this installer exits; recovery restores the predecessor and reports any unsealed preparation.`;
    throw error;
  }
}
export async function installRelease({releasePath,home=homedir(),runtime,npm,ffmpeg,ffprobe,pluginDiscoveryPath}){
  const p=installationPaths(await realpath(home));
  await parents(p,p.pending);if(await stat(p.pending))fail('INSTALL_RECOVERY_REQUIRED','Recover the existing installation occurrence first.');
  const inputRelease=await verifyRelease(releasePath),previousReceipt=await readJson(p.receipt);
  await verifyOwned(p,previousReceipt);await assertIdle(p);
  runtime=await qualifiedNode(runtime);
  const discovery=await pluginDiscovery(pluginDiscoveryPath,p,previousReceipt);
  const {release,existingJournal}=inputRelease.manifest.kind==='bootstrap'?await prepareBootstrap(p,inputRelease,previousReceipt,{runtime,npm,ffmpeg,ffprobe}):{release:inputRelease,existingJournal:null};
  const releaseDestination=join(p.releases,release.id),destinationInfo=await stat(releaseDestination);
  if(destinationInfo){const existing=await verifyRelease(releaseDestination);if(existing.digest!==release.digest)fail('INSTALL_RELEASE_COLLISION','An immutable release path is occupied by different bytes.');}
  const launcher=`#!/bin/sh\n# Owned by the Walkthrough release installer.\nif [ "\${WALKTHROUGH_STATE_ROOT+x}" != x ]; then export WALKTHROUGH_STATE_ROOT=${quote(p.state)}; fi\nif [ "\${WALKTHROUGH_CONFIG_ROOT+x}" != x ]; then export WALKTHROUGH_CONFIG_ROOT=${quote(join(p.home,'.config/walkthrough'))}; fi\nexec ${quote(runtime)} ${quote(join(p.current,'bin/walkthrough.mjs'))} "$@"\n`;
  const desired=[{path:p.current,after:{kind:'link',target:relative(p.installRoot,releaseDestination)}},
    {path:p.launcher,after:{kind:'file',mode:0o755,sha256:hash(launcher)},content:launcher}];
  const releaseFingerprint=await fingerprint(release.root),previousReleases=previousReceipt?.releases??[];
  // Keep the displaced current release, or the last distinct predecessor when
  // reinstalling current. Older receipts appended in first-install order; new
  // receipts normalize that order to predecessor, current, including rollbacks.
  const predecessor=previousReceipt?.releaseId===release.id
    ?previousReleases.findLast(r=>r.id!==release.id)
    :previousReleases.find(r=>r.id===previousReceipt?.releaseId);
  const releases=[...(predecessor?[predecessor]:[]),{id:release.id,path:releaseDestination,fingerprint:releaseFingerprint}];
  const nextReceipt={schemaVersion:3,product:'walkthrough',installRoot:p.installRoot,releaseId:release.id,releaseDigest:release.digest,nodePath:runtime,releases,outputs:desired.map(o=>({path:o.path,fingerprint:o.after})),...(discovery?{pluginDiscovery:discovery}:previousReceipt?.pluginDiscovery?{pluginDiscovery:previousReceipt.pluginDiscovery}:{})};
  if(equal(previousReceipt,nextReceipt))return {schemaVersion:1,status:'installed',changed:false,releaseId:release.id,releasePath:releaseDestination};
  // Retirement uses the same journal and retained backups as publication. A
  // pre-commit interruption restores the old receipt and every old release;
  // only committed cleanup removes the exact receipt-managed obsolete bytes.
  desired.push(...previousReleases.filter(r=>!releases.some(keep=>keep.id===r.id)).map(r=>({path:r.path,after:null})));
  desired.push(...(previousReceipt?.outputs??[]).filter(o=>[p.skill,p.claude].includes(o.path)).map(o=>({path:o.path,after:null})));
  await transact(p,{previousReceipt,nextReceipt,desired,existingJournal,
    releaseStage:destinationInfo?null:{path:releaseDestination,expected:releaseFingerprint,files:await inventory(release.root)},prepare:async journal=>{
    if(!destinationInfo){
      await parents(p,releaseDestination,true);await copyRelease(release.root,journal.releaseStage.stage);
      if((await verifyRelease(journal.releaseStage.stage)).digest!==release.digest)fail('INSTALL_RELEASE_CHANGED','The release changed while being staged.');
      if(await stat(releaseDestination))fail('INSTALL_RELEASE_COLLISION','Another writer occupied the immutable release path.');
      await rename(journal.releaseStage.stage,releaseDestination);
    }
    if((await verifyRelease(releaseDestination)).digest!==release.digest)fail('INSTALL_RELEASE_CHANGED','The release changed while being staged.');
  }});
  return {schemaVersion:1,status:'installed',changed:true,releaseId:release.id,releasePath:releaseDestination,launcher:p.launcher,receiptPath:p.receipt,dependencyAcquisition:inputRelease.manifest.kind==='bootstrap',browserRoot:p.browsers,nativePluginSkillProjectionsCreated:false};
}
export async function checkInstallation({home=homedir()}={}){
  const p=installationPaths(await realpath(home));await parents(p,p.pending);
  const journal=await readJson(p.pending);if(journal){validateJournal(journal,p);return {schemaVersion:1,status:'recovery-required',pending:{id:journal.id,pid:journal.pid,phase:journal.phase,...(journal.preparation?{preparationPath:journal.preparation.stage}:{})},pendingPath:p.pending};}
  const receipt=await readJson(p.receipt);await verifyOwned(p,receipt);
  if(!receipt)return {schemaVersion:1,status:'not-installed',receiptPath:p.receipt};
  return {schemaVersion:1,status:receipt.schemaVersion===1?'source-backed-installation':'installed',releaseId:receipt.releaseId??null,releasePath:receipt.schemaVersion!==1?await realpath(p.current):null,outputs:receipt.outputs,receiptPath:p.receipt};
}
export async function recoverInstallation({home=homedir()}={}){
  const p=installationPaths(await realpath(home));await parents(p,p.pending);const journal=await readJson(p.pending);
  if(!journal)return {schemaVersion:1,status:'nothing-to-recover',changed:false};validateJournal(journal,p);
  if(journal.preparation)await assertPreparationStopped(journal);
  else try{process.kill(journal.pid,0);fail('INSTALL_STILL_ACTIVE','The recorded installer process still exists. Do not recover its active transaction.');}catch(error){if(error.code!=='ESRCH')throw error;}
  await assertIdle(p);await settle(p,journal,journal.phase==='committed');
  return {schemaVersion:1,status:journal.phase==='committed'?'installation-completed':'predecessor-restored',changed:true,...(journal.preparation&&await stat(journal.preparation.stage)?{retainedPreparationPath:journal.preparation.stage}:{})};
}
export async function uninstallRelease({home=homedir()}={}){
  const p=installationPaths(await realpath(home));await parents(p,p.pending);if(await stat(p.pending))fail('INSTALL_RECOVERY_REQUIRED','Recover the current installation transaction first.');
  const previousReceipt=await readJson(p.receipt);await verifyOwned(p,previousReceipt);await assertIdle(p);
  if(!previousReceipt)return {schemaVersion:1,status:'not-installed',changed:false};
  const desired=[...new Set([...outputPaths(p),...receiptOutputPaths(p,previousReceipt)]),...(previousReceipt.releases??[]).map(r=>r.path)].map(path=>({path,after:null}));
  await transact(p,{previousReceipt,nextReceipt:null,desired});
  return {schemaVersion:1,status:'uninstalled',changed:true,removed:desired.map(o=>o.path),preserved:['projects','settings','audio provision and cache','native guidance plugins','product-owned browser cache','external Node, FFmpeg and Voices dependencies']};
}
if(import.meta.main){
  try{
    const args=process.argv.slice(2),command=args.shift();if(!['install','check','recover','uninstall'].includes(command))fail('INVALID_COMMAND',usage);
    const options={};while(args.length){const flag=args.shift(),value=args.shift();if(!['--home','--release','--node','--npm','--ffmpeg','--ffprobe','--plugin-discovery'].includes(flag)||!value||value.startsWith('--')||options[flag])fail('INVALID_COMMAND',usage);options[flag]=resolve(value);}
    if(command!=='install'&&Object.keys(options).some(flag=>flag!=='--home'))fail('INVALID_COMMAND',usage);
    const input={home:options['--home']??homedir(),releasePath:options['--release']??sourceRoot,runtime:options['--node'],npm:options['--npm'],ffmpeg:options['--ffmpeg'],ffprobe:options['--ffprobe'],pluginDiscoveryPath:options['--plugin-discovery']};
    const result=await ({install:installRelease,check:checkInstallation,recover:recoverInstallation,uninstall:uninstallRelease}[command])(input);
    console.log(JSON.stringify(result));if(['recovery-required','not-installed','source-backed-installation'].includes(result.status))process.exitCode=1;
  }catch(error){console.log(JSON.stringify({schemaVersion:1,status:'failed',error:{code:error.code??'INSTALL_IO_FAILED',owner:'installation',recovery:error.recovery??'Preserve the release and installation records. Resolve the exact filesystem failure without replacing foreign outputs.'}}));process.exitCode=1;}
}
