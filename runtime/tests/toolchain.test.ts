import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {discoverLocalTools,readToolchainSelection,resolveLocalTools,toolchainSelectionPath} from '../src/core/toolchain.ts';

test('explicit tool selection wins and malformed selection never falls back',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-tools-'));
  const previous=process.env.WALKTHROUGH_CONFIG_ROOT;process.env.WALKTHROUGH_CONFIG_ROOT=directory;
  t.after(async()=>{if(previous===undefined)delete process.env.WALKTHROUGH_CONFIG_ROOT;else process.env.WALKTHROUGH_CONFIG_ROOT=previous;await rm(directory,{recursive:true,force:true});});
  assert.equal(readToolchainSelection(),null);
  const tools={nodePath:'/operator/node',browserPath:'/operator/chrome',ffmpegPath:'/operator/ffmpeg',ffprobePath:'/operator/ffprobe'};
  await writeFile(toolchainSelectionPath(),JSON.stringify({schemaVersion:1,tools}));
  assert.deepEqual(resolveLocalTools(),tools);
  await writeFile(toolchainSelectionPath(),JSON.stringify({schemaVersion:1,tools:{...tools,nodePath:'relative-node'}}));
  assert.throws(()=>resolveLocalTools(),{code:'TOOLCHAIN_SELECTION_INVALID'});
});

test('discovery offers a product browser store, never another tool’s personal cache',()=>{
  const tools=discoverLocalTools();
  assert.equal(tools.nodePath,process.execPath);
  assert.ok(tools.browserPath.startsWith(join(homedir(),'.local/share/walkthrough/browsers/')));
  assert.doesNotMatch(tools.browserPath,/Library\/Caches\/ms-playwright/);
});

test('metadata needs no writable operational state, even with an interrupted install',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-metadata-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const state=join(directory,'state'),config=join(directory,'config');await mkdir(state);await mkdir(config);
  await writeFile(join(state,'installation-pending.json'),'unfinished install, intentionally not parsed');
  await writeFile(join(state,'setup-pending.json'),'unfinished setup, intentionally not parsed');
  await writeFile(join(config,'toolchain.json'),'invalid operational configuration');
  const launcher=resolve(import.meta.dirname,'../bin/walkthrough.mjs');
  for(const args of [['--version','--json'],['help','--json'],['help','setup','--json'],['help','audio','--json']]){
    const result=spawnSync(process.execPath,[launcher,...args],{cwd:directory,encoding:'utf8',env:{...process.env,WALKTHROUGH_STATE_ROOT:state,WALKTHROUGH_CONFIG_ROOT:config}});
    assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(result.stderr,'');
    assert.equal(JSON.parse(result.stdout).status,'ok');
  }
  assert.deepEqual((await readdir(state)).sort(),['installation-pending.json','setup-pending.json']);
  assert.deepEqual(await readdir(config),['toolchain.json']);
  assert.equal(await readFile(join(config,'toolchain.json'),'utf8'),'invalid operational configuration');
  const noWrite=spawnSync(process.execPath,[launcher,'--version','--json'],{cwd:directory,encoding:'utf8',env:{...process.env,WALKTHROUGH_STATE_ROOT:'/dev/null',WALKTHROUGH_CONFIG_ROOT:config}});
  assert.equal(noWrite.status,0,noWrite.stdout+noWrite.stderr);
});
