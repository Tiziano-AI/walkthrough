import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {retainFile} from '../src/project/store.ts';

test('retained media preserves bytes and hash without sharing mutable file contents',async t=>{
  const root=await mkdtemp(join(tmpdir(),'walkthrough-media-copy-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source.mp4'),directory=join(root,'retained');
  const original=Buffer.from([0,1,2,3,255,128,64,32]);
  await mkdir(directory);await writeFile(source,original);
  const retained=await retainFile(source,directory,'media/source.mp4');
  const target=join(directory,retained.relativePath);
  assert.deepEqual(retained,{relativePath:'media/source.mp4',sha256:createHash('sha256').update(original).digest('hex'),bytes:original.length});
  assert.deepEqual(await readFile(target),original);
  const sourceInfo=await stat(source),targetInfo=await stat(target);
  assert.equal(sourceInfo.dev,targetInfo.dev);
  assert.notEqual(sourceInfo.ino,targetInfo.ino);
  assert.equal(targetInfo.mode&0o777,0o600);

  await writeFile(target,Buffer.from('changed retained bytes'));
  assert.deepEqual(await readFile(source),original);
  await writeFile(source,Buffer.from('changed source bytes'));
  assert.equal(await readFile(target,'utf8'),'changed retained bytes');
});

test('retaining media refuses an existing target without changing either file',async t=>{
  const root=await mkdtemp(join(tmpdir(),'walkthrough-media-copy-excl-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source.wav'),target=join(root,'retained.wav');
  await writeFile(source,'source bytes');await writeFile(target,'existing target bytes');
  const targetInfo=await stat(target);
  await assert.rejects(retainFile(source,root,'retained.wav'),{code:'EEXIST'});
  assert.equal(await readFile(source,'utf8'),'source bytes');
  assert.equal(await readFile(target,'utf8'),'existing target bytes');
  assert.equal((await stat(target)).ino,targetInfo.ino);
});
