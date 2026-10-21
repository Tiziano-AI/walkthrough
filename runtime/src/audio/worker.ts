/** Fixed local worker. ML inference belongs exclusively to the public Voices CLI. */
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, writeFile, mkdir, rename, copyFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioEnvironment, readAudioProvision, validateAudioProvision, verifyAudioProvision, synthesisIdentity, alignmentIdentity, transcriptionIdentity, stableJson, digestFile, audioLanguage, resolveProvisionVoice } from './provision.ts';
import type { AudioProvision, AudioLanguage } from './provision.ts';
import { compareTranscript } from './transcription.ts';
import { canonicalWords, captionCues, vttTime } from './captions.ts';
import {verifyRuntime,verifyRenderedArtifact,verifyAlignedArtifact,verifyTranscribedArtifact} from './artifacts.ts';
import {createAudioCacheWork} from './attempts.ts';
import { audioMetrics } from './wav.ts';
import type { NarrationBeat, NarrationBeatInput, NarrationCaption } from './index.ts';
import {AudioCommandFailure,safeProviderError,withAudioFailure,type AudioCommandDiagnostic,type AudioFailureContext} from './failure.ts';

const json = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'));
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

/** UDP connect sends no packet. Both loopback and external access must fail at OS boundary. */
export async function verifyAudioNetworkDenial(): Promise<void> {
  for (const address of ['192.0.2.1', '127.0.0.1']) {
    await new Promise<void>((accept, reject) => {
      const socket = createSocket('udp4');
      const complete = (error?: NodeJS.ErrnoException) => {
        socket.close();
        if (error?.code === 'EPERM' || error?.code === 'EACCES') accept();
        else reject(new Error('AUDIO_NETWORK_SANDBOX_NOT_ACTIVE'));
      };
      socket.once('error', complete);
      socket.connect(9, address, () => complete());
    });
  }
}

/** No shell, download wrapper, inherited overrides, or alternate inference path. */
export async function voicesJson(manifest: AudioProvision, args: string[], directory: string, name: string): Promise<any> {
  const stdoutPath = join(directory, `${name}.stdout.json`);
  const stderrPath = join(directory, `${name}.stderr.log`);
  const stdout = await open(stdoutPath, 'wx', 0o600);
  const stderr = await open(stderrPath, 'wx', 0o600);
  let outcome: AudioCommandDiagnostic['child'];
  try {
    outcome = await new Promise<AudioCommandDiagnostic['child']>((accept) => {
      const child = spawn(manifest.voicesExecutable, ['--json', ...args], {
        cwd: directory, env: audioEnvironment(manifest, directory),
        stdio: ['ignore', stdout.fd, stderr.fd],
      });
      // Clear the bound on close, including launch failure (which has no exit
      // event). A failed spawn must not keep the worker alive behind its error.
      const timeout=setTimeout(()=>child.kill(),1_200_000);timeout.unref();
      let startFailed = false;
      child.once('error', () => { startFailed = true; });
      child.once('close', (code,signal) => {clearTimeout(timeout);accept({exitCode:code,signal,startFailed});});
    });
  } finally { await Promise.all([stdout.close(), stderr.close()]); }
  let response: AudioCommandDiagnostic['response']='unreadable',value:any;
  let handle;
  try {
    handle=await open(stdoutPath,'r');
    const bytes=Buffer.alloc(10_000_001),{bytesRead}=await handle.read(bytes,0,bytes.length,0);
    if(bytesRead>10_000_000)response='too-large';
    else try{value=JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));response='json';}catch{response='invalid';}
  } catch { /* The failed child outcome remains available even if its output cannot be read. */ }
  finally { await handle?.close(); }
  const diagnostic:AudioCommandDiagnostic={child:outcome,response,providerError:safeProviderError(value?.error),paths:{providerStdout:stdoutPath,providerStderr:stderrPath}};
  if(outcome.exitCode!==0||outcome.startFailed||outcome.signal||value?.error)throw new AudioCommandFailure('AUDIO_VOICES_COMMAND_FAILED',diagnostic);
  if(response!=='json')throw new AudioCommandFailure(response==='too-large'?'AUDIO_VOICES_RESPONSE_TOO_LARGE':'AUDIO_VOICES_RESPONSE_INVALID',diagnostic);
  return value;
}

