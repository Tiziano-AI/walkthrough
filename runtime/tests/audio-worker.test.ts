import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { AUDIO_MODELS, VOICE_FILES, synthesisIdentity } from '../src/audio/provision.ts';
import {createAudioCacheWork,inspectAudioAttempt,resolveAudioAttempt} from '../src/audio/attempts.ts';
import {alignmentIdentity} from '../src/audio/provision.ts';
import {inspectRetainedNarration} from '../src/audio/retained.ts';
import {synthesizeNarration} from '../src/audio/index.ts';
import type { CurrentAudioProvision as AudioProvision, HistoricalAudioProvision, AudioVoice } from '../src/audio/provision.ts';

const worker = fileURLToPath(new URL('../src/audio/worker.ts', import.meta.url));
const canonicalText = "Let's preserve the exact canonical words, punctuation, and timing.";
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const readJSON = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));

// This executable implements only synthetic public-CLI receipts. It neither
// imports Voices nor reads a real reference, model, generated take, or cache.
function standInSource(directory: string): string {
  return `#!${process.execPath}
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
const root=${JSON.stringify(directory)};
const manifest=JSON.parse(await fs.readFile(path.join(root,'provision.json'),'utf8'));
const control=JSON.parse(await fs.readFile(path.join(root,'control.json'),'utf8'));
const args=process.argv.slice(2), command=args[1];
const flag=name=>args[args.indexOf(name)+1];
const voice=manifest.voices.find(voice=>voice.id===(command==='render'?args[2]:manifest.defaultVoiceId));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const denied={};
for(const [name,host,port] of [['external','192.0.2.1',443],['loopback','127.0.0.1',control.port??9]]){
 denied[name]=await new Promise(resolve=>{
  const socket=net.connect({host,port});
  socket.once('connect',()=>{socket.destroy();resolve('CONNECTED');});
  socket.once('error',error=>resolve(error.code));
  socket.setTimeout(1000,()=>{socket.destroy();resolve('TIMEOUT');});
 });
}
const text=args.includes('--text-file')?await fs.readFile(flag('--text-file'),'utf8'):undefined;
const log={command,args,text,denied,credentialInherited:'WALKTHROUGH_CREDENTIAL_CANARY' in process.env,hub:process.env.HF_HUB_CACHE,offline:process.env.HF_HUB_OFFLINE};
await fs.appendFile(path.join(root,'calls.jsonl'),JSON.stringify(log)+'\\n');
if(control.mode===command+'-fail'&&command!=='render'){
 console.error('synthetic incomplete stage');console.log(JSON.stringify({partial:true}));process.exit(17);
}
const runtime=structuredClone(manifest.runtime);
if(control.mode===command+'-runtime')runtime.voices_version='unexpected-version';
if(command==='doctor'){
 if(control.mode.startsWith('final-')){
  const calls=(await fs.readFile(path.join(root,'calls.jsonl'),'utf8')).trim().split('\\n').map(JSON.parse);
  if(calls.filter(call=>call.command==='doctor').length>1){
   if(control.mode==='final-runtime')runtime.voices_version='changed-during-operation';
   if(control.mode==='final-reference')await fs.appendFile(path.join(voice.libraryPath,voice.id,'reference.wav'),'changed');
   if(control.mode==='final-model'){
    const modelFile=path.join(manifest.models.tts.snapshotPath,'config.json');
    const bytes=await fs.readFile(modelFile);bytes[0]^=1;await fs.writeFile(modelFile,bytes);
   }
  }
 }
 console.log(JSON.stringify({runtime}));
}else if(command==='render'){
 if(control.mode==='render-fail'){
  await fs.writeFile(path.join(process.cwd(),'partial-command-output.txt'),'retained failed occurrence');
  console.error('synthetic command failure retained');
  console.log(JSON.stringify({partial:true}));process.exit(17);
 }
 const words=text.split(/\\s+/), samples=words.length*12000;
 const wav=Buffer.alloc(44+samples*2);
 wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
 wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);
 wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
 for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/24000)*5000),44+i*2);
 const output=flag('--out-dir');await fs.mkdir(output,{recursive:true});
 let wavPath=path.join(output,'take.wav'), sidecar=path.join(output,'take.json');
 const artifact={schema_version:2,created_at:'2026-01-01T00:00:00Z',runtime,voice_id:voice.id,reference_voice_id:voice.id,text,language:flag('--language'),base_model_id:manifest.models.tts.repository,base_model_revision:manifest.models.tts.revision,reference_sha256:voice.files['reference.wav'],output_audio:'take.wav'};
 if(control.mode==='render-model')artifact.base_model_revision='wrong-revision';
 if(control.mode==='render-text')artifact.text='This is not the canonical text.';
 if(control.mode==='render-reference')artifact.reference_sha256='0'.repeat(64);
 if(control.mode==='wav-escape')wavPath=path.join(root,'take.wav');
 if(control.mode==='sidecar-escape')sidecar=path.join(root,'take.json');
 await fs.writeFile(wavPath,wav);await fs.writeFile(sidecar,JSON.stringify(artifact));
 if(control.mode==='sidecar-mismatch')await fs.writeFile(sidecar,JSON.stringify({...artifact,text:'Different sidecar text.'}));
 if(control.mode==='wav-symlink-escape'){
  const outside=path.join(root,'outside.wav');await fs.rename(wavPath,outside);await fs.symlink(outside,wavPath);
 }
 console.log(JSON.stringify({artifact,paths:{wav:wavPath,sidecar}}));
 if(control.mode==='render-wait')setInterval(()=>{},1000);
}else if(command==='align'){
 const wav=await fs.readFile(flag('--audio')), words=text.split(/\\s+/);
 const normalized=Buffer.alloc(words.length*8000*4);
 for(let i=0;i<normalized.length/4;i++)normalized.writeFloatLE(Math.round(Math.sin(i*2*Math.PI*440/16000)*5000)/32768,i*4);
 const result={runtime,model_id:manifest.models.aligner.repository,model_revision:manifest.models.aligner.revision,text,language:flag('--language'),audio:{path:flag('--audio'),sha256:hash(wav),normalized_sha256:hash(normalized),normalized_dtype:'<f4',channels:1,duration_seconds:(wav.length-44)/48000,sample_rate:16000,waveform_basis:'ffmpeg-normalized-mono-pcm16-to-float32'},timing_basis:'qwen-forced-aligner-estimator-adjusted',spoken_content_verified:false,timing_diagnostics:null,diagnostic_limit:'Synthetic timing is not spoken-content evidence.',words:words.map((word,i)=>({text:[...word].filter(char=>/[\\p{L}\\p{N}']/u.test(char)).join(''),start:i*.5,end:(i+1)*.5}))};
 if(control.mode==='align-model')result.model_revision='wrong-revision';
 if(control.mode==='align-text')result.text='This is not the canonical text.';
 if(control.mode==='align-audio')result.audio.sha256='0'.repeat(64);
 console.log(JSON.stringify(result));
}else if(command==='transcribe'){
 const wav=await fs.readFile(flag('--audio'));
 const synthesis=JSON.parse(await fs.readFile(path.join(path.dirname(flag('--audio')),'synthesis.json'),'utf8'));
 const result={runtime,transcript:control.transcript??synthesis.text,language:flag('--language'),model_id:manifest.models.asr.repository,model_revision:manifest.models.asr.revision,audio:{path:flag('--audio'),sha256:hash(wav),normalized_sha256:hash('synthetic-normalized'),normalized_dtype:'<f4',channels:1,duration_seconds:(wav.length-44)/48000,sample_rate:16000,waveform_basis:'ffmpeg-normalized-mono-pcm16-to-float32'}};
 if(control.mode==='transcribe-model')result.model_revision='wrong-revision';
 if(control.mode==='transcribe-audio')result.audio.sha256='0'.repeat(64);
 if(control.mode==='transcribe-language')result.language='Italian';
 console.log(JSON.stringify(result));
}else{console.error('unexpected public command');process.exitCode=19;}
`;
}

