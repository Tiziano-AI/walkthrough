import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,realpath,symlink,truncate} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectNarrationFit} from '../src/core/film.ts';
import type {FilmNarrationFit} from '../src/core/film-edit.ts';

// Hand-calculated measurements: one fitting phrase, one next-phrase conflict,
// and one picture-end conflict. No source, WAV, provision or runtime is present.
const fit:FilmNarrationFit={schemaVersion:1,kind:'narration-fit',status:'rejected',pictureDurationSeconds:2,phraseCount:3,conflictingPhraseCount:2,phrases:[
  {phraseId:'first',outputStartSeconds:0,measuredDurationSeconds:0.5,measuredEndSeconds:0.5,occupiedDurationSeconds:0.5,occupiedEndSeconds:0.5,nextPhrase:{phraseId:'second',outputStartSeconds:0.5,requiredClearanceSeconds:0},pictureEnd:{outputEndSeconds:2,requiredClearanceSeconds:0}},
  {phraseId:'second',outputStartSeconds:0.5,measuredDurationSeconds:1.01,measuredEndSeconds:1.51,occupiedDurationSeconds:61/60,occupiedEndSeconds:91/60,nextPhrase:{phraseId:'last',outputStartSeconds:1.5,requiredClearanceSeconds:1/60},pictureEnd:{outputEndSeconds:2,requiredClearanceSeconds:0}},
  {phraseId:'last',outputStartSeconds:1.5,measuredDurationSeconds:0.501,measuredEndSeconds:2.001,occupiedDurationSeconds:31/60,occupiedEndSeconds:121/60,nextPhrase:null,pictureEnd:{outputEndSeconds:2,requiredClearanceSeconds:1/60}},
]};
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){
  const root=await mkdtemp(join(await realpath(tmpdir()),'film-narration-fit-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'composition');await mkdir(directory);return {root,directory,path:join(directory,'narration-fit.json')};
}

test('retained narration inspection pages exact measurements without audio or source access',async t=>{
  const f=await fixture(t);await writeFile(f.path,JSON.stringify(fit));
  const result=await inspectNarrationFit(f.directory,{limit:1});
  assert.equal(result.state,'recorded');assert.equal(result.statusBasis,'retained-narration-fit');assert.equal(result.diagnosticPath,f.path);
  assert.equal(result.record?.selection,'all');assert.deepEqual(result.record?.phrases.items,[fit.phrases[0]]);
  assert.equal(result.record?.phraseCount,3);assert.equal(result.record?.phrases.total,3);assert.equal(result.record?.phrases.nextOffset,1);
  const conflicts=await inspectNarrationFit(f.directory,{conflictsOnly:true,limit:1});
  assert.equal(conflicts.record?.selection,'conflicts');assert.equal(conflicts.record?.phrases.total,2);assert.deepEqual(conflicts.record?.phrases.items,[fit.phrases[1]]);
  const remaining=await inspectNarrationFit(f.directory,{conflictsOnly:true,limit:1,offset:1});
  assert.deepEqual(remaining.record?.phrases.items,[fit.phrases[2]]);assert.equal(remaining.record?.phrases.nextOffset,null);
  await assert.rejects(inspectNarrationFit(f.directory,{limit:1001}),/INVALID_PAGE/);
});
test('missing and invalid narration-fit records remain distinguishable',async t=>{
  const f=await fixture(t);assert.equal((await inspectNarrationFit(f.directory)).state,'not-recorded');
  for(const value of ['{',JSON.stringify({...fit,conflictingPhraseCount:0}),JSON.stringify({...fit,extra:'raw provider content'})]){
    await writeFile(f.path,value);const result=await inspectNarrationFit(f.directory);
    assert.equal(result.state,'invalid');assert.equal(result.record,null);assert.equal(JSON.stringify(result).includes('raw provider content'),false);
  }
  await truncate(f.path,16*1024*1024+1);assert.equal((await inspectNarrationFit(f.directory)).state,'invalid');
});
test('narration inspection does not follow redirected diagnostic files or directories',async t=>{
  const f=await fixture(t),outside=join(f.root,'outside.json');await writeFile(outside,JSON.stringify(fit));await symlink(outside,f.path);
  const result=await inspectNarrationFit(f.directory);assert.equal(result.state,'unsafe');assert.equal(result.record,null);
  const redirected=join(f.root,'redirected');await symlink(f.directory,redirected);
  assert.equal((await inspectNarrationFit(redirected)).state,'unsafe');
});
