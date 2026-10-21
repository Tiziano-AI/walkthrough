import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmod,mkdir,mkdtemp,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {gunzipSync} from 'node:zlib';

const {packageRelease}=await import(new URL('../scripts/package-release.mjs',import.meta.url).href);
const supported=process.platform==='darwin'&&process.arch==='arm64';
const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const gitOptions=['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Walkthrough package test','-c','user.email=package-test@example.invalid'];
const git=(root:string,args:string[])=>execFileSync('/usr/bin/git',[...gitOptions,...args],{cwd:root,encoding:'utf8'});

async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'walkthrough-release-map-'))),repository=join(root,'repository');
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(repository);
  const entries:Record<string,string>={
    '.gitignore':'runtime/node_modules/\nruntime/native/\n*.local\n',
    'plugin.json':'{"name":"walkthrough","description":"Guidance-only plugin"}\n',
    '.claude-plugin/plugin.json':'{"name":"walkthrough","version":"0.4.0"}\n',
    'skills/walkthrough/SKILL.md':'---\nname: walkthrough\ndescription: "Introduce a real product"\n---\nPublic native guidance.\n',
    'skills/walkthrough/references/authoring.md':'A retained public skill reference.\n',
    'README.md':'# Walkthrough\n\nPublic root installation instructions.\n',
    'LICENSE':'Synthetic owned license fixture.\n',
    'THIRD_PARTY_NOTICES.md':'Synthetic dependency notice fixture.\n',
    'VISION.md':'Public root vision.\n','ARCHITECTURE.md':'Public root architecture.\n',
    'QUALITY.md':'Public root quality.\n','SECURITY.md':'Public root security.\n',
    'docs/browser-authoring.md':'Public root browser authoring contract.\n',
    'runtime/package.json':JSON.stringify({name:'walkthrough',version:'0.4.0',type:'module',dependencies:{}})+'\n',
    'runtime/package-lock.json':JSON.stringify({name:'walkthrough',version:'0.4.0',lockfileVersion:3,packages:{'':{name:'walkthrough',version:'0.4.0',dependencies:{}}}})+'\n',
    'runtime/bin/walkthrough.mjs':'console.log("Committed runtime launcher");\n',
    'runtime/src/cli.ts':'export const committedRuntime = "runtime source";\n',
    'runtime/src/command-help.ts':'export const committedHelp = "runtime help";\n',
    'runtime/src/core/runtime-paths.ts':'export const committedPaths = "runtime paths";\n',
    'runtime/scripts/install-local.mjs':'// Synthetic package fixture; not executed.\n',
    'runtime/scripts/release-files.mjs':'// Synthetic package fixture; not executed.\n',
    'runtime/scripts/prepare-release.mjs':'// Synthetic package fixture; not executed.\n',
    'runtime/scripts/provision-renderer.ts':'// Synthetic package fixture; not executed.\n',
    'runtime/scripts/loopback-only.sb':'(version 1)\n',
    // Exercise the real package-build seam, not a fabricated reader manifest.
    'runtime/scripts/provision-session.mjs':await readFile(new URL('../scripts/provision-session.mjs',import.meta.url),'utf8'),
    'runtime/src/session/native/process-reader.c':await readFile(new URL('../src/session/native/process-reader.c',import.meta.url),'utf8'),
    // These committed files are outside the positive public mapping.
    'AGENTS.md':'Private operator instructions.\n','ROADMAP.md':'Private operational history.\n',
    'docs/research/private.md':'Private research.\n','docs/decisions/private.md':'Private decision history.\n',
    'integrations/avioco/private.md':'Private integration material.\n',
    'runtime/tests/private.test.ts':'Private development test.\n',
    'runtime/scripts/private-operator.mjs':'Private operator utility.\n',
    'runtime/private-settings.json':'{"private":true}\n',
  };
  for(const name of ['project-brief','session-action','action-resolution','capture-start','capture-mark','capture-seal','film-edit'])entries[`runtime/docs/schemas/${name}.schema.json`]=JSON.stringify({$schema:'https://json-schema.org/draft/2020-12/schema',$id:`urn:walkthrough:input:${name}:1`,type:'object'})+'\n';
  for(const [path,bytes] of Object.entries(entries)){await mkdir(dirname(join(repository,path)),{recursive:true});await writeFile(join(repository,path),bytes);}
  await chmod(join(repository,'runtime/bin/walkthrough.mjs'),0o755);
  git(repository,['init','--quiet']);git(repository,['add','.']);git(repository,['commit','--quiet','-m','Commit isolated public and private packaging fixture']);
  // Untracked and ignored material must never become release bytes, including
  // files nested under an otherwise public selected directory.
  for(const path of ['runtime/src/untracked.ts','skills/walkthrough/untracked.md','runtime/node_modules/ignored/index.js','runtime/native/unqualified-reader','runtime/src/ignored.local']){
    await mkdir(dirname(join(repository,path)),{recursive:true});await writeFile(join(repository,path),'Uncommitted workstation-only bytes.\n');
  }
  return {root,repository,sourceRoot:join(repository,'runtime'),entries,commit:git(repository,['rev-parse','HEAD']).trim()};
}