async function fixture(mode = 'normal', port = 9) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walkthrough-audio-worker-')));
  const hubCacheDirectory = path.join(directory, 'hub');
  const cacheDirectory = path.join(directory, 'cache');
  const libraryPath = path.join(directory, 'library');
  const voiceId = 'copilot-female-1';
  await fs.mkdir(cacheDirectory);
  await fs.mkdir(path.join(libraryPath, voiceId), { recursive: true });
  const voiceFiles = {} as AudioVoice['files'];
  for (const name of VOICE_FILES) {
    const bytes = `synthetic fixture only: ${name}`;
    await fs.writeFile(path.join(libraryPath, voiceId, name), bytes);
    voiceFiles[name] = digest(bytes);
  }
  const models = {} as AudioProvision['models'];
  for (const role of ['tts', 'aligner', 'asr'] as const) {
    const model = AUDIO_MODELS[role];
    const snapshotPath = path.join(hubCacheDirectory, `models--${model.repository.replaceAll('/', '--')}`, 'snapshots', model.revision);
    await fs.mkdir(snapshotPath, { recursive: true });
    const bytes = `synthetic ${role} model file; not weights`;
    await fs.writeFile(path.join(snapshotPath, 'config.json'), bytes);
    const treeDirectory = path.resolve(snapshotPath, '../../trees');
    await fs.mkdir(treeDirectory);
    const treeBytes = JSON.stringify([{ type: 'file', path: 'config.json', size: Buffer.byteLength(bytes), oid: digest(bytes) }]);
    await fs.writeFile(path.join(treeDirectory, `${model.revision}.json`), treeBytes);
    models[role] = { ...model, snapshotPath, resolverTree: { sha256: digest(treeBytes), size: Buffer.byteLength(treeBytes) }, files: [{ path: 'config.json', size: Buffer.byteLength(bytes), sha256: digest(bytes) }] };
  }
  const voicesExecutable = path.join(directory, 'voices.mjs');
  const source = standInSource(directory);
  await fs.writeFile(voicesExecutable, source, { mode: 0o700 });
  const manifest: AudioProvision = {
    schemaVersion: 3, voicesExecutable, hubCacheDirectory, cacheDirectory,
    runtime: { python: 'synthetic-no-python', executable: process.execPath, platform: 'synthetic-test', voices_version: 'synthetic-test', source_sha256: digest(source), source_scope: 'installed-python-source-at-observation', packages: { synthetic: '1' }, package_scope: 'selected-runtime-dependencies' },
    models, defaultVoiceId: voiceId, voices: [{ id: voiceId, libraryPath, files: voiceFiles }],
  };
  const manifestPath = path.join(directory, 'provision.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(path.join(directory, 'control.json'), JSON.stringify({ mode, port }));
  async function request(name: string, beats=[{ id: 'intro', text: canonicalText }], options: {language?: 'English' | 'Italian'; voiceId?: string; reuseAudioDirectory?: string} = {}) {
    const outputDirectory = path.join(directory, name);
    await fs.mkdir(outputDirectory);
    const requestPath = path.join(outputDirectory, 'request.json');
    await fs.writeFile(requestPath, JSON.stringify({ provisionManifestPath: manifestPath, cacheDirectory:manifest.cacheDirectory, voiceId, outputDirectory, beats, ...options }));
    return { outputDirectory, requestPath };
  }
  async function run(requestPath: string, sandbox = true) {
    const executable = sandbox ? '/usr/bin/sandbox-exec' : process.execPath;
    const args = sandbox ? ['-p', '(version 1)(allow default)(deny network*)', process.execPath, worker, requestPath] : [worker, requestPath];
    const child = spawn(executable, args, { cwd: directory, detached:true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), WALKTHROUGH_CREDENTIAL_CANARY: 'never-pass-to-cli' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const records = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { code, records, last: records.at(-1), stderr };
  }
  async function calls(): Promise<any[]> {
    try { return (await fs.readFile(path.join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  return { directory, manifest, request, run, calls };
}

test('sandboxed audio worker uses explicit public CLI revisions and canonical text, then reuses verified cache', { timeout: 20000 }, async () => {
  const server = net.createServer(socket => socket.destroy());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const f = await fixture('normal', (server.address() as net.AddressInfo).port);
    const first = await f.request('first');
    const outcome = await f.run(first.requestPath);
    assert.equal(outcome.code, 0, JSON.stringify(outcome));
    assert.equal(outcome.last.status, 'completed');
    const produced = await readJSON(path.join(first.outputDirectory, 'narration.json'));
    assert.equal(produced.beats[0].cacheHit, false);
    assert.equal(produced.beats[0].text, canonicalText);
    assert.equal(produced.beats[0].metrics.sampleRate, 24000);
    assert.equal(produced.beats[0].metrics.wordsPerMinute, 120);
    assert.equal(produced.spokenContentVerified, false);
    assert.equal(produced.humanListeningRequired, true);
    assert.deepEqual(produced.beats[0].captions.map((cue:any)=>cue.text),["Let's preserve the exact canonical words,",'punctuation, and timing.']);
    assert.equal(produced.beats[0].captions.map((cue:any)=>cue.text).join(' '),canonicalText);
    assert.match(await fs.readFile(produced.vttPath, 'utf8'), /Let's preserve the exact canonical words,/);
    const calls = await f.calls();
    assert.deepEqual(calls.map(call => call.command), ['doctor', 'render', 'align', 'transcribe', 'doctor']);
    for (const call of calls) {
      assert.equal(call.args[0], '--json');
      assert.deepEqual(call.denied, { external: 'EPERM', loopback: 'EPERM' });
      assert.equal(call.credentialInherited, false);
      assert.equal(call.hub, f.manifest.hubCacheDirectory); assert.equal(call.offline, '1');
    }
    for (const [command, role] of [['render', 'tts'], ['align', 'aligner']] as const) {
      const call = calls.find(call => call.command === command);
      assert.equal(call.text, canonicalText);
      assert.equal(call.args[call.args.indexOf('--model-revision') + 1], f.manifest.models[role].revision);
      assert.equal(call.args[call.args.indexOf('--language') + 1], 'English');
    }
    const render = calls.find(call => call.command === 'render');
    assert.equal(render.args[2], f.manifest.voices[0].id);
    assert.equal(render.args[render.args.indexOf('--library') + 1], f.manifest.voices[0].libraryPath);
    const originalManifest=await fs.readFile(path.join(first.outputDirectory,'narration.json'));
    const segmentDirectory=path.join(f.manifest.cacheDirectory,'segments',(await fs.readdir(path.join(f.manifest.cacheDirectory,'segments')))[0]);
    const retainedFiles=['segment.json','synthesis.json','narration.wav'];
    const originalCache=await Promise.all(retainedFiles.map(async name=>digest(await fs.readFile(path.join(segmentDirectory,name)))));
    // A stale derived field in a synthetic cache receipt must not override the
    // current phrase policy: only retained canonical text and alignment own it.
    const cacheReceipt=await readJSON(path.join(segmentDirectory,'segment.json'));
    await fs.writeFile(path.join(segmentDirectory,'segment.json'),JSON.stringify({...cacheReceipt,captions:[{text:canonicalText,startSeconds:0,endSeconds:5}]}));
    const cachedReceiptBytes=await fs.readFile(path.join(segmentDirectory,'segment.json'));
    const second = await f.request('second');
    assert.equal((await f.run(second.requestPath)).code, 0);
    const reused = await readJSON(path.join(second.outputDirectory, 'narration.json'));
    assert.equal(reused.beats[0].cacheHit, true);
    assert.equal(reused.beats[0].wavSha256, produced.beats[0].wavSha256);
    assert.deepEqual(reused.beats[0].captions,produced.beats[0].captions,'new manifests derive current short phrases from retained aligned words');
    assert.deepEqual(await fs.readFile(path.join(first.outputDirectory,'narration.json')),originalManifest,'prior run evidence remains byte-identical');
    assert.deepEqual(await fs.readFile(path.join(segmentDirectory,'segment.json')),cachedReceiptBytes,'reuse does not rewrite the cache receipt');
    assert.deepEqual(await Promise.all(retainedFiles.slice(1).map(async name=>digest(await fs.readFile(path.join(segmentDirectory,name))))),originalCache.slice(1),'retained synthesis, audio and alignment remain byte-identical');
    assert.deepEqual((await f.calls()).map(call => call.command), ['doctor', 'render', 'align', 'transcribe', 'doctor', 'doctor', 'doctor']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('independent phrase identities and more than twenty phrases reuse exact canonical speech without synthesis', {timeout:20000},async()=>{
  const f=await fixture('normal');
  const phrases=Array.from({length:21},(_,index)=>({id:`phrase-${index}`,text:canonicalText}));
  const first=await f.request('many-phrases',phrases),outcome=await f.run(first.requestPath);
  assert.equal(outcome.code,0,JSON.stringify(outcome));
  const produced=await readJSON(path.join(first.outputDirectory,'narration.json'));
  assert.equal(produced.beats.length,21);assert.equal(produced.beats[0].cacheHit,false);
  assert.ok(produced.beats.slice(1).every((beat:any)=>beat.cacheHit));
  assert.equal(new Set(produced.beats.map((beat:any)=>beat.wavSha256)).size,1);
  const revised=await f.request('renamed-phrase',[{id:'a-new-editorial-name',text:canonicalText}]);
  assert.equal((await f.run(revised.requestPath)).code,0);
  const reused=await readJSON(path.join(revised.outputDirectory,'narration.json'));
  assert.equal(reused.beats[0].cacheHit,true);assert.equal(reused.beats[0].wavSha256,produced.beats[0].wavSha256);
  assert.deepEqual((await f.calls()).map(call=>call.command),['doctor','render','align','transcribe','doctor','doctor','doctor']);
});

const rejectedReceipts = [
  ['doctor-runtime', 'AUDIO_RUNTIME_IDENTITY_DRIFT'], ['render-runtime', 'AUDIO_RUNTIME_IDENTITY_DRIFT'],
  ['render-model', 'AUDIO_GENERATION_PROVENANCE_MISMATCH'], ['render-text', 'AUDIO_GENERATION_PROVENANCE_MISMATCH'],
  ['render-reference', 'AUDIO_GENERATION_PROVENANCE_MISMATCH'], ['sidecar-mismatch', 'AUDIO_GENERATION_PROVENANCE_MISMATCH'],
  ['wav-escape', 'AUDIO_OUTPUT_PATH_ESCAPE'], ['sidecar-escape', 'AUDIO_OUTPUT_PATH_ESCAPE'], ['wav-symlink-escape', 'AUDIO_OUTPUT_PATH_ESCAPE'],
  ['align-runtime', 'AUDIO_RUNTIME_IDENTITY_DRIFT'], ['align-model', 'AUDIO_ALIGNMENT_PROVENANCE_MISMATCH'],
  ['align-text', 'AUDIO_ALIGNMENT_PROVENANCE_MISMATCH'], ['align-audio', 'AUDIO_ALIGNMENT_PROVENANCE_MISMATCH'],
  ['transcribe-model', 'AUDIO_TRANSCRIPTION_PROVENANCE_MISMATCH'], ['transcribe-audio', 'AUDIO_TRANSCRIPTION_PROVENANCE_MISMATCH'],
  ['transcribe-language', 'AUDIO_TRANSCRIPTION_PROVENANCE_MISMATCH'], ['transcribe-runtime', 'AUDIO_RUNTIME_IDENTITY_DRIFT'],
  ['final-runtime', 'AUDIO_RUNTIME_IDENTITY_DRIFT'],
  ['final-reference', 'AUDIO_REFERENCE_DRIFT'], ['final-model', 'AUDIO_MODEL_DIGEST_MISMATCH'],
] as const;
for (const [mode, expected] of rejectedReceipts) {
  test(`sandboxed audio worker rejects ${mode}`, { timeout: 20000 }, async () => {
    const f = await fixture(mode), request = await f.request('rejected');
    const result = await f.run(request.requestPath);
    assert.equal(result.code, 1, JSON.stringify(result));
    assert.deepEqual(result.last, { status: 'failed', code: expected });
    await assert.rejects(fs.access(path.join(request.outputDirectory, 'narration.json')), /ENOENT/);
  });
}

test('missing provision file fails before any public CLI invocation', async () => {
  const f = await fixture(), request = await f.request('missing');
  await fs.unlink(path.join(f.manifest.models.tts.snapshotPath, 'config.json'));
  const result = await f.run(request.requestPath);
  assert.equal(result.code, 1);
  assert.deepEqual(result.last, { status: 'failed', code: 'AUDIO_PROVISION_MISSING_FILE' });
  assert.deepEqual(await f.calls(), []);
});

test('worker refuses an unsandboxed request before invoking the public CLI', async () => {
  const f = await fixture(), request = await f.request('unsandboxed');
  const result = await f.run(request.requestPath, false);
  assert.equal(result.code, 1);
  assert.deepEqual(result.last, { status: 'failed', code: 'AUDIO_NETWORK_SANDBOX_NOT_ACTIVE' });
  assert.deepEqual(await f.calls(), []);
});

test('failed public command remains network denied, retains partial evidence, and cannot auto replay', async () => {
  const f = await fixture('render-fail'), first = await f.request('failed');
  const result = await f.run(first.requestPath);
  assert.equal(result.code, 1);
  assert.deepEqual(result.last, { status: 'failed', code: 'AUDIO_VOICES_COMMAND_FAILED' });
  const calls = await f.calls();
  assert.deepEqual(calls.map(call => call.command), ['doctor', 'render']);
  assert.deepEqual(calls[1].denied, { external: 'EPERM', loopback: 'EPERM' });
  const partials = await fs.readdir(path.join(f.manifest.cacheDirectory, 'segments'));
  assert.equal(partials.length, 1); assert.match(partials[0]!, /\.partial-/);
  const partial = path.join(f.manifest.cacheDirectory, 'segments', partials[0]!);
  assert.equal(await fs.readFile(path.join(partial, 'canonical.txt'), 'utf8'), canonicalText);
  assert.equal(await fs.readFile(path.join(partial, 'partial-command-output.txt'), 'utf8'), 'retained failed occurrence');
  assert.deepEqual(await readJSON(path.join(partial, 'render.stdout.json')), { partial: true });
  assert.match(await fs.readFile(path.join(partial, 'render.stderr.log'), 'utf8'), /synthetic command failure retained/);
  const second = await f.request('retry');
  const retry = await f.run(second.requestPath);
  assert.equal(retry.code, 1);
  assert.deepEqual(retry.last, { status: 'failed', code: 'AUDIO_PARTIAL_SEGMENT_REQUIRES_RECONCILIATION' });
  assert.deepEqual((await f.calls()).map(call => call.command), ['doctor', 'render', 'doctor']);
  assert.deepEqual(await fs.readdir(path.join(f.manifest.cacheDirectory, 'segments')), partials);
});

test('Italian and provisioned voice selection reach generation, alignment, ASR and retained results', async () => {
  const f = await fixture(), voice = { ...f.manifest.voices[0], id: 'second-voice' };
  await fs.mkdir(path.join(voice.libraryPath, voice.id));
  for (const name of VOICE_FILES) await fs.copyFile(path.join(voice.libraryPath, f.manifest.defaultVoiceId, name), path.join(voice.libraryPath, voice.id, name));
  f.manifest.voices.push(voice);
  await fs.writeFile(path.join(f.directory, 'provision.json'), JSON.stringify(f.manifest));
  const text = 'Questo progetto mostra il risultato finale.';
  const request = await f.request('italian', [{ id: 'italiano', text }], { language: 'Italian', voiceId: voice.id });
  const result = await f.run(request.requestPath); assert.equal(result.code, 0, JSON.stringify(result));
  const narration = await readJSON(path.join(request.outputDirectory, 'narration.json'));
  assert.equal(narration.language, 'Italian'); assert.equal(narration.voiceId, voice.id);
  assert.equal(narration.beats[0].transcription.comparison.status, 'match');
  assert.equal(narration.beats[0].captions.map((cue: any) => cue.text).join(' '), text);
  for (const call of (await f.calls()).filter(call => call.command !== 'doctor')) assert.equal(call.args[call.args.indexOf('--language') + 1], 'Italian');
  assert.equal((await f.calls()).find(call => call.command === 'render').args[2], voice.id);
  const rejected = await f.request('unprovisioned', [{ id: 'sample', text }], { voiceId: 'unknown' });
  assert.equal((await f.run(rejected.requestPath)).last.code, 'AUDIO_UNPROVISIONED_VOICE');
});

test('ASR disagreement is retained without rewriting approved text or repeating generation', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.directory, 'control.json'), JSON.stringify({ mode: 'normal', transcript: 'Save the different final result.' }));
  const request = await f.request('mismatch'), result = await f.run(request.requestPath);
  assert.equal(result.code, 0, JSON.stringify(result));
  const narration = await readJSON(path.join(request.outputDirectory, 'narration.json'));
  assert.equal(narration.beats[0].text, canonicalText);
  assert.equal(narration.beats[0].transcription.transcript, 'Save the different final result.');
  assert.equal(narration.beats[0].transcription.comparison.status, 'mismatch');
  assert.equal(narration.spokenContentVerified, false); assert.equal(narration.humanListeningRequired, true);
  assert.equal((await f.calls()).filter(call => call.command === 'render').length, 1);
});

test('changing only ASR model bytes reuses exact WAV and alignment independently', async () => {
  const f = await fixture(), first = await f.request('first');
  assert.equal((await f.run(first.requestPath)).code, 0);
  const before = await readJSON(path.join(first.outputDirectory, 'narration.json'));
  const model = f.manifest.models.asr, bytes = 'changed ASR model; synthetic only';
  await fs.writeFile(path.join(model.snapshotPath, 'config.json'), bytes);
  model.files[0].size = Buffer.byteLength(bytes); model.files[0].sha256 = digest(bytes);
  await fs.writeFile(path.join(f.directory, 'provision.json'), JSON.stringify(f.manifest));
  const second = await f.request('changed-asr'); assert.equal((await f.run(second.requestPath)).code, 0);
  const after = await readJSON(path.join(second.outputDirectory, 'narration.json'));
  assert.equal(after.beats[0].wavSha256, before.beats[0].wavSha256);
  assert.equal(after.beats[0].cacheHit, true); assert.equal(after.beats[0].alignmentCacheHit, true);
  assert.equal(after.beats[0].transcription.cacheHit, false);
  assert.deepEqual((await f.calls()).map(call => call.command), ['doctor', 'render', 'align', 'transcribe', 'doctor', 'doctor', 'transcribe', 'doctor']);
});

test('explicit retained audio survives runtime upgrade with its original generation provenance', async () => {
  const f = await fixture(), first = await f.request('first');
  assert.equal((await f.run(first.requestPath)).code, 0);
  const original = await fs.readFile(path.join(first.outputDirectory, 'narration.json'));
  const before = JSON.parse(original.toString());
  f.manifest.runtime.source_sha256 = digest('updated installed runtime');
  await fs.writeFile(path.join(f.directory, 'provision.json'), JSON.stringify(f.manifest));
  const second = await f.request('reuse', [{ id: 'renamed', text: canonicalText }], { reuseAudioDirectory: first.outputDirectory });
  const outcome = await f.run(second.requestPath); assert.equal(outcome.code, 0, JSON.stringify(outcome));
  const after = await readJSON(path.join(second.outputDirectory, 'narration.json'));
  assert.equal(after.beats[0].wavSha256, before.beats[0].wavSha256); assert.equal(after.beats[0].cacheHit, true);
  assert.equal(after.beats[0].synthesisIdentity, before.beats[0].synthesisIdentity);
  assert.equal(after.beats[0].alignmentIdentity, before.beats[0].alignmentIdentity);
  assert.notEqual(after.beats[0].transcription.identity, before.beats[0].transcription.identity);
  assert.deepEqual(await fs.readFile(path.join(first.outputDirectory, 'narration.json')), original);
  assert.deepEqual((await f.calls()).map(call => call.command), ['doctor', 'render', 'align', 'transcribe', 'doctor', 'doctor', 'transcribe', 'doctor']);
  const third = await f.request('reuse-again', [{ id: 'again', text: canonicalText }], { reuseAudioDirectory: second.outputDirectory });
  assert.equal((await f.run(third.requestPath)).code, 0, 'a reused generation retains sufficient independent provenance to reuse again');
});

test('changing only alignment model bytes reruns alignment without touching speech or ASR', async () => {
  const f = await fixture(), first = await f.request('first'); assert.equal((await f.run(first.requestPath)).code, 0);
  const before = await readJSON(path.join(first.outputDirectory, 'narration.json'));
  const model = f.manifest.models.aligner, bytes = 'updated aligner; synthetic only';
  await fs.writeFile(path.join(model.snapshotPath, 'config.json'), bytes);
  model.files[0].size = Buffer.byteLength(bytes); model.files[0].sha256 = digest(bytes);
  await fs.writeFile(path.join(f.directory, 'provision.json'), JSON.stringify(f.manifest));
  const second = await f.request('changed-aligner'); assert.equal((await f.run(second.requestPath)).code, 0);
  const after = await readJSON(path.join(second.outputDirectory, 'narration.json'));
  assert.equal(after.beats[0].wavSha256, before.beats[0].wavSha256); assert.equal(after.beats[0].cacheHit, true);
  assert.equal(after.beats[0].alignmentCacheHit, false); assert.equal(after.beats[0].transcription.cacheHit, true);
  assert.deepEqual((await f.calls()).map(call => call.command), ['doctor', 'render', 'align', 'transcribe', 'doctor', 'doctor', 'align', 'doctor']);
});

for (const corrupt of ['wav', 'alignment', 'synthesis'] as const) test(`retained ${corrupt} corruption is rejected without silently generating a replacement`, async () => {
  const f = await fixture(), first = await f.request('first'); assert.equal((await f.run(first.requestPath)).code, 0);
  const directory = path.join(first.outputDirectory, 'intro');
  if (corrupt === 'wav') {
    const pathToWav = path.join(directory, 'narration.wav'), bytes = await fs.readFile(pathToWav); bytes[50] ^= 1; await fs.writeFile(pathToWav, bytes);
  } else {
    const receiptPath = path.join(directory, `${corrupt}.json`), value = await readJSON(receiptPath);
    if (corrupt === 'alignment') value.words[0].text = 'Changed'; else value.identity = '0'.repeat(64);
    await fs.writeFile(receiptPath, JSON.stringify(value));
  }
  const second = await f.request('rejected', [{ id: 'reuse', text: canonicalText }], { reuseAudioDirectory: first.outputDirectory });
  const result = await f.run(second.requestPath); assert.equal(result.code, 1); assert.equal(result.last.code, 'AUDIO_RETAINED_PROVENANCE_MISMATCH');
  assert.equal((await f.calls()).filter(call => call.command === 'render').length, 1);
});

test('historical schema2 provision is readable but cannot start new synthesis without ASR provision', async () => {
  const f = await fixture();
  const { voices, defaultVoiceId: _default, models, ...base } = f.manifest;
  await fs.writeFile(path.join(f.directory, 'provision.json'), JSON.stringify({ ...base, schemaVersion: 2, voice: voices[0], models: { tts: models.tts, aligner: models.aligner } }));
  const request = await f.request('legacy'); assert.equal((await f.run(request.requestPath)).last.code, 'AUDIO_ASR_PROVISION_REQUIRED');
  assert.deepEqual(await f.calls(), []);
});

test('historical English audio without language fields reuses without changing retained bytes', async () => {
  const f = await fixture(), first = await f.request('historical-fixture'); assert.equal((await f.run(first.requestPath)).code, 0);
  const { voices, defaultVoiceId: _default, models, ...base } = f.manifest;
  const historical: HistoricalAudioProvision = { ...base, schemaVersion: 2, voice: voices[0], models: { tts: models.tts, aligner: models.aligner } };
  const provisionBytes = JSON.stringify(historical), identity = synthesisIdentity(historical);
  const narrationPath = path.join(first.outputDirectory, 'narration.json'), narration = await readJSON(narrationPath);
  delete narration.language; delete narration.beats[0].language; narration.synthesisIdentity = identity; narration.beats[0].synthesisIdentity = identity;
  narration.provisionManifestSha256 = digest(provisionBytes);
  await fs.writeFile(path.join(first.outputDirectory, 'provision.json'), provisionBytes);
  await fs.writeFile(narrationPath, JSON.stringify(narration));
  for (const name of ['synthesis', 'alignment']) {
    const receiptPath = path.join(first.outputDirectory, 'intro', `${name}.json`), receipt = await readJSON(receiptPath);
    receipt.identity = identity; delete receipt.generationProvision; delete receipt.language;
    if (name === 'synthesis') delete receipt.artifact.language; else delete receipt.provider.language;
    await fs.writeFile(receiptPath, JSON.stringify(receipt));
  }
  const historicalBytes = await fs.readFile(narrationPath);
  const second = await f.request('reuse-historical', [{ id: 'new-id', text: canonicalText }], { reuseAudioDirectory: first.outputDirectory });
  const result = await f.run(second.requestPath); assert.equal(result.code, 0, JSON.stringify(result));
  const output = await readJSON(path.join(second.outputDirectory, 'narration.json'));
  assert.equal(output.language, 'English'); assert.equal(output.beats[0].synthesisIdentity, identity); assert.equal(output.beats[0].cacheHit, true);
  assert.deepEqual(await fs.readFile(narrationPath), historicalBytes);
  assert.deepEqual((await f.calls()).map(call => call.command), ['doctor', 'render', 'align', 'transcribe', 'doctor', 'doctor', 'doctor']);
});

test('complete explicit reuse needs no selected provision, Voices executable, voice library or model cache',async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.directory,{recursive:true,force:true}));
  const first=await f.request('source');assert.equal((await f.run(first.requestPath)).code,0);
  const originals=await Promise.all(['narration.json','provision.json','intro/narration.wav','intro/synthesis.json','intro/alignment.json','intro/transcription.json'].map(async name=>[name,digest(await fs.readFile(path.join(first.outputDirectory,name)))]));
  await fs.rename(path.join(f.directory,'provision.json'),path.join(f.directory,'retired-provision.json'));
  await fs.rename(f.manifest.voicesExecutable,path.join(f.directory,'unavailable-voices.mjs'));
  await fs.rename(f.manifest.hubCacheDirectory,path.join(f.directory,'unavailable-models'));
  await fs.rename(f.manifest.voices[0].libraryPath,path.join(f.directory,'unavailable-library'));
  const before=(await f.calls()).length,runDirectory=path.join(f.directory,'offline');
  const result=await synthesizeNarration({runDirectory,beats:[{id:'reframed',text:canonicalText}],voiceId:f.manifest.defaultVoiceId,language:'English',reuseAudioDirectory:first.outputDirectory,provisionManifestPath:path.join(f.directory,'missing-provision.json')});
  assert.equal(result.reuseOnly,true);assert.equal(result.beats[0].cacheHit,true);
  assert.equal(result.beats[0].transcription?.cacheHit,true);assert.equal((await f.calls()).length,before);
  const wanted=[{id:'reframed',text:canonicalText}];
  assert.equal((await inspectRetainedNarration({directory:first.outputDirectory,beats:wanted,voiceId:f.manifest.defaultVoiceId,match:'id-and-text'})).complete,false,'a concrete identity check never substitutes another ID with the same text');
  const verified=await inspectRetainedNarration({directory:path.join(runDirectory,'audio'),beats:wanted,voiceId:f.manifest.defaultVoiceId,match:'id-and-text'});
  assert.equal(verified.complete,true,'editorial reuse creates the renamed phrase with its own verified receipts');
  assert.equal(verified.beats[0].directory,path.join(runDirectory,'audio','reframed'));
  for(const name of ['narration.wav','synthesis.json','alignment.json','transcription.json'])assert.deepEqual(await fs.readFile(path.join(runDirectory,'audio','reframed',name)),await fs.readFile(path.join(first.outputDirectory,'intro',name)));
  assert.deepEqual(await Promise.all(originals.map(async([name])=>[name,digest(await fs.readFile(path.join(first.outputDirectory,name)))])),originals);
  const third=await synthesizeNarration({runDirectory:path.join(f.directory,'offline-again'),beats:[{id:'another',text:canonicalText}],voiceId:f.manifest.defaultVoiceId,reuseAudioDirectory:path.join(runDirectory,'audio')});
  assert.equal(third.beats[0].wavSha256,result.beats[0].wavSha256);assert.equal(third.beats[0].transcription?.identity,result.beats[0].transcription?.identity);
  await assert.rejects(synthesizeNarration({runDirectory:path.join(f.directory,'needs-new-speech'),beats:[{id:'changed',text:'This changed phrase needs reviewed provisioning.'}],voiceId:f.manifest.defaultVoiceId,reuseAudioDirectory:first.outputDirectory,provisionManifestPath:path.join(f.directory,'missing-provision.json')}),/AUDIO_PROVISION_REQUIRED/);
  assert.equal((await f.calls()).length,before,'a missing phrase never executes old tool paths');
});

for(const stage of ['render','align','transcribe'] as const)test(`lost ${stage} commit adopts original valid products without repeating inference`,async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.directory,{recursive:true,force:true}));
  const first=await f.request('source');assert.equal((await f.run(first.requestPath)).code,0);
  const root=path.join(f.manifest.cacheDirectory,stage==='render'?'segments':stage==='align'?'alignments':'transcriptions'),name=(await fs.readdir(root))[0],cached=path.join(root,name);
  const prior=await inspectAudioAttempt({attemptPath:path.join(cached,'attempt.json')});assert.equal(prior.status,'completed');assert.equal(prior.processes.status,'stopped');
  const retained=await readJSON(path.join(cached,'attempt.json')),partial=`${cached}.partial-${retained.id}`;
  await fs.unlink(path.join(cached,stage==='render'?'segment.json':stage==='align'?'alignment.json':'transcription.json'));
  if(stage==='render'){await fs.unlink(path.join(cached,'synthesis.json'));await fs.unlink(path.join(cached,'narration.wav'));}
  await fs.rename(cached,partial);const attemptPath=path.join(partial,'attempt.json');
  const observed=await inspectAudioAttempt({attemptPath});assert.equal(observed.status,'incomplete');assert.equal(observed.adoptable,true);
  await assert.rejects(resolveAudioAttempt({attemptPath,resolution:'retry',note:'Do not waste a valid product.'}),{code:'AUDIO_ATTEMPT_VALID_PRODUCT_RETAINED'});
  const adopted=await resolveAudioAttempt({attemptPath,resolution:'adopt',note:'Verified original output survived the interrupted commit.'});assert.equal(adopted.status,'completed');assert.equal(adopted.id,retained.id);
  const rejoined=await resolveAudioAttempt({attemptPath,resolution:'adopt',note:'Verified original output survived the interrupted commit.'});assert.equal(rejoined.id,retained.id);assert.equal(rejoined.attemptPath,path.join(cached,'attempt.json'),'the original response-lost path rejoins its adopted identity');
  const second=await f.request('continued');assert.equal((await f.run(second.requestPath)).code,0);
  assert.deepEqual((await f.calls()).map(call=>call.command),['doctor','render','align','transcribe','doctor','doctor','doctor']);
  assert.ok(await fs.readFile(path.join(cached,`${stage}.stdout.json`)),'original provider output stays retained');
});

