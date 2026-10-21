import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveLocalTools } from '../core/toolchain.ts';
import type { LocalTools } from '../core/contracts.ts';

export interface AudioRuntime {
  python: string; executable: string; platform: string; voices_version: string;
  source_sha256: string; source_scope: 'installed-python-source-at-observation';
  packages: Record<string, string>; package_scope: 'selected-runtime-dependencies';
}
export interface AudioModelFile { path: string; size: number; sha256: string }
export interface AudioResolverTree { sha256: string; size: number }
export interface AudioModel { repository: string; revision: string; snapshotPath: string; files: AudioModelFile[]; resolverTree: AudioResolverTree }
export type AudioLanguage = 'English' | 'Italian';
export interface AudioVoice { id: string; libraryPath: string; files: Record<'reference.wav' | 'reference.txt' | 'voice.json', string> }
interface AudioProvisionBase {
  voicesExecutable: string;
  hubCacheDirectory: string;
  cacheDirectory: string;
  runtime: AudioRuntime;
}
/** Historical manifests remain readable without rewriting their retained bytes. */
export interface HistoricalAudioProvision extends AudioProvisionBase { schemaVersion: 2; models: { tts: AudioModel; aligner: AudioModel }; voice: AudioVoice }
export interface CurrentAudioProvision extends AudioProvisionBase { schemaVersion: 3; models: { tts: AudioModel; aligner: AudioModel; asr: AudioModel }; defaultVoiceId: string; voices: AudioVoice[] }
export type AudioProvision = HistoricalAudioProvision | CurrentAudioProvision;