export {verifyRuntime,verifyRenderedArtifact,verifyAlignedArtifact,verifyTranscribedArtifact} from './artifacts.ts';
async function containedFile(directory: string, path: unknown): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('AUDIO_OUTPUT_PATH_ESCAPE');
  const actual = await realpath(path);
  if (!actual.startsWith(await realpath(directory) + sep) || !(await stat(actual)).isFile()) throw new Error('AUDIO_OUTPUT_PATH_ESCAPE');
  return actual;
}


async function retainedAudio(directory: unknown, manifest: AudioProvision, voiceId: string, language: AudioLanguage) {
  if (directory === undefined) return undefined;
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('AUDIO_ABSOLUTE_REUSE_DIRECTORY_REQUIRED');
  const root = await realpath(directory);
  const narration = await json(await containedFile(root, join(root, 'narration.json')));
  const provisionPath = await containedFile(root, join(root, 'provision.json'));
  if (await digestFile(provisionPath) !== narration.provisionManifestSha256) throw new Error('AUDIO_RETAINED_PROVENANCE_MISMATCH');
  const provision = validateAudioProvision(await json(provisionPath));
  if (narration.schemaVersion !== 1 || !Array.isArray(narration.beats)) throw new Error('AUDIO_RETAINED_PROVENANCE_MISMATCH');
  const matching = narration.voiceId === voiceId && audioLanguage(narration.language) === language;
  return { root, narration, provision, matching, currentVoice: resolveProvisionVoice(manifest, voiceId) };
}

async function retainedPhrase(retained: Awaited<ReturnType<typeof retainedAudio>>, text: string, language: AudioLanguage, voiceId: string) {
  if (!retained?.matching) return undefined;
  const beat = retained.narration.beats.find((beat: any) => beat.text === text);
  if (!beat) return undefined;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(beat.id)) throw new Error('AUDIO_RETAINED_PROVENANCE_MISMATCH');
  const directory = join(retained.root, beat.id);
  const wavPath = await containedFile(retained.root, join(directory, 'narration.wav'));
  const synthesis = await json(await containedFile(retained.root, join(directory, 'synthesis.json')));
  const alignment = await json(await containedFile(retained.root, join(directory, 'alignment.json')));
  const synthesisProvision = synthesis.generationProvision ? validateAudioProvision(synthesis.generationProvision) : retained.provision;
  const alignProvision = alignment.generationProvision ? validateAudioProvision(alignment.generationProvision) : retained.provision;
  const voice = resolveProvisionVoice(synthesisProvision, voiceId);
  const wavSha256 = await digestFile(wavPath), metrics = audioMetrics(await readFile(wavPath), text);
  const identity = synthesisIdentity(synthesisProvision, language, voiceId), alignIdentity = alignmentIdentity(alignProvision, language);
  if (beat.wavSha256 !== wavSha256 || synthesis.wavSha256 !== wavSha256 || synthesis.text !== text || synthesis.identity !== identity
    || alignment.wavSha256 !== wavSha256 || alignment.text !== text || alignment.alignmentIdentity !== alignIdentity
    || alignment.identity !== identity) throw new Error('AUDIO_RETAINED_PROVENANCE_MISMATCH');
  verifyRenderedArtifact(synthesis.artifact, text, synthesisProvision, language, voiceId);
  const words = verifyAlignedArtifact(alignment.provider, text, wavSha256, metrics.durationSeconds, alignProvision, language);
  if (stableJson(alignment.words) !== stableJson(words)) throw new Error('AUDIO_RETAINED_PROVENANCE_MISMATCH');
  if (stableJson(voice.files) !== stableJson(retained.currentVoice.files)) return undefined;
  return { wavPath, wavSha256, metrics, synthesis: { ...synthesis, generationProvision: synthesisProvision }, identity, alignIdentity,
    aligned: alignment.provider, alignProvision, words, synthesisCacheHit: true, alignmentCacheHit: true };
}