for(const stage of ['render','align','transcribe'] as const)test(`explicit retry releases only failed ${stage} and retains its diagnostics`,async t=>{
  const f=await fixture(`${stage}-fail`);t.after(()=>fs.rm(f.directory,{recursive:true,force:true}));
  const first=await f.request('failed');assert.equal((await f.run(first.requestPath)).code,1);
  const failure=await readJSON(path.join(first.outputDirectory,'failure.json')),attemptPath=failure.paths.attempt;
  const observed=await inspectAudioAttempt({attemptPath});assert.equal(observed.stage,stage);assert.equal(observed.adoptable,false);assert.equal(observed.processes.status,'stopped');
  await assert.rejects(resolveAudioAttempt({attemptPath,resolution:'adopt',note:'Incomplete output cannot be adopted.'}),{code:'AUDIO_ATTEMPT_OUTPUT_INCOMPLETE'});
  const resolved=await resolveAudioAttempt({attemptPath,resolution:'retry',note:'The stopped local stage did not produce a valid artifact.'});assert.equal(resolved.status,'retry-authorized');assert.equal(resolved.inference,false);
  await fs.writeFile(path.join(f.directory,'control.json'),JSON.stringify({mode:'normal'}));
  const second=await f.request('continued');assert.equal((await f.run(second.requestPath)).code,0);
  for(const command of ['render','align','transcribe'])assert.equal((await f.calls()).filter(call=>call.command===command).length,command===stage?2:1,`${command} repeats only if it was the released stage`);
  assert.match(await fs.readFile(path.join(path.dirname(attemptPath),`${stage}.stderr.log`),'utf8'),/synthetic/);
});

