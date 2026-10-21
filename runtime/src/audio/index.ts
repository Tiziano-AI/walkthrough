import { open, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { runOwnedAudioProcess } from './process.ts';
import { readAudioProvision, audioEnvironment, audioLanguage, resolveProvisionVoice, type AudioLanguage } from './provision.ts';
import type { LexicalComparison } from './transcription.ts';
import {runtimePaths} from '../core/runtime-paths.ts';
import {reuseRetainedNarration} from './retained.ts';

export interface NarrationBeatInput { id: string; text: string }
export interface NarrationWord { text: string; startSeconds: number; endSeconds: number; charStart: number; charEnd: number; timingResolved: boolean }
export interface NarrationCaption { text: string; startSeconds: number; endSeconds: number }
export interface NarrationTranscription { identity: string; transcript: string; language: AudioLanguage; comparison: LexicalComparison; cacheHit: boolean; manifestPath: string; provider: unknown }
export interface NarrationBeat {
  id: string;
  text: string;
  wavPath: string;
  durationSeconds: number;
  words: NarrationWord[];
  captions: NarrationCaption[];
  cacheHit: boolean;
  wavSha256: string;
  unresolvedWordCount: number;
  language?: AudioLanguage;
  synthesisIdentity?: string;
  alignmentIdentity?: string;
  alignmentCacheHit?: boolean;
  transcription?: NarrationTranscription;
  metrics: { durationSeconds: number; sampleRate: number; channels: number; peak: number; rms: number; clippedSampleFraction: number; wordsPerMinute: number };
}
export interface NarrationResult {
  schemaVersion: 1;
  voiceId: string;
  language: AudioLanguage;
  beats: NarrationBeat[];
  manifestPath: string;
  vttPath: string;
  spokenContentVerified: false;
  humanListeningRequired: true;
  reuseOnly?:boolean;
  reuseSource?:{manifestPath:string;sha256:string};
}
export interface SynthesizeNarrationInput {
  runDirectory: string;
  beats: NarrationBeatInput[];
  provisionManifestPath?: string;
  voiceId?: string;
  language?: AudioLanguage;
  reuseAudioDirectory?: string;
  signal?: AbortSignal;
}

/** Never sends canonical text/audio/logs to a hosted service. All child output
 * stays in the local run; thrown messages contain a bounded lifecycle code only.
 * A successful alignment is not evidence that every word was actually spoken.
 */
export async function synthesizeNarration(input: SynthesizeNarrationInput): Promise<NarrationResult> {
  if (input.signal?.aborted) throw new Error('AUDIO_ABORTED');
  if (!isAbsolute(input.runDirectory)) throw new Error('AUDIO_ABSOLUTE_RUN_DIRECTORY_REQUIRED');
  if (!input.beats.length || new Set(input.beats.map(b => b.id)).size !== input.beats.length || input.beats.some(b => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(b.id) || !b.text.trim() || b.text.trim() !== b.text)) {
    throw new Error('AUDIO_INVALID_BEATS');
  }
  const {runtimeRoot:root,audioProvisionPath,audioCacheDirectory}=runtimePaths();
  if(input.reuseAudioDirectory!==undefined){
    if(!isAbsolute(input.reuseAudioDirectory))throw new Error('AUDIO_ABSOLUTE_REUSE_DIRECTORY_REQUIRED');
    await mkdir(input.runDirectory,{recursive:true});
    const retained=await reuseRetainedNarration({directory:input.reuseAudioDirectory,beats:input.beats,voiceId:input.voiceId,language:input.language,outputDirectory:join(input.runDirectory,'audio')});
    if(retained)return retained;
  }
  const provisionManifestPath = input.provisionManifestPath ?? audioProvisionPath;
  if (!isAbsolute(provisionManifestPath)) throw new Error('AUDIO_ABSOLUTE_PROVISION_PATH_REQUIRED');
  const manifest = await readAudioProvision(provisionManifestPath);
  const voiceId = resolveProvisionVoice(manifest, input.voiceId).id;
  const language = audioLanguage(input.language);
  if (manifest.schemaVersion !== 3) throw new Error('AUDIO_ASR_PROVISION_REQUIRED');
  if (input.reuseAudioDirectory !== undefined && !isAbsolute(input.reuseAudioDirectory)) throw new Error('AUDIO_ABSOLUTE_REUSE_DIRECTORY_REQUIRED');
  if(manifest.cacheDirectory!==audioCacheDirectory)throw new Error('AUDIO_CACHE_LOCATION_NOT_PROVISIONED');
  const outputDirectory = join(input.runDirectory, 'audio');
  await mkdir(input.runDirectory, { recursive: true });
  // Never overwrite an earlier audio operation or silently replay a partial run.
  await mkdir(outputDirectory);
  const requestPath = join(outputDirectory, 'request.json');
  await writeFile(requestPath, JSON.stringify({ beats: input.beats, voiceId, language, reuseAudioDirectory: input.reuseAudioDirectory, outputDirectory, provisionManifestPath,cacheDirectory:audioCacheDirectory }, null, 2), { flag: 'wx', mode: 0o600 });
  const stdout = await open(join(outputDirectory, 'runtime.stdout.log'), 'wx', 0o600);
  const stderr = await open(join(outputDirectory, 'runtime.stderr.log'), 'wx', 0o600);
  try {
    await runOwnedAudioProcess({
      executable: '/usr/bin/sandbox-exec', args: ['-p', '(version 1)(allow default)(deny network*)', process.execPath, join(root, 'src/audio/worker.ts'), requestPath],
      cwd: root,
      // No inherited credentials, proxy settings, Python injection, or user
      // model overrides cross into the strict-local process tree.
      env: audioEnvironment(manifest, outputDirectory),
      stdout: stdout.fd, stderr: stderr.fd, stdoutPath: join(outputDirectory, 'runtime.stdout.log'), stderrPath: join(outputDirectory, 'runtime.stderr.log'), signal: input.signal,
    });
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
  const result = JSON.parse(await readFile(join(outputDirectory, 'narration.json'), 'utf8')) as NarrationResult;
  if (result.schemaVersion !== 1 || result.voiceId !== voiceId || result.language !== language || result.beats.length !== input.beats.length || result.spokenContentVerified !== false) throw new Error('AUDIO_RESULT_INVALID');
  return result;
}