export const AUDIO_MODELS = {
  tts: { repository: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16', revision: 'a6eb4f68e4b056f1215157bb696209bc82a6db48' },
  aligner: { repository: 'mlx-community/Qwen3-ForcedAligner-0.6B-bf16', revision: '53c8c0e46733eec430e4b53dd6471d0e5dee45f8' },
  asr: { repository: 'mlx-community/Qwen3-ASR-1.7B-bf16', revision: 'e1f6c266914abc5a46e8756e02580f834a6cf8a7' },
} as const;
export function audioLanguage(value: unknown = 'English'): AudioLanguage {
  if (value !== 'English' && value !== 'Italian') throw new Error('AUDIO_UNSUPPORTED_LANGUAGE');
  return value;
}
export const provisionVoices = (manifest: AudioProvision): AudioVoice[] => manifest.schemaVersion === 2 ? [manifest.voice] : manifest.voices;
export const defaultVoiceId = (manifest: AudioProvision): string => manifest.schemaVersion === 2 ? manifest.voice.id : manifest.defaultVoiceId;
export function resolveProvisionVoice(manifest: AudioProvision, id = defaultVoiceId(manifest)): AudioVoice {
  const voice = provisionVoices(manifest).find(voice => voice.id === id);
  if (!voice) throw new Error('AUDIO_UNPROVISIONED_VOICE');
  return voice;
}
export const VOICE_FILES = ['reference.wav', 'reference.txt', 'voice.json'] as const;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const absolute = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const invalid = (): never => { throw new Error('AUDIO_PROVISION_SCHEMA'); };

/** Pure shape check shared by readers and the explicit candidate builder. */
export function validateAudioProvision(value: unknown): AudioProvision {
  if (!record(value) || ![2, 3].includes(value.schemaVersion as number)
    || !exactKeys(value, ['schemaVersion', 'voicesExecutable', 'hubCacheDirectory', 'cacheDirectory', 'runtime', 'models', ...(value.schemaVersion === 2 ? ['voice'] : ['defaultVoiceId', 'voices'])])) invalid();
  const manifest = value as Record<string, unknown>;
  if (!absolute(manifest.voicesExecutable) || !absolute(manifest.hubCacheDirectory) || !absolute(manifest.cacheDirectory)) invalid();
  const runtime = manifest.runtime;
  if (!record(runtime) || !exactKeys(runtime, ['python', 'executable', 'platform', 'voices_version', 'source_sha256', 'source_scope', 'packages', 'package_scope'])) invalid();
  const fields = runtime as Record<string, unknown>;
  if (!nonempty(fields.python) || !absolute(fields.executable) || !nonempty(fields.platform) || !nonempty(fields.voices_version) || !sha(fields.source_sha256)
    || fields.source_scope !== 'installed-python-source-at-observation' || fields.package_scope !== 'selected-runtime-dependencies'
    || !record(fields.packages) || !Object.keys(fields.packages).length || Object.entries(fields.packages).some(([name, version]) => !nonempty(name) || !nonempty(version))) invalid();
  const roles: (keyof typeof AUDIO_MODELS)[] = manifest.schemaVersion === 2 ? ['tts', 'aligner'] : ['tts', 'aligner', 'asr'];
  if (!record(manifest.models) || !exactKeys(manifest.models, roles)) invalid();
  for (const role of roles) {
    const model = (manifest.models as Record<string, unknown>)[role];
    if (!record(model) || !exactKeys(model, ['repository', 'revision', 'snapshotPath', 'files', 'resolverTree'])) invalid();
    const entry = model as Record<string, unknown>;
    if (entry.repository !== AUDIO_MODELS[role].repository || entry.revision !== AUDIO_MODELS[role].revision || !absolute(entry.snapshotPath) || !Array.isArray(entry.files) || !entry.files.length || entry.files.length > 10_000) invalid();
    if (!record(entry.resolverTree) || !exactKeys(entry.resolverTree, ['sha256', 'size']) || !sha(entry.resolverTree.sha256)
      || !Number.isSafeInteger(entry.resolverTree.size) || (entry.resolverTree.size as number) <= 0 || (entry.resolverTree.size as number) > 16 * 1024 * 1024) invalid();
    const expectedPath = join(manifest.hubCacheDirectory as string, `models--${AUDIO_MODELS[role].repository.replaceAll('/', '--')}`, 'snapshots', AUDIO_MODELS[role].revision);
    if (entry.snapshotPath !== expectedPath) invalid();
    const paths = new Set<string>();
    for (const file of entry.files as unknown[]) {
      if (!record(file) || !exactKeys(file, ['path', 'size', 'sha256']) || !nonempty(file.path) || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..')
        || isAbsolute(file.path) || !Number.isSafeInteger(file.size) || (file.size as number) < 0 || !sha(file.sha256) || paths.has(file.path)) invalid();
      paths.add((file as AudioModelFile).path);
    }
  }
  const voices = manifest.schemaVersion === 2 ? [manifest.voice] : manifest.voices;
  if (!Array.isArray(voices) || !voices.length || voices.length > 100) invalid();
  const ids = new Set<string>();
  for (const voice of voices as unknown[]) {
    if (!record(voice) || !exactKeys(voice, ['id', 'libraryPath', 'files'])) invalid();
    const speaker = voice as Record<string, unknown>;
    if (typeof speaker.id !== 'string' || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(speaker.id) || !absolute(speaker.libraryPath)
      || !record(speaker.files) || !exactKeys(speaker.files, VOICE_FILES) || Object.values(speaker.files).some(value => !sha(value))) invalid();
    if (ids.has(speaker.id as string)) invalid();
    ids.add(speaker.id as string);
  }
  if (manifest.schemaVersion === 3 && !ids.has(manifest.defaultVoiceId as string)) invalid();
  return manifest as unknown as AudioProvision;
}

export async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  try { for await (const chunk of createReadStream(path)) hash.update(chunk); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new Error('AUDIO_PROVISION_MISSING_FILE');
    throw error;
  }
  return hash.digest('hex');
}

export function resolverTreePath(hubCacheDirectory: string, model: Pick<AudioModel, 'repository' | 'revision'>): string {
  return join(hubCacheDirectory, `models--${model.repository.replaceAll('/', '--')}`, 'trees', `${model.revision}.json`);
}

/** Observe existing HF-owned resolver metadata, never construct or repair it.
 * Byte integrity is a prerequisite, not proof that Voices resolves offline. */
export async function readResolverTree(hubCacheDirectory: string, model: Pick<AudioModel, 'repository' | 'revision'>): Promise<AudioResolverTree> {
  const path = resolverTreePath(hubCacheDirectory, model);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size <= 0 || info.size > 16 * 1024 * 1024) throw new Error('AUDIO_MODEL_RESOLVER_TREE_INVALID');
    return { size: info.size, sha256: await digestFile(path) };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') || (error instanceof Error && error.message === 'AUDIO_PROVISION_MISSING_FILE')) {
      throw new Error('AUDIO_MODEL_RESOLVER_TREE_MISSING');
    }
    throw error;
  }
}