test('attempt resolution refuses a surviving worker/group and does not dispatch inference',async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.directory,{recursive:true,force:true}));
  const attempt=await createAudioCacheWork({stage:'align',identity:alignmentIdentity(f.manifest,'English'),text:canonicalText,language:'English',voiceId:f.manifest.defaultVoiceId,provision:f.manifest,wavPath:path.join(f.directory,'missing.wav'),wavSha256:'a'.repeat(64)}),attemptPath=path.join(attempt.work,'attempt.json');
  const state=await inspectAudioAttempt({attemptPath});assert.equal(state.processes.status,'running-or-unsettled');
  await assert.rejects(resolveAudioAttempt({attemptPath,resolution:'retry',note:'The original owner still runs.'}),{code:'AUDIO_ATTEMPT_PROCESS_UNSETTLED'});assert.deepEqual(await f.calls(),[]);
});

test('concurrent reservations retain one stage identity before either caller may dispatch',async t=>{
  const f=await fixture();t.after(()=>fs.rm(f.directory,{recursive:true,force:true}));
  const input={stage:'render' as const,identity:synthesisIdentity(f.manifest,'English'),text:canonicalText,language:'English' as const,voiceId:f.manifest.defaultVoiceId,provision:f.manifest};
  const results=await Promise.allSettled([createAudioCacheWork(input),createAudioCacheWork(input)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const rejected=results.find(result=>result.status==='rejected') as PromiseRejectedResult;
  assert.ok(['AUDIO_CACHE_BUSY','AUDIO_PARTIAL_SEGMENT_REQUIRES_RECONCILIATION'].includes(rejected.reason.code));
  const partials=await fs.readdir(path.join(f.manifest.cacheDirectory,'segments'));
  assert.equal(partials.length,1);assert.equal((await readJSON(path.join(f.manifest.cacheDirectory,'segments',partials[0],'attempt.json'))).identity,input.identity);
  assert.deepEqual(await f.calls(),[],'reservation itself never performs inference');
});

test('worker termination after synthesis leaves an adoptable same-identity attempt',async t=>{
  const f=await fixture('render-wait');t.after(()=>fs.rm(f.directory,{recursive:true,force:true}));const request=await f.request('interrupted');
  const child=spawn('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)(deny network*)',process.execPath,worker,request.requestPath],{cwd:f.directory,detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin',HOME:os.homedir()}}),closed=new Promise(resolve=>child.once('close',resolve));
  t.after(async()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}await closed;});
  let attemptPath='';
  for(let index=0;index<200;index++){
    const names=await fs.readdir(path.join(f.manifest.cacheDirectory,'segments')).catch(()=>[]);
    if(names.length){const directory=path.join(f.manifest.cacheDirectory,'segments',names[0]);try{const provider=await readJSON(path.join(directory,'render.stdout.json'));if(provider.artifact){attemptPath=path.join(directory,'attempt.json');break;}}catch{}}
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(attemptPath);const original=await readJSON(attemptPath);process.kill(child.pid!,'SIGKILL');await closed;
  const orphaned=await inspectAudioAttempt({attemptPath});assert.equal(orphaned.processes.originalWorkerPresent,false);assert.ok(orphaned.processes.remainingGroupMembers>0);
  await assert.rejects(resolveAudioAttempt({attemptPath,resolution:'adopt',note:'A surviving Voices child still owns the output.'}),{code:'AUDIO_ATTEMPT_PROCESS_UNSETTLED'});
  process.kill(-child.pid!,'SIGKILL');
  const adopted=await resolveAudioAttempt({attemptPath,resolution:'adopt',note:'Original worker and Voices stopped; its valid WAV and provenance are retained.'});assert.equal(adopted.id,original.id);assert.equal(adopted.status,'completed');
  await fs.writeFile(path.join(f.directory,'control.json'),JSON.stringify({mode:'normal'}));const next=await f.request('continued');assert.equal((await f.run(next.requestPath)).code,0);
  assert.equal((await f.calls()).filter(call=>call.command==='render').length,1);
});
