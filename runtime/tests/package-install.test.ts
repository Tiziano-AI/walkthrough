import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,readlink,realpath,rm,rename,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {inputSchemas} from '../src/command-help.ts';
const installer=await import(new URL('../scripts/install-local.mjs',import.meta.url).href);
const files=await import(new URL('../scripts/release-files.mjs',import.meta.url).href);
async function fixture(version='0.2.0'){
  const root=await realpath(await mkdtemp(join(tmpdir(),'walkthrough-package-'))),release=join(root,'release'),home=join(root,'home');
  await mkdir(home);await mkdir(release);
  const entries:Record<string,string>={
    'package.json':JSON.stringify({name:'walkthrough',version,type:'module'}),
    'README.md':'# Walkthrough\n\nPublic installation and authoring contract.\n',
    'package-lock.json':JSON.stringify({name:'walkthrough',version,lockfileVersion:3,packages:{'':{name:'walkthrough',version}}}),
    'bin/walkthrough.mjs':"console.log(JSON.stringify({cwd:process.cwd(),release:import.meta.url,args:process.argv.slice(2),stateRoot:process.env.WALKTHROUGH_STATE_ROOT,configRoot:process.env.WALKTHROUGH_CONFIG_ROOT}));\n",
    'src/cli.ts':'export {};\n',
    'src/command-help.ts':await readFile(new URL('../src/command-help.ts',import.meta.url),'utf8'),
    // Keep the real help module's import closure executable after the original
    // source disappears; a stand-in help module would hide missing payloads.
    'src/audio/provision.ts':await readFile(new URL('../src/audio/provision.ts',import.meta.url),'utf8'),
    'src/core/toolchain.ts':await readFile(new URL('../src/core/toolchain.ts',import.meta.url),'utf8'),
    'src/core/contracts.ts':await readFile(new URL('../src/core/contracts.ts',import.meta.url),'utf8'),
    'src/core/runtime-paths.ts':await readFile(new URL('../src/core/runtime-paths.ts',import.meta.url),'utf8'),
    'scripts/install-local.mjs':await readFile(new URL('../scripts/install-local.mjs',import.meta.url),'utf8'),
    'scripts/release-files.mjs':await readFile(new URL('../scripts/release-files.mjs',import.meta.url),'utf8'),
    'scripts/prepare-release.mjs':await readFile(new URL('../scripts/prepare-release.mjs',import.meta.url),'utf8'),
    'scripts/provision-renderer.ts':'export {};\n',
    'scripts/loopback-only.sb':'(version 1)\n',
    'scripts/provision-session.mjs':'export {};\n','src/session/native/process-reader.c':'/* Synthetic package fixture; never executed. */\n',
    'native/walkthrough-process-reader':'Synthetic package fixture; never executed.\n',
    'skills/walkthrough/SKILL.md':'---\nname: walkthrough\ndescription: "Create films"\n---\nRelease skill\n'};
  for(const name of files.requiredInputSchemas)entries[`docs/schemas/${name}.schema.json`]=JSON.stringify({$schema:'https://json-schema.org/draft/2020-12/schema',$id:`urn:walkthrough:input:${name}:1`,type:'object'});
  for(const [path,text] of Object.entries(entries)){await mkdir(dirname(join(release,path)),{recursive:true});await writeFile(join(release,path),text);}
  await chmod(join(release,'bin/walkthrough.mjs'),0o755);
  await chmod(join(release,'native/walkthrough-process-reader'),0o755);
  await writeFile(join(release,'native/process-reader.json'),JSON.stringify({schemaVersion:1,platform:'darwin',arch:'arm64',sourceSha256:files.hash(entries['src/session/native/process-reader.c']),binarySha256:files.hash(entries['native/walkthrough-process-reader'])}));
  const inventory=await files.inventory(release);
  await writeFile(join(release,'release.json'),JSON.stringify({schemaVersion:2,kind:'prepared',bootstrapDigest:files.hash('Synthetic bootstrap identity'),product:'walkthrough',version,platform:'darwin',arch:'arm64',source:files.releaseSource(inventory),files:inventory})+'\n');
  return {root,release,home,cleanup:()=>rm(root,{recursive:true,force:true})};
}
async function bootstrapFixture(mode='success'){
  const f=await fixture('0.4.0'),manifestPath=join(f.release,'release.json'),log=join(f.root,'acquisition.jsonl'),npm=join(f.root,'npm-cli.mjs');
  // Exercise real native process identity, while replacing only upstream
  // acquisition with a local npm-shaped fixture. Nothing accesses the network.
  for(const path of ['src/session/native/process-reader.c','native/walkthrough-process-reader','native/process-reader.json'])await writeFile(join(f.release,path),await readFile(new URL('../'+path,import.meta.url)));
  await chmod(join(f.release,'native/walkthrough-process-reader'),0o755);
  const lock=JSON.parse(await readFile(join(f.release,'package-lock.json'),'utf8'));
  for(const name of files.nativePackages)lock.packages[`node_modules/${name}`]={version:'1.0.0',optional:true,integrity:'sha512-synthetic-fixture'};
  await writeFile(join(f.release,'package-lock.json'),JSON.stringify(lock));
  const browserScript=`import {mkdir,writeFile,chmod,appendFile} from 'node:fs/promises';import {join,dirname} from 'node:path';
    await appendFile(${JSON.stringify(log)},JSON.stringify({command:'browser',cwd:process.cwd(),args:process.argv.slice(2),root:process.env.PLAYWRIGHT_BROWSERS_PATH})+'\\n');
    const target=join(process.env.PLAYWRIGHT_BROWSERS_PATH,${JSON.stringify(files.browserQualification.executable)});await mkdir(dirname(target),{recursive:true});await writeFile(target,'Synthetic browser; never executed.');await chmod(target,0o755);`;
  await writeFile(npm,`import {mkdir,writeFile,appendFile} from 'node:fs/promises';import {join} from 'node:path';
    if(process.argv.includes('--version')){console.log('11.0.0');process.exit(0);}
    await appendFile(${JSON.stringify(log)},JSON.stringify({command:'npm',cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');
    if(${JSON.stringify(mode)}==='failure')process.exit(71);
    if(${JSON.stringify(mode)}==='hold'){while(!await import('node:fs/promises').then(fs=>fs.stat(${JSON.stringify(join(f.root,'continue'))}).then(()=>true,()=>false)))await new Promise(resolve=>setTimeout(resolve,20));}
    for(const name of ${JSON.stringify(files.nativePackages)}){const root=join(process.cwd(),'node_modules',name);await mkdir(root,{recursive:true});await writeFile(join(root,'package.json'),JSON.stringify({name,version:'1.0.0'}));}
    const core=join(process.cwd(),'node_modules/playwright-core'),pw=join(process.cwd(),'node_modules/playwright');await mkdir(core,{recursive:true});await mkdir(pw,{recursive:true});
    await writeFile(join(core,'package.json'),JSON.stringify({version:'1.63.0'}));await writeFile(join(core,'browsers.json'),JSON.stringify({browsers:[{name:'chromium',revision:'1243',browserVersion:'153.0.8010.12'}]}));
    await writeFile(join(pw,'package.json'),JSON.stringify({type:'module'}));await writeFile(join(pw,'cli.js'),${JSON.stringify(browserScript)});
  `);
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));delete manifest.bootstrapDigest;manifest.kind='bootstrap';manifest.files=await files.inventory(f.release,{exclude:['release.json']});manifest.source=files.releaseSource(manifest.files);await writeFile(manifestPath,JSON.stringify(manifest));
  return {...f,npm,log};
}
test('explicit bootstrap preparation seals dependencies and registers the stable package path before activation',async()=>{
  const f=await bootstrapFixture();try{
    const stableDirectory=join(f.root,'selected-tools','bin'),selected:Record<string,string>={},oldTargets:Record<string,string>={};
    const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
    const body=(name:string)=>name==='node'?`exec ${quote(process.execPath)} "$@"\n`:`printf '%s\\n' '${name} version synthetic'\n`;
    await mkdir(stableDirectory,{recursive:true});
    for(const name of ['node','ffmpeg','ffprobe']){
      const target=join(f.root,`${name}-first`),path=join(stableDirectory,name);
      await writeFile(target,`#!/bin/sh\n# First synthetic prerequisite.\n${body(name)}`,{mode:0o755});
      await symlink(target,path);selected[name]=path;oldTargets[name]=target;
    }
    const input={releasePath:f.release,home:f.home,runtime:`${stableDirectory}/./node`,npm:f.npm,ffmpeg:`${stableDirectory}/./ffmpeg`,ffprobe:selected.ffprobe};
    const bootstrap=await files.verifyRelease(f.release),result=await installer.installRelease(input);
    const release=await files.verifyRelease(result.releasePath),p=installer.installationPaths(f.home);
    assert.equal(release.manifest.kind,'prepared');assert.equal(release.manifest.bootstrapDigest,bootstrap.digest);
    assert.ok(release.manifest.files.some((entry:{path:string})=>entry.path.startsWith('node_modules/')));
    const commands=(await readFile(f.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(commands[0].args,['ci','--omit=dev','--include=optional','--ignore-scripts','--no-audit','--no-fund']);
    assert.equal(commands[1].cwd,result.releasePath,'Playwright must register the stable final package, never staging.');
    assert.equal(commands[1].root,p.browsers);assert.deepEqual(commands[1].args,['install','chromium','--no-shell']);
    const tools=JSON.parse(await readFile(join(result.releasePath,'runtime-tools.json'),'utf8'));
    assert.deepEqual(tools.tools,{nodePath:selected.node,browserPath:join(p.browsers,files.browserQualification.executable),ffmpegPath:selected.ffmpeg,ffprobePath:selected.ffprobe});
    assert.equal(JSON.parse(await readFile(p.receipt,'utf8')).nodePath,selected.node);
    assert.ok((await readFile(p.launcher,'utf8')).includes(`exec ${quote(selected.node)} `));
    // Simulate an operator-managed prerequisite upgrade, then remove the exact
    // old targets. The retained paths must keep invoking their new referents.
    for(const name of ['node','ffmpeg','ffprobe']){
      const replacement=join(f.root,`${name}-replacement`);
      await writeFile(replacement,`#!/bin/sh\n# Replacement synthetic prerequisite.\n${body(name)}`,{mode:0o755});
      await rm(selected[name]);await symlink(replacement,selected[name]);await rm(oldTargets[name]);
    }
    const launched=spawnSync(p.launcher,['--version','--json'],{cwd:f.root,encoding:'utf8'});
    assert.equal(launched.status,0,launched.stderr);assert.deepEqual(JSON.parse(launched.stdout).args,['--version','--json']);
    for(const name of ['ffmpeg','ffprobe'])assert.equal(spawnSync(tools.tools[`${name}Path`],['-version'],{encoding:'utf8'}).stdout,`${name} version synthetic\n`);
    assert.equal((await installer.installRelease(input)).changed,false);
    assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,2,'Current exact reinstall does not reacquire.');
    assert.equal(await files.stat(p.skill),null);assert.equal(await files.stat(p.claude),null);
  }finally{await f.cleanup();}
});
test('install requires an explicit Node invocation path instead of persisting process.execPath',async()=>{
  const f=await fixture();try{
    await assert.rejects(installer.installRelease({releasePath:f.release,home:f.home}),{code:'INSTALL_NODE_SELECTION_REQUIRED'});
    const child=spawnSync(process.execPath,[new URL('../scripts/install-local.mjs',import.meta.url).pathname,'install','--release',f.release,'--home',f.home],{encoding:'utf8'});
    assert.equal(child.status,1,child.stderr);
    const response=JSON.parse(child.stdout);assert.equal(response.error.code,'INSTALL_NODE_SELECTION_REQUIRED');assert.match(response.error.recovery,/--node <absolute-invocation-path>/);
    const p=installer.installationPaths(f.home);
    for(const path of [p.pending,p.receipt,p.launcher,p.current])assert.equal(await files.stat(path),null);
  }finally{await f.cleanup();}
});
test('failed explicit acquisition cannot activate and retains one journal for inspectable recovery',async()=>{
  const f=await bootstrapFixture('failure');try{
    const child=spawnSync(process.execPath,[new URL('../scripts/install-local.mjs',import.meta.url).pathname,'install','--release',f.release,'--home',f.home,'--node',process.execPath,'--npm',f.npm],{encoding:'utf8'});
    assert.equal(child.status,1,child.stderr);assert.equal(JSON.parse(child.stdout).error.code,'INSTALL_PREPARATION_FAILED');
    const p=installer.installationPaths(f.home),check=await installer.checkInstallation({home:f.home});
    assert.equal(check.pending.phase,'preparing');assert.equal(await files.stat(p.current),null);assert.equal(await files.stat(p.launcher),null);
    const journal=JSON.parse(await readFile(p.pending,'utf8'));assert.ok(journal.preparation.commands[0].identity.startedAt);
    const recovered=await installer.recoverInstallation({home:f.home});assert.equal(recovered.status,'predecessor-restored');
    assert.equal(recovered.retainedPreparationPath,journal.preparation.stage);assert.ok(await files.stat(recovered.retainedPreparationPath));
    assert.equal(await files.stat(p.pending),null);assert.equal((await installer.checkInstallation({home:f.home})).status,'not-installed');
  }finally{await f.cleanup();}
});
test('recovery refuses a surviving acquisition group after its installer is interrupted',async()=>{
  const f=await bootstrapFixture('hold');let child:ReturnType<typeof spawn>|undefined;
  try{
    child=spawn(process.execPath,[new URL('../scripts/install-local.mjs',import.meta.url).pathname,'install','--release',f.release,'--home',f.home,'--node',process.execPath,'--npm',f.npm],{stdio:'ignore'});
    const stopped=new Promise(resolve=>child!.once('close',resolve));
    for(let attempt=0;!await files.stat(f.log)&&attempt<150;attempt++)await delay(20);
    assert.ok(await files.stat(f.log),'The actual gated npm worker must enter its local acquisition fixture.');
    const p=installer.installationPaths(f.home),journal=JSON.parse(await readFile(p.pending,'utf8'));
    assert.equal(journal.preparation.commands[0].status,'running');assert.ok(journal.preparation.commands[0].identity.startedAt);
    child.kill('SIGKILL');await stopped;
    await assert.rejects(installer.recoverInstallation({home:f.home}),{code:'INSTALL_PREPARATION_ACTIVE'});
    assert.ok(await files.stat(p.pending));assert.equal(await files.stat(p.current),null);
    await writeFile(join(journal.preparation.stage,'unsealed-review-note'),'A contribution in the interrupted preparation must survive recovery.');
    await writeFile(join(f.root,'continue'),'continue');
    let result;
    for(let attempt=0;attempt<150;attempt++){
      try{result=await installer.recoverInstallation({home:f.home});break;}catch(error){if((error as {code:string}).code!=='INSTALL_PREPARATION_ACTIVE')throw error;await delay(20);}
    }
    assert.equal(result?.status,'predecessor-restored');assert.equal(result.retainedPreparationPath,journal.preparation.stage);
    assert.equal(await readFile(join(result.retainedPreparationPath,'unsealed-review-note'),'utf8'),'A contribution in the interrupted preparation must survive recovery.');
  }finally{await writeFile(join(f.root,'continue'),'continue');child?.kill('SIGKILL');await delay(100);await f.cleanup();}
});
async function historicalInstallation(){
  const releases:Awaited<ReturnType<typeof fixture>>[]=[];
  try{
    for(const version of ['0.2.0','0.2.1','0.2.2'])releases.push(await fixture(version));
    const current=releases.at(-1)!,home=releases[0]!.home,p=installer.installationPaths(home);
    await installer.installRelease({releasePath:current.release,home,runtime:process.execPath});
    const receipt=JSON.parse(await readFile(p.receipt,'utf8'));
    // The previous installer appended releases in first-install order without
    // retiring them. Reproduce its receipt and exact bytes, not a second installer.
    receipt.releases=[];
    for(const source of releases){
      const release=await files.verifyRelease(source.release),path=join(p.releases,release.id);
      if(source!==current)await files.copyRelease(source.release,path);
      receipt.releases.push({id:release.id,path,fingerprint:await files.fingerprint(path)});
    }
    await writeFile(p.receipt,JSON.stringify(receipt,null,2)+'\n');
    return {home,p,current,receipt,cleanup:async()=>{for(const release of releases)await release.cleanup();}};
  }catch(error){for(const release of releases)await release.cleanup();throw error;}
}
async function assertRetainedReleases(home:string,ids:string[]){
  const p=installer.installationPaths(home),receipt=JSON.parse(await readFile(p.receipt,'utf8'));
  assert.deepEqual(receipt.releases.map((release:{id:string})=>release.id),ids);
  assert.deepEqual((await readdir(p.releases)).sort(),[...ids].sort(),'No retired release or transaction scratch remains.');
  assert.equal(receipt.releaseId,ids.at(-1));
  assert.equal(await realpath(p.current),join(p.releases,ids.at(-1)!));
  assert.equal((await installer.checkInstallation({home})).status,'installed');
  assert.equal(await files.stat(p.pending),null);
}
type RetirementInterruption='before-retirement'|'after-retirement'|'before-commit'|'committed'|'during-cleanup';
async function interruptRetirement(f:Awaited<ReturnType<typeof historicalInstallation>>,releasePath:string,boundary:RetirementInterruption){
  const obsoletePath=f.receipt.releases[0].path;
  // Interrupt the real installer after the actual filesystem operation, without
  // adding production test hooks or fabricating its recovery journal.
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    const boundary=${JSON.stringify(boundary)},obsoletePath=${JSON.stringify(obsoletePath)};
    const rename=fs.rename,rm=fs.rm;
    fs.rename=async(from,to)=>{
      if(boundary==='before-retirement'&&from===obsoletePath)process.exit(93);
      await rename(from,to);
      if(boundary==='after-retirement'&&from===obsoletePath
        ||boundary==='before-commit'&&to===${JSON.stringify(f.p.receipt)}
        ||boundary==='committed'&&to===${JSON.stringify(f.p.pending)})process.exit(93);
    };
    fs.rm=async(path,options)=>{
      await rm(path,options);
      if(boundary==='during-cleanup'&&path.startsWith(obsoletePath+'.previous-'))process.exit(93);
    };
    syncBuiltinESMExports();
    const {installRelease}=await import(${JSON.stringify(new URL('../scripts/install-local.mjs',import.meta.url).href)});
    await installRelease({releasePath:${JSON.stringify(releasePath)},home:${JSON.stringify(f.home)},runtime:process.execPath});
  `],{cwd:f.current.root,encoding:'utf8',timeout:30000});
  assert.equal(child.status,93,child.stderr||'The real installer must reach the intended retirement boundary.');
  return JSON.parse(await readFile(f.p.pending,'utf8'));
}
test('successive updates retain only current and immediate predecessor, including a switch back',async()=>{
  const first=await fixture(),second=await fixture('0.2.1'),third=await fixture('0.2.2'),fourth=await fixture('0.2.3');
  try{
    const ids=[];
    for(const release of [first,second,third,fourth]){
      ids.push((await installer.installRelease({releasePath:release.release,home:first.home,runtime:process.execPath})).releaseId);
      await assertRetainedReleases(first.home,ids.slice(-2));
    }
    await installer.installRelease({releasePath:third.release,home:first.home,runtime:process.execPath});
    await assertRetainedReleases(first.home,[ids[3],ids[2]]);
    assert.equal((await installer.installRelease({releasePath:third.release,home:first.home,runtime:process.execPath})).changed,false);
    await assertRetainedReleases(first.home,[ids[3],ids[2]]);
  }finally{for(const release of [first,second,third,fourth])await release.cleanup();}
});
test('reinstalling current prunes historical releases and keeps its last distinct predecessor',async()=>{
  const f=await historicalInstallation();try{
    const result=await installer.installRelease({releasePath:f.current.release,home:f.home,runtime:process.execPath});
    assert.equal(result.changed,true);
    await assertRetainedReleases(f.home,f.receipt.releases.slice(-2).map((release:{id:string})=>release.id));
    assert.equal((await installer.installRelease({releasePath:f.current.release,home:f.home,runtime:process.execPath})).changed,false);
  }finally{await f.cleanup();}
});
test('retirement refuses a changed managed release and leaves unreceipted releases untouched',async()=>{
  const f=await historicalInstallation(),foreign=await fixture('0.1.9');try{
    const obsolete=f.receipt.releases[0],changedPath=join(obsolete.path,'src/cli.ts'),original=await readFile(changedPath);
    await writeFile(changedPath,'Foreign edits in a retirement candidate.\n');
    const before=await files.fingerprint(f.p.installRoot),receiptBefore=await readFile(f.p.receipt,'utf8');
    await assert.rejects(installer.installRelease({releasePath:f.current.release,home:f.home,runtime:process.execPath}),{code:'INSTALL_RELEASE_CHANGED'});
    assert.deepEqual(await files.fingerprint(f.p.installRoot),before);
    assert.equal(await readFile(f.p.receipt,'utf8'),receiptBefore);
    assert.equal(await files.stat(f.p.pending),null);
    await writeFile(changedPath,original);
    const foreignRelease=await files.verifyRelease(foreign.release),foreignPath=join(f.p.releases,foreignRelease.id);
    await files.copyRelease(foreign.release,foreignPath);
    const foreignBefore=await files.fingerprint(foreignPath);
    await installer.installRelease({releasePath:f.current.release,home:f.home,runtime:process.execPath});
    assert.deepEqual(await files.fingerprint(foreignPath),foreignBefore);
    assert.equal(await files.stat(obsolete.path),null);
    const receipt=JSON.parse(await readFile(f.p.receipt,'utf8'));
    assert.deepEqual(receipt.releases.map((release:{id:string})=>release.id),f.receipt.releases.slice(-2).map((release:{id:string})=>release.id));
  }finally{await f.cleanup();await foreign.cleanup();}
});
test('retirement never adopts release changes between ownership admission and transaction staging',async()=>{
  const f=await historicalInstallation();try{
    const changedPath=join(f.receipt.releases[0].path,'src/cli.ts'),receiptBefore=await readFile(f.p.receipt,'utf8');
    const child=spawnSync(process.execPath,['--input-type=module','-e',`
      import fs from 'node:fs/promises';
      import {syncBuiltinESMExports} from 'node:module';
      const readFile=fs.readFile;
      fs.readFile=async(path,...options)=>{
        const result=await readFile(path,...options);
        if(path===${JSON.stringify(join(f.p.releases,f.receipt.releaseId,'release.json'))})await fs.writeFile(${JSON.stringify(changedPath)},'Concurrent foreign edit.\\n');
        return result;
      };
      syncBuiltinESMExports();
      const {installRelease}=await import(${JSON.stringify(new URL('../scripts/install-local.mjs',import.meta.url).href)});
      try{await installRelease({releasePath:${JSON.stringify(f.current.release)},home:${JSON.stringify(f.home)},runtime:process.execPath});}
      catch(error){console.log(error.code);}
    `],{cwd:f.current.root,encoding:'utf8',timeout:30000});
    assert.equal(child.status,0,child.stderr);
    assert.equal(child.stdout.trim(),'INSTALL_RELEASE_CHANGED');
    assert.equal(await readFile(changedPath,'utf8'),'Concurrent foreign edit.\n');
    assert.equal(await readFile(f.p.receipt,'utf8'),receiptBefore);
    assert.equal(await files.stat(f.p.pending),null);
  }finally{await f.cleanup();}
});
test('active work blocks same-current retirement without changing releases or receipt',async()=>{
  const f=await historicalInstallation();try{
    await mkdir(f.p.active,{recursive:true});
    const marker=join(f.p.active,'author.json'),before=await files.fingerprint(f.p.installRoot),receiptBefore=await readFile(f.p.receipt,'utf8');
    for(const activity of [{schemaVersion:1,kind:'command',pid:process.pid},{schemaVersion:1,kind:'session',status:'open',pid:2147483647}]){
      await writeFile(marker,JSON.stringify(activity));
      await assert.rejects(installer.installRelease({releasePath:f.current.release,home:f.home,runtime:process.execPath}),{code:'INSTALL_ACTIVE_WORK'});
      assert.deepEqual(await files.fingerprint(f.p.installRoot),before);
      assert.equal(await readFile(f.p.receipt,'utf8'),receiptBefore);
      assert.equal(await files.stat(f.p.pending),null);
    }
  }finally{await f.cleanup();}
});
for(const boundary of ['before-retirement','after-retirement','before-commit','committed','during-cleanup'] as const){
  test(`release retirement recovers an installer interrupted ${boundary}`,async()=>{
    const f=await historicalInstallation(),next=await fixture('0.2.3');try{
      const before=await files.fingerprint(f.p.installRoot),nextRelease=await files.verifyRelease(next.release);
      const journal=await interruptRetirement(f,next.release,boundary),committed=['committed','during-cleanup'].includes(boundary);
      assert.equal(journal.phase,committed?'committed':'applying');
      assert.deepEqual(journal.previousReceipt,f.receipt);
      assert.deepEqual(journal.outputs.filter((output:{after:unknown})=>output.after===null).map((output:{path:string})=>output.path),f.receipt.releases.slice(0,-1).map((release:{path:string})=>release.path));
      assert.equal((await installer.checkInstallation({home:f.home})).status,'recovery-required');
      assert.equal((await installer.recoverInstallation({home:f.home})).status,committed?'installation-completed':'predecessor-restored');
      if(committed)await assertRetainedReleases(f.home,[f.receipt.releaseId,nextRelease.id]);
      else{
        assert.deepEqual(await files.fingerprint(f.p.installRoot),before,'Rollback restores exact old release bytes and output links, with no new release or scratch.');
        assert.deepEqual(JSON.parse(await readFile(f.p.receipt,'utf8')),f.receipt);
        assert.equal((await installer.checkInstallation({home:f.home})).status,'installed');
        assert.equal(await files.stat(f.p.pending),null);
      }
      assert.equal((await installer.recoverInstallation({home:f.home})).status,'nothing-to-recover');
    }finally{await f.cleanup();await next.cleanup();}
  });
}
test('retirement recovery preserves a changed predecessor backup until its exact bytes are restored',async()=>{
  const f=await historicalInstallation(),next=await fixture('0.2.3');try{
    const before=await files.fingerprint(f.p.installRoot),journal=await interruptRetirement(f,next.release,'after-retirement');
    const retired=journal.outputs.find((output:{path:string})=>output.path===f.receipt.releases[0].path),path=join(retired.backup,'src/cli.ts');
    const original=await readFile(path);await writeFile(path,'Changed retained predecessor.\n');
    await assert.rejects(installer.recoverInstallation({home:f.home}),{code:'INSTALL_RECOVERY_COLLISION'});
    assert.equal(await readFile(path,'utf8'),'Changed retained predecessor.\n');
    assert.ok(await files.stat(f.p.pending));
    await writeFile(path,original);
    assert.equal((await installer.recoverInstallation({home:f.home})).status,'predecessor-restored');
    assert.deepEqual(await files.fingerprint(f.p.installRoot),before);
  }finally{await f.cleanup();await next.cleanup();}
});
test('release installation relocates runtime without native skill projections, preserves cwd and uninstalls only owned bytes',async()=>{
  const f=await fixture(),next=await fixture('0.2.1');
  try{
    const installed=await installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath});
    assert.equal(installed.status,'installed');
    const p=installer.installationPaths(f.home);
    assert.equal(await files.stat(p.skill),null);assert.equal(await files.stat(p.claude),null);
    assert.equal(await realpath(p.current),installed.releasePath);
    await rename(f.release,join(f.root,'unavailable-source'));
    assert.match(await readFile(join(installed.releasePath,'README.md'),'utf8'),/^# Walkthrough/);
    const cleanEnvironment={...process.env};delete cleanEnvironment.WALKTHROUGH_STATE_ROOT;delete cleanEnvironment.WALKTHROUGH_CONFIG_ROOT;
    const observed=spawnSync(p.launcher,['--version','--json'],{cwd:f.root,encoding:'utf8',env:cleanEnvironment});
    assert.equal(observed.status,0,observed.stderr);
    const output=JSON.parse(observed.stdout);assert.equal(output.cwd,f.root);assert.ok(output.release.includes(installed.releasePath));
    assert.equal(output.stateRoot,p.state);assert.equal(output.configRoot,join(f.home,'.config/walkthrough'));
    const selectedState=join(f.root,'selected-state'),selectedConfig=join(f.root,'selected-config');
    const overridden=spawnSync(p.launcher,['--version','--json'],{cwd:f.root,encoding:'utf8',env:{...cleanEnvironment,WALKTHROUGH_STATE_ROOT:selectedState,WALKTHROUGH_CONFIG_ROOT:selectedConfig}});
    assert.equal(overridden.status,0,overridden.stderr);
    const selected=JSON.parse(overridden.stdout);assert.equal(selected.cwd,f.root);assert.ok(selected.release.includes(installed.releasePath));
    assert.equal(selected.stateRoot,selectedState);assert.equal(selected.configRoot,selectedConfig);
    const help=spawnSync(process.execPath,['--input-type=module','-e',`import {inputSchemas} from ${JSON.stringify(pathToFileURL(join(installed.releasePath,'src/command-help.ts')).href)};console.log(JSON.stringify(inputSchemas()));`],{cwd:f.root,encoding:'utf8'});
    assert.equal(help.status,0,help.stderr);
    const schemas=JSON.parse(help.stdout);assert.deepEqual(Object.keys(schemas),files.requiredInputSchemas);
    for(const [name,path] of Object.entries(schemas)){
      assert.equal(path,join(installed.releasePath,'docs/schemas',`${name}.schema.json`));
      assert.equal(JSON.parse(await readFile(path as string,'utf8')).$id,`urn:walkthrough:input:${name}:1`);
    }
    assert.equal((await installer.checkInstallation({home:f.home})).status,'installed');
    const keep=join(p.state,'audio/provision.json');await mkdir(dirname(keep),{recursive:true});await writeFile(keep,'owned settings');
    await installer.installRelease({releasePath:next.release,home:f.home,runtime:process.execPath});
    assert.notEqual(await realpath(p.current),installed.releasePath);
    assert.equal((await installer.uninstallRelease({home:f.home})).status,'uninstalled');
    assert.equal(await readFile(keep,'utf8'),'owned settings');
    assert.equal(await files.stat(installed.releasePath),null);
    assert.equal(await files.stat(p.launcher),null);
  }finally{await f.cleanup();await next.cleanup();}
});
test('foreign outputs, changed releases and changed launchers are never replaced',async()=>{
  const f=await fixture();try{
    const p=installer.installationPaths(f.home);await mkdir(dirname(p.launcher),{recursive:true});await writeFile(p.launcher,'foreign');
    await assert.rejects(installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath}),{code:'INSTALL_TARGET_CHANGED'});
    assert.equal(await readFile(p.launcher,'utf8'),'foreign');await rm(p.launcher);
    const result=await installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath});
    await writeFile(join(result.releasePath,'src/cli.ts'),'changed');
    await assert.rejects(installer.uninstallRelease({home:f.home}),{code:'INSTALL_RELEASE_CHANGED'});
    assert.ok(await files.stat(p.launcher));
  }finally{await f.cleanup();}
});
test('a new runtime installation preserves native and foreign global skill ownership',async()=>{
  const f=await fixture();try{
    const p=installer.installationPaths(f.home);
    for(const path of [p.skill,p.claude]){await mkdir(path,{recursive:true});await writeFile(join(path,'SKILL.md'),'A native host or another installer owns this skill.');}
    const before=await Promise.all([p.skill,p.claude].map(path=>files.fingerprint(path)));
    await installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath});
    await installer.uninstallRelease({home:f.home});
    assert.deepEqual(await Promise.all([p.skill,p.claude].map(path=>files.fingerprint(path))),before);
  }finally{await f.cleanup();}
});
test('installed check invoked through the current symlink emits its JSON result',async()=>{
  const f=await fixture();try{
    const installed=await installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath});
    const p=installer.installationPaths(f.home);
    await rename(f.release,join(f.root,'unavailable-source'));
    const checked=spawnSync(process.execPath,[join(p.current,'scripts/install-local.mjs'),'check','--home',f.home],{cwd:f.root,encoding:'utf8'});
    assert.equal(checked.status,0,checked.stderr);
    assert.notEqual(checked.stdout.trim(),'','The installed check must not silently skip its entry point through current.');
    const result=JSON.parse(checked.stdout);
    assert.equal(result.schemaVersion,1);assert.equal(result.status,'installed');
    assert.equal(result.releaseId,installed.releaseId);assert.equal(result.releasePath,installed.releasePath);
    assert.equal(result.receiptPath,p.receipt);
  }finally{await f.cleanup();}
});
test('source-backed installation admits its exact legacy receipt without accepting unknown skill files',async()=>{
  const f=await fixture();try{
    const p=installer.installationPaths(f.home);
    for(const path of [p.skill,dirname(p.launcher),dirname(p.claude),p.state])await mkdir(path,{recursive:true});
    await writeFile(join(p.skill,'SKILL.md'),'The installed source-backed skill.\n');
    await writeFile(p.launcher,'The installed source-backed launcher.\n',{mode:0o755});
    await symlink('../../.agents/skills/walkthrough',p.claude);
    const outputs=[];
    for(const path of [p.skill,p.launcher,p.claude]){
      const fingerprint=await files.fingerprint(path);
      if(fingerprint.kind==='directory')fingerprint.sha256=files.hash(JSON.stringify((await files.inventory(path)).map((e:{path:string;kind:string;mode:number;sha256?:string})=>e.kind==='file'?{path:e.path,kind:e.kind,mode:e.mode,sha256:e.sha256}:e)));
      outputs.push({path,fingerprint});
    }
    const receipt={schemaVersion:1,product:'walkthrough',repositoryRoot:join(f.root,'old-source'),nodePath:'/opt/homebrew/opt/node@24/bin/node',outputs};
    await writeFile(p.receipt,JSON.stringify(receipt));
    await writeFile(join(p.skill,'.DS_Store'),'Finder metadata omitted by the previous installer');
    assert.equal((await installer.checkInstallation({home:f.home})).status,'source-backed-installation');
    await writeFile(join(p.skill,'unknown.md'),'Unknown contribution');
    await assert.rejects(installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath}),{code:'INSTALL_TARGET_CHANGED'});
    assert.equal(await readFile(join(p.skill,'unknown.md'),'utf8'),'Unknown contribution');
    await rm(join(p.skill,'unknown.md'));
    await assert.rejects(installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath}),{code:'INSTALL_PLUGIN_DISCOVERY_REQUIRED'});
    const hosts:Record<string,unknown>={};
    for(const host of ['codex','claude']){
      const pluginRoot=join(f.root,host),skillPath=join(pluginRoot,'skills/walkthrough'),manifestPath=join(pluginRoot,host==='codex'?'plugin.json':'.claude-plugin/plugin.json');
      await mkdir(skillPath,{recursive:true});await mkdir(dirname(manifestPath),{recursive:true});
      await writeFile(join(skillPath,'SKILL.md'),'Native plugin discovery qualification fixture.\n');
      const manifest=JSON.stringify({name:'walkthrough',version:'0.4.0'});await writeFile(manifestPath,manifest);
      hosts[host]={pluginRoot,skillPath,manifestSha256:files.hash(manifest)};
    }
    const pluginDiscoveryPath=join(f.root,'host-qualification.json');await writeFile(pluginDiscoveryPath,JSON.stringify({schemaVersion:1,hosts}));
    const codexManifest=join(f.root,'codex/plugin.json'),qualifiedManifest=await readFile(codexManifest);
    await writeFile(codexManifest,JSON.stringify({name:'walkthrough',version:'changed-after-qualification'}));
    await assert.rejects(installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath,pluginDiscoveryPath}),{code:'INSTALL_PLUGIN_DISCOVERY_CHANGED'});
    assert.ok(await files.stat(p.skill));assert.ok(await files.stat(p.claude));
    await writeFile(codexManifest,qualifiedManifest);
    assert.equal((await installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath,pluginDiscoveryPath})).status,'installed');
    assert.equal((await installer.checkInstallation({home:f.home})).status,'installed');
    assert.equal(await files.stat(p.skill),null);assert.equal(await files.stat(p.claude),null);
  }finally{await f.cleanup();}
});
test('active command and unresolved session block update even when session pid is absent',async()=>{
  const f=await fixture();try{
    const p=installer.installationPaths(f.home);await mkdir(p.active,{recursive:true});
    const marker=join(p.active,'session.json');
    await writeFile(marker,JSON.stringify({schemaVersion:1,kind:'command',pid:process.pid}));
    await assert.rejects(installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath}),{code:'INSTALL_ACTIVE_WORK'});
    await writeFile(marker,JSON.stringify({schemaVersion:1,kind:'session',status:'open',pid:2147483647}));
    await assert.rejects(installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath}),{code:'INSTALL_ACTIVE_WORK'});
    await writeFile(marker,JSON.stringify({schemaVersion:1,kind:'command',pid:2147483647,coordinatorPid:process.pid,processGroupIds:[]}));
    await assert.rejects(installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath}),{code:'INSTALL_ACTIVE_WORK'});
    const ownGroup=Number(execFileSync('/bin/ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim());
    await writeFile(marker,JSON.stringify({schemaVersion:1,kind:'command',pid:2147483647,status:'recovery-required',processGroupIds:[ownGroup]}));
    await assert.rejects(installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath}),{code:'INSTALL_ACTIVE_WORK'});
    await writeFile(marker,JSON.stringify({schemaVersion:1,kind:'command',pid:2147483647,status:'recovery-required',processGroupIds:[2147483647]}));
    assert.equal((await installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath})).status,'installed');
    await writeFile(marker,JSON.stringify({schemaVersion:1,kind:'session',status:'closed',pid:2147483647}));
    assert.equal((await installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath})).status,'installed');
  }finally{await f.cleanup();}
});
test('release admission requires public installation documentation rather than a private roadmap',async()=>{
  const f=await fixture();try{
    await rm(join(f.release,'README.md'));
    const manifest=JSON.parse(await readFile(join(f.release,'release.json'),'utf8'));
    manifest.files=await files.inventory(f.release,{exclude:['release.json']});
    manifest.source=files.releaseSource(manifest.files);
    await writeFile(join(f.release,'release.json'),JSON.stringify(manifest));
    await assert.rejects(files.verifyRelease(f.release),{code:'RELEASE_INCOMPLETE',recovery:'The release lacks README.md. Rebuild the release package.'});
  }finally{await f.cleanup();}
});
test('release admission requires the explicit dependency preparer even when the remaining inventory matches',async()=>{
  const f=await fixture();try{
    await rm(join(f.release,'scripts/prepare-release.mjs'));
    const manifest=JSON.parse(await readFile(join(f.release,'release.json'),'utf8'));
    manifest.files=await files.inventory(f.release,{exclude:['release.json']});
    await writeFile(join(f.release,'release.json'),JSON.stringify(manifest));
    await assert.rejects(files.verifyRelease(f.release),{code:'RELEASE_INCOMPLETE'});
  }finally{await f.cleanup();}
});
test('release schema requirements match all seven public help contracts',async()=>{
  const schemas=inputSchemas();
  assert.equal(Object.keys(schemas).length,7);assert.deepEqual(Object.keys(schemas),files.requiredInputSchemas);
  for(const [name,path] of Object.entries(schemas)){
    const schema=JSON.parse(await readFile(path,'utf8'));
    assert.equal(schema.$schema,'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.$id,`urn:walkthrough:input:${name}:1`);
  }
});
test('release admission requires the complete native process reader and its exact build identity',async()=>{
  const f=await fixture();try{
    const manifestPath=join(f.release,'release.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    const refresh=async()=>{manifest.files=await files.inventory(f.release,{exclude:['release.json']});manifest.source=files.releaseSource(manifest.files);await writeFile(manifestPath,JSON.stringify(manifest));};
    for(const required of files.requiredProcessReaderFiles){
      const path=join(f.release,required),original=await readFile(path),mode=manifest.files.find((entry:{path:string})=>entry.path===required).mode;
      await rm(path);await refresh();
      await assert.rejects(files.verifyRelease(f.release),{code:'RELEASE_INCOMPLETE'});
      await writeFile(path,original,{mode});await refresh();
    }
    const readerPath=join(f.release,'native/walkthrough-process-reader');
    await chmod(readerPath,0o644);await refresh();
    await assert.rejects(files.verifyRelease(f.release),{code:'RELEASE_PROCESS_READER_INVALID'});
    await chmod(readerPath,0o4755);await refresh();
    await assert.rejects(files.verifyRelease(f.release),{code:'RELEASE_PROCESS_READER_INVALID'});
    await chmod(readerPath,0o755);await refresh();
    const readerManifestPath=join(f.release,'native/process-reader.json'),readerManifest=JSON.parse(await readFile(readerManifestPath,'utf8'));
    await writeFile(readerManifestPath,JSON.stringify({...readerManifest,binarySha256:'0'.repeat(64)}));await refresh();
    await assert.rejects(files.verifyRelease(f.release),{code:'RELEASE_PROCESS_READER_INVALID'});
    await writeFile(readerManifestPath,JSON.stringify(readerManifest));await refresh();
    assert.equal((await files.verifyRelease(f.release)).manifest.version,'0.2.0');
  }finally{await f.cleanup();}
});
test('release admission rejects each omitted public schema and schemas with a wrong identity',async()=>{
  const f=await fixture();try{
    const manifestPath=join(f.release,'release.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    for(const name of files.requiredInputSchemas){
      const path=join(f.release,'docs/schemas',`${name}.schema.json`),original=await readFile(path,'utf8');
      await rm(path);manifest.files=await files.inventory(f.release,{exclude:['release.json']});
      await writeFile(manifestPath,JSON.stringify(manifest));
      await assert.rejects(files.verifyRelease(f.release),{code:'RELEASE_INCOMPLETE'});
      await writeFile(path,original);
    }
    await writeFile(join(f.release,'docs/schemas/film-edit.schema.json'),'{}');
    manifest.files=await files.inventory(f.release,{exclude:['release.json']});
    await writeFile(manifestPath,JSON.stringify(manifest));
    await assert.rejects(files.verifyRelease(f.release),{code:'RELEASE_SCHEMA_INVALID'});
  }finally{await f.cleanup();}
});
test('source identity follows owned packaged bytes without claiming Git or including dependency bytes',async()=>{
  const f=await fixture();try{
    const otherRelease=join(f.root,'relocated');await files.copyRelease(f.release,otherRelease);
    const first=await files.verifyRelease(f.release),relocated=await files.verifyRelease(otherRelease);
    assert.deepEqual(first.manifest.source,relocated.manifest.source);
    assert.equal(first.manifest.source.kind,'content-inventory');assert.equal(first.manifest.source.scope,'packaged-owned-files');
    assert.equal(Object.hasOwn(first.manifest.source,'commit'),false);assert.match(first.manifest.source.sha256,/^[a-f0-9]{64}$/);
    await mkdir(join(f.release,'node_modules/example'),{recursive:true});
    await writeFile(join(f.release,'node_modules/example/index.js'),'dependency bytes');
    const withDependency=await files.inventory(f.release,{exclude:['release.json']});
    assert.deepEqual(files.releaseSource(withDependency),first.manifest.source);
    await writeFile(join(f.release,'src/cli.ts'),'export const edited = true;\n');
    const changed=await files.inventory(f.release,{exclude:['release.json']});
    assert.notEqual(files.releaseSource(changed).sha256,first.manifest.source.sha256);
    await writeFile(join(f.release,'release.json'),JSON.stringify({...first.manifest,files:changed}));
    await assert.rejects(files.verifyRelease(f.release),{code:'RELEASE_SOURCE_IDENTITY_INVALID'});
    await writeFile(join(f.release,'release.json'),JSON.stringify({...first.manifest,files:changed,source:files.releaseSource(changed)}));
    assert.equal((await files.verifyRelease(f.release)).manifest.source.sha256,files.releaseSource(changed).sha256);
  }finally{await f.cleanup();}
});
test('release integrity checks extra bytes, symlink escape and mode drift',async()=>{
  const f=await fixture();try{
    await chmod(join(f.release,'src/cli.ts'),0o755);
    await assert.rejects(files.verifyRelease(f.release),{code:'RELEASE_INTEGRITY_FAILED'});
    await chmod(join(f.release,'src/cli.ts'),0o644);
    await writeFile(join(f.release,'unlisted'),'bad');
    await assert.rejects(files.verifyRelease(f.release),{code:'RELEASE_INTEGRITY_FAILED'});
  }finally{await f.cleanup();}
});
test('bootstrap admission excludes redistributed dependency bytes even with a matching manifest',async()=>{
  const f=await fixture();try{
    const manifestPath=join(f.release,'release.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    delete manifest.bootstrapDigest;manifest.kind='bootstrap';await mkdir(join(f.release,'node_modules/example'),{recursive:true});
    await writeFile(join(f.release,'node_modules/example/package.json'),'{}');
    manifest.files=await files.inventory(f.release,{exclude:['release.json']});manifest.source=files.releaseSource(manifest.files);await writeFile(manifestPath,JSON.stringify(manifest));
    await assert.rejects(files.verifyRelease(f.release),{code:'RELEASE_BOOTSTRAP_REDISTRIBUTION'});
  }finally{await f.cleanup();}
});
test('recovery restores exact predecessor after interrupted publication',async()=>{
  const f=await fixture();try{
    await installer.installRelease({releasePath:f.release,home:f.home,runtime:process.execPath});
    const p=installer.installationPaths(f.home),receipt=JSON.parse(await readFile(p.receipt,'utf8'));
    const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',before=await files.fingerprint(p.launcher),backup=`${p.launcher}.previous-${id}`,stage=`${p.launcher}.next-${id}`;
    await rename(p.launcher,backup);
    const journal={schemaVersion:2,product:'walkthrough',installRoot:p.installRoot,id,pid:2147483647,phase:'applying',previousReceipt:receipt,nextReceipt:null,outputs:[{path:p.launcher,before,after:null,backup,stage}]};
    await writeFile(p.pending,JSON.stringify(journal));
    assert.equal((await installer.checkInstallation({home:f.home})).status,'recovery-required');
    assert.equal((await installer.recoverInstallation({home:f.home})).status,'predecessor-restored');
    assert.deepEqual(await files.fingerprint(p.launcher),before);assert.equal(await files.stat(p.pending),null);
  }finally{await f.cleanup();}
});