async function assertMappedBootstrap(result:{releasePath:string;archivePath:string;sha256:string},entries:Record<string,string>,root:string){
  const manifest=JSON.parse(await readFile(join(result.releasePath,'release.json'),'utf8'));
  assert.equal(manifest.kind,'bootstrap');assert.equal(manifest.version,'0.4.0');
  const expected=Object.entries(entries).filter(([path])=>
    path.startsWith('runtime/bin/')||path.startsWith('runtime/src/')||path.startsWith('runtime/docs/schemas/')
    ||['runtime/package.json','runtime/package-lock.json','runtime/scripts/install-local.mjs','runtime/scripts/release-files.mjs','runtime/scripts/prepare-release.mjs','runtime/scripts/provision-renderer.ts','runtime/scripts/provision-session.mjs','runtime/scripts/loopback-only.sb'].includes(path)
    ||path.startsWith('skills/walkthrough/')||['README.md','LICENSE','THIRD_PARTY_NOTICES.md','VISION.md','ARCHITECTURE.md','QUALITY.md','SECURITY.md','docs/browser-authoring.md'].includes(path));
  const expectedFiles=expected.map(([path])=>path.startsWith('runtime/')?path.slice('runtime/'.length):path);
  assert.deepEqual(manifest.files.filter((entry:{kind:string})=>entry.kind==='file').map((entry:{path:string})=>entry.path).sort(),[...expectedFiles,'native/walkthrough-process-reader','native/process-reader.json'].sort());
  const extracted=join(root,'extracted');await mkdir(extracted);
  execFileSync('/usr/bin/tar',['-xzf',result.archivePath,'-C',extracted]);
  const extractedRelease=join(extracted,'walkthrough-0.4.0-darwin-arm64');
  for(const [source,bytes] of expected){
    const target=source.startsWith('runtime/')?source.slice('runtime/'.length):source;
    assert.equal(manifest.files.find((entry:{path:string})=>entry.path===target)?.sha256,digest(bytes),`The seal must hash the committed mapped ${source} bytes.`);
    assert.equal(digest(await readFile(join(extractedRelease,target))),digest(bytes),`The delivered tar must contain the committed mapped ${source} bytes.`);
  }
  assert.equal(digest(await readFile(result.archivePath)),result.sha256);
  const reader=JSON.parse(await readFile(join(extractedRelease,'native/process-reader.json'),'utf8'));
  assert.equal(reader.sourceSha256,digest(entries['runtime/src/session/native/process-reader.c']!));
  assert.equal(reader.binarySha256,digest(await readFile(join(extractedRelease,'native/walkthrough-process-reader'))));
  const probe=JSON.parse(execFileSync(join(extractedRelease,'native/walkthrough-process-reader'),[],{encoding:'utf8'}));
  assert.equal(probe.schemaVersion,1);assert.ok(probe.processes.some((row:{pid:number})=>row.pid===process.pid));
  assert.ok(manifest.files.every((entry:{path:string})=>!entry.path.startsWith('runtime/')&&!entry.path.startsWith('.git/')));
}

