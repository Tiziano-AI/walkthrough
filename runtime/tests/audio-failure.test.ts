import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {voicesJson} from '../src/audio/worker.ts';
import type {AudioProvision} from '../src/audio/provision.ts';
import {withAudioFailure,inspectAudioFailure,safeProviderError} from '../src/audio/failure.ts';

const providerMessage='Forced alignment returned an invalid timeline: 1 validation error for AlignmentResult\n  Value error, Alignment words overlap, are out of order, or exceed normalized audio duration. [type=value_error, input_value={"text":"private transcript"}, input_type=dict]\n    For further information visit https://errors.pydantic.dev/2.13/v/value_error';

test('failed Voices JSON preserves the child outcome and safe provider error rather than only a generic code',async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'walkthrough-audio-diagnostic-')));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const executable=join(directory,'voices.mjs');
  await writeFile(executable,`#!${process.execPath}\nconsole.error('private stderr'); console.log(${JSON.stringify(JSON.stringify({error:{code:'generation',exit_code:4,message:providerMessage},env:{SECRET:'private environment'}}))}); process.exitCode=4;\n`,{mode:0o700});
  const provision={voicesExecutable:executable,hubCacheDirectory:join(directory,'hub')} as AudioProvision;
  const audio=join(directory,'audio');await mkdir(audio);
  // These are inert fixture bytes, never synthesized, parsed or played.
  const wavPath=join(directory,'narration.wav'),previousWav=join(directory,'previous.wav');
  await writeFile(wavPath,'existing partial WAV fixture');await writeFile(previousWav,'existing complete WAV fixture');
  await assert.rejects(withAudioFailure(audio,{phraseId:'follow',operation:'align',paths:{segmentDirectory:directory,narrationWav:wavPath}},()=>voicesJson(provision,['align'],directory,'align')),(error:any)=>{
    assert.equal(error.message,'AUDIO_VOICES_COMMAND_FAILED');
    assert.deepEqual(error.diagnostic?.child,{exitCode:4,signal:null,startFailed:false});
    assert.equal(error.diagnostic?.providerError.code,'generation');
    assert.match(error.diagnostic?.providerError.message,/Alignment words overlap, are out of order, or exceed normalized audio duration/);
    assert.equal(error.diagnostic?.providerError.truncated,true);
    assert.doesNotMatch(JSON.stringify(error.diagnostic),/private transcript|private stderr|private environment|input_value/);
    assert.equal(error.diagnostic?.paths.providerStdout,join(directory,'align.stdout.json'));
    assert.equal(error.diagnostic?.paths.providerStderr,join(directory,'align.stderr.log'));
    return true;
  });
  const inspected=await inspectAudioFailure(directory);
  assert.equal(inspected.state,'recorded');assert.equal(inspected.diagnosticPath,join(audio,'failure.json'));
  assert.equal(inspected.record?.phraseId,'follow');assert.equal(inspected.record?.operation,'align');
  assert.equal(inspected.record?.child?.exitCode,4);assert.equal(inspected.record?.code,'AUDIO_VOICES_COMMAND_FAILED');
  assert.equal(inspected.record?.paths.narrationWav,wavPath);
  assert.equal(inspected.record?.paths.runtimeStdout,join(audio,'runtime.stdout.log'));
  assert.equal(await readFile(wavPath,'utf8'),'existing partial WAV fixture');
  assert.equal(await readFile(previousWav,'utf8'),'existing complete WAV fixture');
  const retained=await readFile(join(audio,'failure.json'));
  await assert.rejects(withAudioFailure(audio,{phraseId:'other',operation:'cache',paths:{}},async()=>{throw new Error('AUDIO_CACHE_CORRUPTION');}),/AUDIO_CACHE_CORRUPTION/);
  assert.deepEqual(await readFile(join(audio,'failure.json')),retained,'a later diagnostic cannot overwrite the original failure');
});

test('malformed failed stdout and process launch failure retain outcomes without copying stderr',async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'walkthrough-audio-diagnostic-')));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const executable=join(directory,'voices.mjs');
  await writeFile(executable,`#!${process.execPath}\nconsole.log('not JSON: private stdout');console.error('private stderr');process.exitCode=7;\n`,{mode:0o700});
  const provision={voicesExecutable:executable,hubCacheDirectory:join(directory,'hub')} as AudioProvision;
  await assert.rejects(voicesJson(provision,['align'],directory,'malformed'),(error:any)=>{
    assert.equal(error.diagnostic.child.exitCode,7);assert.equal(error.diagnostic.response,'invalid');assert.equal(error.diagnostic.providerError,null);
    assert.doesNotMatch(JSON.stringify(error.diagnostic),/private stdout|private stderr/);return true;
  });
  const audio=join(directory,'audio');await mkdir(audio);
  await assert.rejects(withAudioFailure(audio,{phraseId:'opening',operation:'render',paths:{}},()=>voicesJson({...provision,voicesExecutable:join(directory,'missing')},['render'],directory,'missing')),/AUDIO_VOICES_COMMAND_FAILED/);
  const inspected=await inspectAudioFailure(directory);
  assert.equal(inspected.state,'recorded');assert.equal(inspected.record?.child?.startFailed,true);
  assert.equal(inspected.record?.child?.exitCode,-2);assert.equal(inspected.record?.providerError,null);
});

test('provider summaries bound messages, redact credential assignments, and never copy other fields',()=>{
  const error=safeProviderError({code:'generation',message:'API_KEY=secret Bearer private-token '+ 'x'.repeat(2000),traceback:'private trace',environment:{SECRET:'private environment'}})!;
  assert.equal(error.message?.length,1024);assert.equal(error.truncated,true);
  assert.doesNotMatch(JSON.stringify(error),/secret|private-token|private trace|private environment/);
  assert.equal(safeProviderError({message:{text:'private'}}),null);
  assert.equal(safeProviderError({message:'SECRET="private credential" KEY=private-key'})?.message,'[redacted] [redacted]');
  for(const suffix of [' {"environment":"private environment"}',' ["private words"]','\nTraceback (most recent call last)\nprivate stack','\ncontext: private context','\n    at private.module:12:4']){
    assert.equal(safeProviderError({code:'generation',message:'Generation failed.'+suffix})?.message,'Generation failed.');
  }
});

test('inspection bounds and validates its own record without following diagnostic links',async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'walkthrough-audio-diagnostic-')));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  assert.equal((await inspectAudioFailure(directory)).state,'not-recorded');
  const audio=join(directory,'audio'),path=join(audio,'failure.json');await mkdir(audio);
  await writeFile(path,'{');assert.equal((await inspectAudioFailure(directory)).state,'invalid');
  await writeFile(path,'x'.repeat(32*1024+1));assert.equal((await inspectAudioFailure(directory)).state,'invalid');
  await rm(path);await symlink(join(directory,'outside.json'),path);
  assert.equal((await inspectAudioFailure(directory)).state,'unsafe');
});