async function presence(manifest: AudioProvision): Promise<void> {
  const inspect = async (path: string, directory = false) => {
    const code = directory ? 'AUDIO_PROVISION_MISSING_DIRECTORY' : 'AUDIO_PROVISION_MISSING_FILE';
    try {
      const info = await stat(path);
      if (directory ? !info.isDirectory() : !info.isFile()) throw new Error(code);
      return info;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new Error(code);
      throw error;
    }
  };
  for (const path of [manifest.voicesExecutable, manifest.runtime.executable]) await inspect(path);
  for (const path of [manifest.hubCacheDirectory, manifest.cacheDirectory]) await inspect(path, true);
  for (const voice of provisionVoices(manifest)) {
    await inspect(voice.libraryPath, true);
    for (const name of VOICE_FILES) await inspect(join(voice.libraryPath, voice.id, name));
  }
  for (const model of Object.values(manifest.models)) {
    const resolverTree = await readResolverTree(manifest.hubCacheDirectory, model);
    if (resolverTree.size !== model.resolverTree.size || resolverTree.sha256 !== model.resolverTree.sha256) throw new Error('AUDIO_MODEL_RESOLVER_TREE_DRIFT');
    await inspect(model.snapshotPath, true);
    for (const file of model.files) {
      const info = await inspect(join(model.snapshotPath, file.path));
      if (info.size !== file.size) throw new Error('AUDIO_MODEL_FILE_SIZE_MISMATCH');
    }
  }
}

export async function readAudioProvision(path: string): Promise<AudioProvision> {
  if (!absolute(path)) throw new Error('AUDIO_ABSOLUTE_PROVISION_PATH_REQUIRED');
  let manifest: AudioProvision;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('AUDIO_PROVISION_SCHEMA');
    manifest = validateAudioProvision(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new Error('AUDIO_PROVISION_REQUIRED');
    if (error instanceof SyntaxError) throw new Error('AUDIO_PROVISION_SCHEMA');
    throw error;
  }
  await presence(manifest);
  return manifest;
}

/** Snapshot symlinks may resolve to the owning HF repository's blobs, never
 * arbitrary external files. Directory symlinks are not traversal roots. */
export async function modelFileInventory(snapshotPath: string): Promise<string[]> {
  const repositoryRoot = await realpath(resolve(snapshotPath, '../..'));
  const root = await realpath(snapshotPath);
  const contained = (path: string) => path === repositoryRoot || path.startsWith(repositoryRoot + sep);
  if (!contained(root)) throw new Error('AUDIO_MODEL_PATH_ESCAPE');
  const files: string[] = [];
  let entryCount = 0;
  const visit = async (directory: string, depth = 0) => {
    if (depth > 32) throw new Error('AUDIO_MODEL_FILESET_DRIFT');
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (++entryCount > 10_000) throw new Error('AUDIO_MODEL_FILESET_DRIFT');
      const path = join(directory, item.name);
      if (item.isDirectory()) await visit(path, depth + 1);
      else {
        const target = await realpath(path);
        if (!contained(target) || !(await stat(path)).isFile()) throw new Error('AUDIO_MODEL_PATH_ESCAPE');
        files.push(relative(snapshotPath, path).split(sep).join('/'));
        if (files.length > 10_000) throw new Error('AUDIO_MODEL_FILESET_DRIFT');
      }
    }
  };
  await visit(snapshotPath);
  return files.sort();
}

export async function verifyAudioProvision(manifest: AudioProvision): Promise<void> {
  validateAudioProvision(manifest);
  await presence(manifest);
  for (const voice of provisionVoices(manifest)) for (const name of VOICE_FILES) if (await digestFile(join(voice.libraryPath, voice.id, name)) !== voice.files[name]) throw new Error('AUDIO_REFERENCE_DRIFT');
  for (const model of Object.values(manifest.models)) {
    const files = await modelFileInventory(model.snapshotPath);
    if (stableJson(files) !== stableJson(model.files.map(file => file.path).sort())) throw new Error('AUDIO_MODEL_FILESET_DRIFT');
    for (const file of model.files) if (await digestFile(join(model.snapshotPath, file.path)) !== file.sha256) throw new Error('AUDIO_MODEL_DIGEST_MISMATCH');
  }
}