export async function runAudioRequest(requestPath: string): Promise<void> {
  const request = await json(requestPath);
  const provisionBytes = await readFile(request.provisionManifestPath);
  const provisionSha256 = createHash('sha256').update(provisionBytes).digest('hex');
  const manifest = await readAudioProvision(request.provisionManifestPath);
  if(typeof request.cacheDirectory!=='string'||!isAbsolute(request.cacheDirectory)||request.cacheDirectory!==manifest.cacheDirectory)throw new Error('AUDIO_CACHE_LOCATION_NOT_PROVISIONED');
  if (await digestFile(request.provisionManifestPath) !== provisionSha256) throw new Error('AUDIO_PROVISION_CHANGED_DURING_RUN');
  const runRoot = await realpath(dirname(requestPath));
  if (request.outputDirectory !== runRoot || basename(requestPath) !== 'request.json') throw new Error('AUDIO_REQUEST_PATH_INVALID');
  const voice = resolveProvisionVoice(manifest, request.voiceId);
  const language = audioLanguage(request.language);
  if (manifest.schemaVersion !== 3) throw new Error('AUDIO_ASR_PROVISION_REQUIRED');
  const beats: NarrationBeatInput[] = request.beats;
  if (!Array.isArray(beats) || !beats.length || new Set(beats.map(b => b.id)).size !== beats.length
    || beats.some(b => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(b.id))) throw new Error('AUDIO_INVALID_BEATS');
  for (const beat of beats) canonicalWords(beat.text);
  const context:AudioFailureContext={phraseId:null,operation:'preflight',paths:{}};
  return withAudioFailure(runRoot,context,async()=>{
  await verifyAudioNetworkDenial();
  await verifyAudioProvision(manifest);
  await writeFile(join(runRoot, 'provision.json'), provisionBytes, { flag: 'wx', mode: 0o600 });
  context.operation='doctor';
  const doctor = await voicesJson(manifest, ['doctor'], runRoot, 'voices-doctor');
  verifyRuntime(doctor.runtime, manifest);
  // Path-independent immutable identities never relabel historically generated speech.
  const identity = synthesisIdentity(manifest, language, voice.id);
  const alignIdentity = alignmentIdentity(manifest, language);
  const transcribeIdentity = transcriptionIdentity(manifest, language);
  const retained = await retainedAudio(request.reuseAudioDirectory, manifest, voice.id, language);
  const results: NarrationBeat[] = [];
  const allCues: NarrationCaption[] = [];
  let elapsed = 0;
  for (const beat of beats) {
    context.phraseId=beat.id;context.operation='cache';context.paths={};
    let phrase = await retainedPhrase(retained, beat.text, language, voice.id);
    if (!phrase) {
      const segment = await createAudioCacheWork({stage:'render',identity,text:beat.text,language,voiceId:voice.id,provision:manifest});
      const { work, cached, reused } = segment;
      context.paths.segmentDirectory = work;
      context.paths.attempt=join(work,'attempt.json');
      console.log(JSON.stringify({ status: 'beat-started', beatId: beat.id, cacheHit: reused }));
      if (!reused) {
        const textPath = join(work, 'canonical.txt');
        await writeFile(textPath, beat.text, { flag: 'wx', mode: 0o600 });
        context.operation = 'render';
        const rendered = await voicesJson(manifest, ['render', voice.id, '--text-file', textPath, '--language', language, '--library', voice.libraryPath,
          '--out-dir', join(work, 'voices'), '--model-revision', manifest.models.tts.revision], work, 'render');
        verifyRuntime(rendered.artifact?.runtime, manifest);
        verifyRenderedArtifact(rendered.artifact, beat.text, manifest, language, voice.id);
        const sourceWav = await containedFile(work, rendered.paths?.wav), sidecar = await containedFile(work, rendered.paths?.sidecar);
        if (basename(sourceWav) !== rendered.artifact.output_audio || stableJson(await json(sidecar)) !== stableJson(rendered.artifact)) throw new Error('AUDIO_GENERATION_PROVENANCE_MISMATCH');
        await copyFile(sourceWav, join(work, 'narration.wav'), constants.COPYFILE_FICLONE);
        const wavSha256 = await digestFile(join(work, 'narration.wav'));
        audioMetrics(await readFile(join(work, 'narration.wav')), beat.text);
        await save(join(work, 'synthesis.json'), { identity, text: beat.text, language, wavSha256, artifact: rendered.artifact, generationProvision: manifest });
        await save(join(work, 'segment.json'), { schemaVersion: 3, identity, text: beat.text, language, wavSha256 });
        await rename(work, cached);
      }
      context.operation = 'cache';
      const wavPath = join(cached, 'narration.wav'), entry = await json(join(cached, 'segment.json')), synthesis = await json(join(cached, 'synthesis.json'));
      const wavSha256 = await digestFile(wavPath), metrics = audioMetrics(await readFile(wavPath), beat.text);
      if (![2, 3].includes(entry.schemaVersion) || entry.identity !== identity || entry.text !== beat.text || entry.wavSha256 !== wavSha256
        || synthesis.identity !== identity || synthesis.text !== beat.text || synthesis.wavSha256 !== wavSha256
        || audioLanguage(synthesis.language) !== language) throw new Error('AUDIO_CACHE_CORRUPTION');
      verifyRenderedArtifact(synthesis.artifact, beat.text, manifest, language, voice.id);
      let aligned: any, alignmentCacheHit: boolean;
      if (entry.schemaVersion === 2 && entry.alignmentIdentity === alignIdentity) {
        aligned = await json(join(cached, 'align.stdout.json')); alignmentCacheHit = true;
      } else {
        const alignment = await createAudioCacheWork({stage:'align',identity:alignIdentity,text:beat.text,language,voiceId:voice.id,provision:manifest,wavPath,wavSha256});
        alignmentCacheHit = alignment.reused;
        if (!alignment.reused) {
          context.operation = 'align'; context.paths.segmentDirectory = alignment.work;context.paths.attempt=join(alignment.work,'attempt.json');
          const textPath = join(alignment.work, 'canonical.txt');
          await writeFile(textPath, beat.text, { flag: 'wx', mode: 0o600 });
          const result = await voicesJson(manifest, ['align', '--audio', wavPath, '--text-file', textPath, '--language', language,
            '--model-revision', manifest.models.aligner.revision], alignment.work, 'align');
          verifyRuntime(result.runtime, manifest);
          verifyAlignedArtifact(result, beat.text, wavSha256, metrics.durationSeconds, manifest, language);
          await save(join(alignment.work, 'alignment.json'), { identity: alignIdentity, text: beat.text, language, wavSha256, provider: result });
          await rename(alignment.work, alignment.cached);
        }
        const receipt = await json(join(alignment.cached, 'alignment.json'));
        if (receipt.identity !== alignIdentity || receipt.text !== beat.text || receipt.wavSha256 !== wavSha256 || receipt.language !== language) throw new Error('AUDIO_CACHE_CORRUPTION');
        aligned = receipt.provider;
      }
      const words = verifyAlignedArtifact(aligned, beat.text, wavSha256, metrics.durationSeconds, manifest, language);
      phrase = { wavPath, wavSha256, metrics, synthesis: { ...synthesis, generationProvision: synthesis.generationProvision ?? manifest }, identity, alignIdentity, aligned, alignProvision: manifest, words,
        synthesisCacheHit: reused, alignmentCacheHit };
    }
    const { wavSha256, metrics, words, aligned, synthesis } = phrase;
    const captions = captionCues(beat.text, words, language);
    context.paths = { narrationWav: phrase.wavPath };
    const transcription = await createAudioCacheWork({stage:'transcribe',identity:transcribeIdentity,text:beat.text,language,voiceId:voice.id,provision:manifest,wavPath:phrase.wavPath,wavSha256});
    if (!transcription.reused) {
      context.operation = 'transcribe'; context.paths.segmentDirectory = transcription.work;context.paths.attempt=join(transcription.work,'attempt.json');
      const provider = await voicesJson(manifest, ['transcribe', '--audio', phrase.wavPath, '--language', language, '--model-revision', manifest.models.asr.revision], transcription.work, 'transcribe');
      verifyRuntime(provider.runtime, manifest);
      verifyTranscribedArtifact(provider, wavSha256, metrics.durationSeconds, manifest, language);
      await save(join(transcription.work, 'transcription.json'), { identity: transcribeIdentity, language, wavSha256, provider });
      await rename(transcription.work, transcription.cached);
    }
    const transcriptReceipt = await json(join(transcription.cached, 'transcription.json'));
    context.paths.segmentDirectory = transcription.cached;
    if (transcriptReceipt.identity !== transcribeIdentity || transcriptReceipt.language !== language || transcriptReceipt.wavSha256 !== wavSha256) throw new Error('AUDIO_CACHE_CORRUPTION');
    verifyTranscribedArtifact(transcriptReceipt.provider, wavSha256, metrics.durationSeconds, manifest, language);
    const comparison = compareTranscript(beat.text, transcriptReceipt.provider.transcript);
    const target = join(runRoot, beat.id);
    await mkdir(target);
    const wavPath = join(target, 'narration.wav');
    await copyFile(phrase.wavPath, wavPath, constants.COPYFILE_FICLONE);
    await save(join(target, 'alignment.json'), { schemaVersion: 2, identity: phrase.identity, alignmentIdentity: phrase.alignIdentity, text: beat.text, language, wavSha256,
      generationProvision: phrase.alignProvision, metrics, words, captions, timingBasis: aligned.timing_basis, timingDiagnostics: aligned.timing_diagnostics,
      diagnosticLimit: aligned.diagnostic_limit, provider: aligned, spokenContentVerified: false });
    await save(join(target, 'synthesis.json'), synthesis);
    const transcriptionPath = join(target, 'transcription.json');
    await save(transcriptionPath, { ...transcriptReceipt, transcript: transcriptReceipt.provider.transcript, comparison, generationProvision:manifest });
    const result: NarrationBeat = { id: beat.id, text: beat.text, wavPath, durationSeconds: metrics.durationSeconds, metrics, words, captions,
      language, synthesisIdentity: phrase.identity, alignmentIdentity: phrase.alignIdentity, alignmentCacheHit: phrase.alignmentCacheHit,
      transcription: { identity: transcribeIdentity, transcript: transcriptReceipt.provider.transcript, language, comparison, cacheHit: transcription.reused, manifestPath: transcriptionPath, provider: transcriptReceipt.provider },
      cacheHit: phrase.synthesisCacheHit, wavSha256, unresolvedWordCount: words.filter(word => !word.timingResolved).length };
    results.push(result);
    allCues.push(...captions.map(cue => ({ ...cue, startSeconds: cue.startSeconds + elapsed, endSeconds: cue.endSeconds + elapsed })));
    elapsed += metrics.durationSeconds;
    console.log(JSON.stringify({ status: 'beat-completed', beatId: beat.id, durationSeconds: metrics.durationSeconds, cacheHit: result.cacheHit, transcription: comparison.status, unresolvedWordCount: result.unresolvedWordCount }));
  }
  // Detect a canonical product upgrade or reference/model mutation during this operation.
  context.phraseId=null;context.operation='final-doctor';context.paths={};
  const finalDoctor = await voicesJson(manifest, ['doctor'], runRoot, 'voices-doctor-final');
  context.operation='final-verification';
  verifyRuntime(finalDoctor.runtime, manifest);
  await verifyAudioProvision(manifest);
  if (await digestFile(request.provisionManifestPath) !== provisionSha256) throw new Error('AUDIO_PROVISION_CHANGED_DURING_RUN');
  context.operation='manifest';
  const vttPath = join(runRoot, 'narration.vtt');
  await writeFile(vttPath, 'WEBVTT\n\n' + allCues.map((cue, index) => `${index + 1}\n${vttTime(cue.startSeconds)} --> ${vttTime(cue.endSeconds)}\n${cue.text}`).join('\n\n') + '\n', { flag: 'wx', mode: 0o600 });
  const manifestPath = join(runRoot, 'narration.json');
  await save(manifestPath, { schemaVersion: 1, voiceId: voice.id, language, beats: results, manifestPath, vttPath,
    provisionManifestSha256: provisionSha256, provisionManifestPath: join(runRoot, 'provision.json'), runtime: manifest.runtime,
    synthesisIdentity: identity, alignmentIdentity: alignIdentity, transcriptionIdentity: transcribeIdentity, networkPolicy: 'OS deny network*; internet and loopback denied',
    spokenContentVerified: false, humanListeningRequired: true });
  console.log(JSON.stringify({ status: 'completed', beatCount: results.length, durationSeconds: elapsed }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runAudioRequest(process.argv[2]); }
  catch (error) {
    const code = error instanceof Error && /^AUDIO_[A-Z0-9_]+$/.test(error.message) ? error.message : 'AUDIO_RUNTIME_FAILED';
    console.log(JSON.stringify({ status: 'failed', code }));
    process.exitCode = 1;
  }
}