function tarHeaders(bytes:Buffer){
  const headers:Array<{name:string;type:string;mode:number;uid:number;gid:number;uname:string;gname:string;pax:Record<string,string>}> = [];
  const text=(block:Buffer,start:number,length:number)=>block.subarray(start,start+length).toString('utf8').replace(/\0.*$/s,'');
  for(let offset=0;offset+512<=bytes.length;){
    const block=bytes.subarray(offset,offset+512);if(block.every(byte=>byte===0))break;
    const size=parseInt(text(block,124,12).trim(),8),type=text(block,156,1),pax:Record<string,string>={};
    if(type==='x'||type==='g'){
      const payload=bytes.subarray(offset+512,offset+512+size);
      for(let cursor=0;cursor<payload.length;){
        const space=payload.indexOf(0x20,cursor),length=Number(payload.subarray(cursor,space).toString('utf8'));
        assert.ok(space>cursor&&Number.isSafeInteger(length)&&length>space-cursor+1&&cursor+length<=payload.length,'PAX records must retain their byte-addressed framing.');
        const record=payload.subarray(space+1,cursor+length-1).toString('utf8'),equal=record.indexOf('=');
        assert.ok(equal>0);pax[record.slice(0,equal)]=record.slice(equal+1);cursor+=length;
      }
    }
    const prefix=text(block,345,155),name=text(block,0,100);
    headers.push({name:prefix?`${prefix}/${name}`:name,type,mode:parseInt(text(block,100,8).trim(),8),uid:parseInt(text(block,108,8).trim(),8),gid:parseInt(text(block,116,8).trim(),8),uname:text(block,265,32),gname:text(block,297,32),pax});
    offset+=512+Math.ceil(size/512)*512;
  }
  return headers;
}

test('native plugin root has no package-manager installation trigger',async()=>{
  for(const name of ['package.json','package-lock.json'])await assert.rejects(stat(new URL('../../'+name,import.meta.url)),{code:'ENOENT'});
});

test('committed runtime and public root inputs map into one flat bootstrap without private or workstation bytes',{skip:!supported},async t=>{
  const f=await fixture(t);
  await assert.rejects(stat(join(f.repository,'package.json')),{code:'ENOENT'});
  const result=await packageRelease({sourceRoot:f.sourceRoot,outputRoot:join(f.root,'output')});
  assert.equal(result.downloads,false);assert.equal(result.dependencies,0);
  await assertMappedBootstrap(result,f.entries,f.root);
  await assert.rejects(stat(join(f.repository,'package.json')),{code:'ENOENT'});
});

test('delivered archive excludes staged extended attributes and builder ownership without changing bytes or modes',{skip:!supported},async t=>{
  const f=await fixture(t),output=join(f.root,'output'),attribute='user.walkthrough-package-test',provenance=`Synthetic private staging path: ${f.root}`;
  // Inject after staging, immediately before the actual owned archive command.
  // Git cannot carry the attribute, so setting it on a source fixture alone
  // would not exercise the final archive's metadata boundary.
  const child=execFileSync(process.execPath,['--input-type=module','-e',`
    import childProcess from 'node:child_process';
    import {join} from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    const original=childProcess.execFileSync;let injected=false;
    childProcess.execFileSync=(command,args,options)=>{
      if(command==='/usr/bin/tar'&&args[0]==='-czf'){
        const directory=join(args[args.indexOf('-C')+1],args.at(-1));
        original('/usr/bin/xattr',['-w',${JSON.stringify(attribute)},${JSON.stringify(provenance)},join(directory,'README.md')]);injected=true;
      }
      return original(command,args,options);
    };
    syncBuiltinESMExports();
    const {packageRelease}=await import(${JSON.stringify(new URL('../scripts/package-release.mjs',import.meta.url).href)});
    const result=await packageRelease({sourceRoot:${JSON.stringify(f.sourceRoot)},outputRoot:${JSON.stringify(output)}});
    console.log(JSON.stringify({result,injected}));
  `],{encoding:'utf8'});
  const {result,injected}=JSON.parse(child);assert.equal(injected,true);
  assert.equal(execFileSync('/usr/bin/xattr',['-p',attribute,join(result.releasePath,'README.md')],{encoding:'utf8'}).trim(),provenance);
  const headers=tarHeaders(gunzipSync(await readFile(result.archivePath)));
  assert.ok(headers.length>0);
  for(const header of headers){
    assert.deepEqual({uid:header.uid,gid:header.gid,uname:header.uname,gname:header.gname},{uid:0,gid:0,uname:'root',gname:'root'},`Normalize ownership for ${header.name}.`);
    assert.ok(Object.keys(header.pax).every(key=>!/xattr|provenance/i.test(key)),`Exclude extended attributes from ${header.name}.`);
    assert.ok(!JSON.stringify(header).includes(f.root),`Do not retain the private staging path in ${header.name} metadata.`);
  }
  const manifest=JSON.parse(await readFile(join(result.releasePath,'release.json'),'utf8')),prefix='walkthrough-0.4.0-darwin-arm64/';
  for(const entry of manifest.files){
    const header=headers.find(header=>header.name===prefix+entry.path+(entry.kind==='directory'?'/':''));
    assert.ok(header,`The archive must retain ${entry.path}.`);assert.equal(header.mode&0o777,entry.mode,`Preserve ${entry.path} mode.`);
  }
  for(const path of ['bin/walkthrough.mjs','native/walkthrough-process-reader']){
    const header=headers.find(header=>header.name===prefix+path);assert.ok(header);assert.equal(header.mode&0o777,0o755);
  }
  await assertMappedBootstrap(result,f.entries,f.root);
});