export function audioEnvironment(manifest: Pick<AudioProvision, 'voicesExecutable' | 'hubCacheDirectory'>, outputDirectory: string, tools: Pick<LocalTools, 'ffmpegPath' | 'ffprobePath'> = resolveLocalTools()): NodeJS.ProcessEnv {
  if (!absolute(outputDirectory) || !absolute(manifest.voicesExecutable) || !absolute(manifest.hubCacheDirectory)) throw new Error('AUDIO_ABSOLUTE_ENVIRONMENT_PATH_REQUIRED');
  return { HOME: homedir(), PATH: [...new Set([dirname(manifest.voicesExecutable), dirname(process.execPath), dirname(tools.ffmpegPath), dirname(tools.ffprobePath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'), LANG: 'en_US.UTF-8', TMPDIR: outputDirectory,
    HF_HOME: dirname(manifest.hubCacheDirectory), HF_HUB_CACHE: manifest.hubCacheDirectory, HUGGINGFACE_HUB_CACHE: manifest.hubCacheDirectory,
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', DO_NOT_TRACK: '1', TOKENIZERS_PARALLELISM: 'false' };
}

const EXPECTED_WEIGHTS = {
  tts: { 'model.safetensors': '81fb76175ff74e69be25fef2cc3e54f016df3034f1514c8e1c89da06a3510cff', 'speech_tokenizer/model.safetensors': '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258' },
  aligner: { 'model.safetensors': '9d0728e17e28ee122c366bfaa9748ccbbb8fc3df4c0ce09dd8a5eac8202989e8' },
} as const;
export type AudioCandidateInputs = Omit<CurrentAudioProvision, 'schemaVersion' | 'runtime'>;

/** Public Voices doctor data describes the selected runtime; private Voices
 * source, Python imports and assumed workstation paths are not inputs. */
export function candidateFromDoctor(doctor: unknown, input: AudioCandidateInputs): CurrentAudioProvision {
  if (!record(doctor)) throw new Error('AUDIO_DOCTOR_INVALID');
  const report = doctor as { runtime?: unknown; library?: { path?: unknown }; model_cache?: unknown; models?: { base?: unknown; aligner?: unknown; stt?: unknown }; model_revisions?: { base?: unknown; aligner?: unknown; stt?: unknown } };
  if (input.voices.some(voice => report.library?.path !== voice.libraryPath) || report.model_cache !== input.hubCacheDirectory
    || report.models?.base !== AUDIO_MODELS.tts.repository || report.models?.aligner !== AUDIO_MODELS.aligner.repository
    || report.models?.stt !== AUDIO_MODELS.asr.repository || report.model_revisions?.stt !== AUDIO_MODELS.asr.revision
    || report.model_revisions?.base !== AUDIO_MODELS.tts.revision || report.model_revisions?.aligner !== AUDIO_MODELS.aligner.revision) throw new Error('AUDIO_DOCTOR_CANONICAL_MISMATCH');
  const candidate = validateAudioProvision({ ...input, schemaVersion: 3, runtime: report.runtime }) as CurrentAudioProvision;
  for (const role of ['tts', 'aligner'] as const) for (const [name, expected] of Object.entries(EXPECTED_WEIGHTS[role])) {
    if (candidate.models[role].files.find(file => file.path === name)?.sha256 !== expected) throw new Error('AUDIO_CANONICAL_WEIGHT_MISMATCH');
  }
  return candidate;
}

function containsAutoMap(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAutoMap);
  return record(value) && (Object.hasOwn(value, 'auto_map') || Object.values(value).some(containsAutoMap));
}

export async function inspectAudioModel(hub: string, role: keyof typeof AUDIO_MODELS): Promise<AudioModel> {
  const model = AUDIO_MODELS[role], resolverTree = await readResolverTree(hub, model);
  const snapshotPath = join(hub, `models--${model.repository.replaceAll('/', '--')}`, 'snapshots', model.revision);
  const paths = await modelFileInventory(snapshotPath), files: AudioModelFile[] = [];
  for (const path of paths) {
    if (/\.(py|pyc|so|dylib|bin|pkl|pickle)$/i.test(path)) throw new Error('AUDIO_EXECUTABLE_MODEL_FILE');
    const source = join(snapshotPath, path), info = await stat(source);
    if (path.endsWith('.json') && (info.size > 16 * 1024 * 1024 || containsAutoMap(JSON.parse(await readFile(source, 'utf8'))))) throw new Error('AUDIO_REMOTE_MODEL_CODE');
    files.push({ path, size: info.size, sha256: await digestFile(source) });
  }
  return { ...model, snapshotPath, files, resolverTree };
}

/** Build a complete candidate from existing assets only. The caller owns the
 * explicit voice choice and must create its own cache directory before verify.
 * No model, voice, resolver metadata or shared configuration is written. */
export async function prepareAudioProvision(input: { doctor: unknown; voicesExecutable: string; cacheDirectory: string; defaultVoiceId: string; voiceIds?: string[] }): Promise<CurrentAudioProvision> {
  if (!record(input.doctor)) throw new Error('AUDIO_DOCTOR_INVALID');
  const { doctor } = input, library = doctor.library;
  if (!record(library) || !absolute(library.path) || !absolute(doctor.model_cache)
    || !absolute(input.voicesExecutable) || !absolute(input.cacheDirectory)) throw new Error('AUDIO_DOCTOR_INVALID');
  const voiceIds = input.voiceIds ?? [input.defaultVoiceId];
  if (!voiceIds.includes(input.defaultVoiceId) || !voiceIds.length || voiceIds.length > 100 || new Set(voiceIds).size !== voiceIds.length
    || voiceIds.some(id => !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(id))) throw new Error('AUDIO_PROVISION_EXPLICIT_VOICE_REQUIRED');
  const voices: AudioVoice[] = [];
  for (const id of voiceIds) {
    const files = {} as AudioVoice['files'];
    for (const name of VOICE_FILES) files[name] = await digestFile(join(library.path, id, name));
    voices.push({ id, libraryPath: library.path, files });
  }
  return candidateFromDoctor(doctor, { voicesExecutable: input.voicesExecutable, hubCacheDirectory: doctor.model_cache, cacheDirectory: input.cacheDirectory,
    defaultVoiceId: input.defaultVoiceId, voices, models: { tts: await inspectAudioModel(doctor.model_cache, 'tts'), aligner: await inspectAudioModel(doctor.model_cache, 'aligner'), asr: await inspectAudioModel(doctor.model_cache, 'asr') } });
}

export function stableJson(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (Array.isArray(item)) return item.map(sorted);
    if (record(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])]));
    throw new Error('AUDIO_INVALID_IDENTITY_VALUE');
  };
  return JSON.stringify(sorted(value));
}

