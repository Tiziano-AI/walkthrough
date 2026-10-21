import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bundleFiles,observeBundle} from '../src/core/bundle.ts';
import {sha256} from '../src/core/files.ts';

async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){
  const root=await mkdtemp(join(tmpdir(),'walkthrough-bundle-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'run');await mkdir(directory);
  for(const name of bundleFiles)await writeFile(join(directory,name),`synthetic ${name}`);
  const checksums=Object.fromEntries(bundleFiles.map(name=>[name,sha256(`synthetic ${name}`)]));
  await writeFile(join(directory,'checksums.json'),JSON.stringify(checksums));
  return {root,directory,checksums};
}
test('available bundle is freshly checked without promoting human acceptance',async t=>{
  const f=await fixture(t);const result=await observeBundle(f.directory,'awaiting-human-review');
  assert.equal(result.availability,'complete');assert.equal(result.integrity,'verified');
  assert.equal(result.reviewPath,join(f.directory,'review.html'));
  assert.ok(result.files.every(file=>file.state==='present'&&file.checksum==='match'));
});
test('missing, changed and replaced files withhold review without changing history',async t=>{
  const f=await fixture(t);
  await rm(join(f.directory,'poster.png'));
  let result=await observeBundle(f.directory,'awaiting-human-review');
  assert.equal(result.availability,'partial');assert.equal(result.integrity,'unverified');assert.equal(result.reviewPath,null);
  await writeFile(join(f.directory,'poster.png'),'changed');
  result=await observeBundle(f.directory,'awaiting-human-review');
  assert.equal(result.availability,'complete');assert.equal(result.integrity,'mismatch');assert.equal(result.reviewPath,null);
  assert.equal(result.files.find(file=>file.name==='poster.png')?.checksum,'mismatch');
  await rm(join(f.directory,'poster.png'));await mkdir(join(f.directory,'poster.png'));
  result=await observeBundle(f.directory,'awaiting-human-review');
  assert.equal(result.files.find(file=>file.name==='poster.png')?.state,'unsafe');
});
test('checksums missing or malformed cannot imply verified availability',async t=>{
  const f=await fixture(t);
  await rm(join(f.directory,'checksums.json'));
  assert.equal((await observeBundle(f.directory,'awaiting-human-review')).checksums,'missing');
  for(const value of ['{','[]',JSON.stringify({...f.checksums,'../../private':sha256('secret')}),JSON.stringify({'walkthrough.mp4':sha256('one')})]){
    await writeFile(join(f.directory,'checksums.json'),value);
    const result=await observeBundle(f.directory,'awaiting-human-review');
    assert.equal(result.checksums,'invalid');assert.equal(result.integrity,'unverified');assert.equal(result.reviewPath,null);
    assert.ok(!JSON.stringify(result).includes('private'));
  }
});
test('symlinked bundle files and directories are not followed',async t=>{
  const f=await fixture(t);
  await writeFile(join(f.root,'private'),'never disclose this');
  await rm(join(f.directory,'narration.txt'));await symlink(join(f.root,'private'),join(f.directory,'narration.txt'));
  let result=await observeBundle(f.directory,'awaiting-human-review');
  assert.equal(result.files.find(file=>file.name==='narration.txt')?.state,'unsafe');assert.equal(result.reviewPath,null);
  await rm(join(f.directory,'checksums.json'));await symlink(join(f.root,'private'),join(f.directory,'checksums.json'));
  assert.equal((await observeBundle(f.directory,'awaiting-human-review')).checksums,'unsafe');
  await symlink(f.directory,join(f.root,'alias'));
  result=await observeBundle(join(f.root,'alias'),'awaiting-human-review');
  assert.ok(result.files.every(file=>file.state==='unsafe'));assert.ok(!JSON.stringify(result).includes('never disclose'));
});
test('no output is not-produced for an unfinished attempt, missing for recorded success',async t=>{
  const f=await fixture(t);
  for(const name of bundleFiles)await rm(join(f.directory,name));
  assert.equal((await observeBundle(f.directory,'running')).availability,'not-produced');
  assert.equal((await observeBundle(f.directory,'failed')).availability,'not-produced');
  assert.equal((await observeBundle(f.directory,'awaiting-human-review')).availability,'missing');
});
test('even matching partial-stage files do not offer a finished review',async t=>{
  const f=await fixture(t);
  const result=await observeBundle(f.directory,'running');
  assert.equal(result.integrity,'verified');assert.equal(result.reviewPath,null);
});
test('named deliverables require a matching bounded manifest and literal artifact directory',async t=>{
  const f=await fixture(t),content='{"diagram":"retained"}';
  await mkdir(join(f.directory,'deliverables'));await writeFile(join(f.directory,'deliverables/project.json'),content);
  const artifact={name:'project.json',title:'Editable diagram',mediaType:'application/json',role:'deliverable',relativePath:'deliverables/project.json',sha256:sha256(content),bytes:Buffer.byteLength(content)};
  const metadata=JSON.stringify({schemaVersion:1,artifacts:[artifact]});await writeFile(join(f.directory,'deliverables.json'),metadata);
  const checksums={...f.checksums,'deliverables.json':sha256(metadata),'deliverables/project.json':artifact.sha256};
  await writeFile(join(f.directory,'checksums.json'),JSON.stringify(checksums));
  const complete=await observeBundle(f.directory,'awaiting-human-review');
  assert.equal(complete.integrity,'verified');assert.deepEqual(complete.deliverables,[{...artifact,path:join(f.directory,artifact.relativePath)}]);
  await writeFile(join(f.directory,artifact.relativePath),'changed');
  assert.equal((await observeBundle(f.directory,'awaiting-human-review')).integrity,'mismatch');
  await rm(join(f.directory,'deliverables'),{recursive:true});await mkdir(join(f.root,'outside'));await writeFile(join(f.root,'outside/project.json'),content);await symlink(join(f.root,'outside'),join(f.directory,'deliverables'));
  const unsafe=await observeBundle(f.directory,'awaiting-human-review');
  assert.equal(unsafe.files.find(file=>file.name===artifact.relativePath)?.state,'unsafe');assert.equal(unsafe.reviewPath,null);
  const invalid=JSON.stringify({schemaVersion:1,artifacts:[{...artifact,relativePath:'../private.json'}]});
  await writeFile(join(f.directory,'deliverables.json'),invalid);await writeFile(join(f.directory,'checksums.json'),JSON.stringify({...checksums,'deliverables.json':sha256(invalid)}));
  const rejected=await observeBundle(f.directory,'awaiting-human-review');
  assert.equal(rejected.checksums,'invalid');assert.equal(rejected.reviewPath,null);assert.deepEqual(rejected.deliverables,[]);
});
test('checksum keys cannot independently declare deliverables or smuggle extra files',async t=>{
  const f=await fixture(t);
  await writeFile(join(f.directory,'checksums.json'),JSON.stringify({...f.checksums,'deliverables/hidden.json':sha256('hidden')}));
  const result=await observeBundle(f.directory,'awaiting-human-review');
  assert.equal(result.checksums,'invalid');assert.ok(result.files.every(file=>!file.name.includes('hidden')));
});