test('both archive mappings and package metadata retain the captured commit after HEAD and working bytes change',{skip:!supported},async t=>{
  const f=await fixture(t),output=join(f.root,'output');
  // Change and commit both owners after source admission. The real git archive
  // calls must still read the one admitted tree, not HEAD or the working tree.
  const child=execFileSync(process.execPath,['--input-type=module','-e',`
    import childProcess from 'node:child_process';
    import {writeFileSync} from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const original=childProcess.execFileSync;let changed=false;
    childProcess.execFileSync=(command,args,options)=>{
      const result=original(command,args,options);
      if(command==='/usr/bin/git'&&args[0]==='ls-tree'&&!changed){
        changed=true;
        writeFileSync(${JSON.stringify(join(f.repository,'README.md'))},'Different committed root instructions.\\n');
        writeFileSync(${JSON.stringify(join(f.sourceRoot,'src/cli.ts'))},'Different committed runtime.\\n');
        writeFileSync(${JSON.stringify(join(f.sourceRoot,'package.json'))},JSON.stringify({name:'walkthrough',version:'9.9.9',type:'module',dependencies:{}}));
        writeFileSync(${JSON.stringify(join(f.sourceRoot,'package-lock.json'))},JSON.stringify({name:'walkthrough',version:'9.9.9',packages:{'':{version:'9.9.9',dependencies:{}}}}));
        original('/usr/bin/git',[...${JSON.stringify(gitOptions)},'add','README.md','runtime/src/cli.ts','runtime/package.json','runtime/package-lock.json'],{cwd:${JSON.stringify(f.repository)}});
        original('/usr/bin/git',[...${JSON.stringify(gitOptions)},'commit','--quiet','-m','Concurrent fixture source change'],{cwd:${JSON.stringify(f.repository)}});
      }
      return result;
    };
    syncBuiltinESMExports();
    const {packageRelease}=await import(${JSON.stringify(new URL('../scripts/package-release.mjs',import.meta.url).href)});
    console.log(JSON.stringify(await packageRelease({sourceRoot:${JSON.stringify(f.sourceRoot)},outputRoot:${JSON.stringify(output)}})));
  `],{encoding:'utf8'});
  const result=JSON.parse(child);
  assert.notEqual(git(f.repository,['rev-parse','HEAD']).trim(),f.commit);
  assert.equal(JSON.parse(await readFile(join(f.sourceRoot,'package.json'),'utf8')).version,'9.9.9');
  await assertMappedBootstrap(result,f.entries,f.root);
});

test('uncommitted tracked public changes in either owner are rejected before package output',{skip:!supported},async t=>{
  const f=await fixture(t),output=join(f.root,'output');
  for(const [path,staged] of [['runtime/src/cli.ts',false],['skills/walkthrough/SKILL.md',true],['README.md',false],['runtime/package.json',true]] as const){
    await writeFile(join(f.repository,path),f.entries[path]+'Uncommitted public change.\n');
    if(staged)git(f.repository,['add',path]);
    await assert.rejects(packageRelease({sourceRoot:f.sourceRoot,outputRoot:output}),{code:'PACKAGE_SOURCE_UNCOMMITTED'});
    await assert.rejects(stat(output),{code:'ENOENT'});
    await writeFile(join(f.repository,path),f.entries[path]!);
    if(staged)git(f.repository,['add',path]);
  }
});