function computationalRuntime(runtime: AudioRuntime) {
  return { python: runtime.python, platform: runtime.platform, voices_version: runtime.voices_version, source_sha256: runtime.source_sha256, source_scope: runtime.source_scope, packages: runtime.packages, package_scope: runtime.package_scope };
}
function modelIdentity(model: AudioModel) {
  // Resolver metadata availability/freshness does not change verified model
  // bytes and must not invalidate retained speech or alignment.
  return { repository: model.repository, revision: model.revision, files: [...model.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}
export function synthesisIdentity(manifest: AudioProvision, language: AudioLanguage = 'English', voiceId?: string): string {
  const voice = resolveProvisionVoice(manifest, voiceId);
  return createHash('sha256').update(stableJson({ version: manifest.schemaVersion === 2 ? 2 : 3, engine: 'voices-cli-render', language: audioLanguage(language), settings: 'public Voices defaults',
    voice: manifest.schemaVersion === 2 ? voice.files : { id: voice.id, files: voice.files }, runtime: computationalRuntime(manifest.runtime), model: modelIdentity(manifest.models.tts) })).digest('hex');
}
export function alignmentIdentity(manifest: AudioProvision, language: AudioLanguage = 'English'): string {
  return createHash('sha256').update(stableJson({ version: 2, engine: 'voices-cli-align', language: audioLanguage(language), runtime: computationalRuntime(manifest.runtime), model: modelIdentity(manifest.models.aligner) })).digest('hex');
}
export function transcriptionIdentity(manifest: CurrentAudioProvision, language: AudioLanguage): string {
  return createHash('sha256').update(stableJson({ version: 1, engine: 'voices-cli-transcribe', language: audioLanguage(language), runtime: computationalRuntime(manifest.runtime), model: modelIdentity(manifest.models.asr) })).digest('hex');
}
