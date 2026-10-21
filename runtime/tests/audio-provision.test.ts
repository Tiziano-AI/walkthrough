import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { AUDIO_MODELS, VOICE_FILES, alignmentIdentity, audioEnvironment, audioLanguage, candidateFromDoctor, digestFile, readAudioProvision, readResolverTree, resolverTreePath, resolveProvisionVoice, stableJson, synthesisIdentity, transcriptionIdentity, validateAudioProvision, verifyAudioProvision } from '../src/audio/provision.ts';
import type { HistoricalAudioProvision as AudioProvision, CurrentAudioProvision } from '../src/audio/provision.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const syntheticTree = JSON.stringify([{ type: 'file', path: 'model.safetensors', size: 4 }]);
function fixture(root: string): AudioProvision {
  const hub = join(root, 'hub');
  const model = (role: 'tts' | 'aligner') => ({ ...AUDIO_MODELS[role], snapshotPath: join(hub, `models--${AUDIO_MODELS[role].repository.replaceAll('/', '--')}`, 'snapshots', AUDIO_MODELS[role].revision), files: [{ path: 'model.safetensors', size: 4, sha256: hash('data') }], resolverTree: { size: Buffer.byteLength(syntheticTree), sha256: hash(syntheticTree) } });
  return { schemaVersion: 2, voicesExecutable: join(root, 'bin/voices'), hubCacheDirectory: hub, cacheDirectory: join(root, 'audio'),
    runtime: { python: '3.13.5', executable: join(root, 'bin/python'), platform: 'synthetic-platform', voices_version: '1.0.0', source_sha256: hash('source'), source_scope: 'installed-python-source-at-observation', packages: { voices: '1.0.0', mlx: '1.0.0' }, package_scope: 'selected-runtime-dependencies' },
    models: { tts: model('tts'), aligner: model('aligner') }, voice: { id: 'copper_warm', libraryPath: join(root, 'voices'), files: { 'reference.wav': hash('reference.wav'), 'reference.txt': hash('reference.txt'), 'voice.json': hash('voice.json') } } };
}
function currentFixture(root: string): CurrentAudioProvision {
  const { voice, models, ...base } = fixture(root);
  const asr = { ...structuredClone(models.aligner), ...AUDIO_MODELS.asr,
    snapshotPath: join(base.hubCacheDirectory, `models--${AUDIO_MODELS.asr.repository.replaceAll('/', '--')}`, 'snapshots', AUDIO_MODELS.asr.revision) };
  return { ...base, schemaVersion: 3, defaultVoiceId: 'copilot-female-1', voices: [{ ...voice, id: 'copilot-female-1' }, voice], models: { ...models, asr } };
}
async function put(path: string, value: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); }
async function materialize(manifest: AudioProvision) {
  await put(manifest.voicesExecutable, 'synthetic executable, never run'); await put(manifest.runtime.executable, 'synthetic interpreter, never run');
  await mkdir(manifest.cacheDirectory, { recursive: true });
  for (const name of VOICE_FILES) await put(join(manifest.voice.libraryPath, manifest.voice.id, name), name);
  for (const model of Object.values(manifest.models)) {
    await put(join(model.snapshotPath, 'model.safetensors'), 'data');
    await put(resolverTreePath(manifest.hubCacheDirectory, model), syntheticTree);
  }
}

test('schema v2 is one bounded pinned contract, without private runtime fields', () => {
  const manifest = fixture('/synthetic');
  assert.equal(validateAudioProvision(manifest), manifest);
  for (const change of [
    (m: any) => { m.schemaVersion = 1; }, (m: any) => { m.pythonPath = '/private/python'; },
    (m: any) => { m.runtime.packages = {}; }, (m: any) => { m.runtime.source_sha256 = 'bad'; },
    (m: any) => { delete m.runtime.source_scope; }, (m: any) => { m.runtime.package_scope = 'complete-lockfile'; },
    (m: any) => { m.voicesExecutable = 'voices'; }, (m: any) => { m.voice.files['reference.txt'] = 'bad'; },
    (m: any) => { m.voice.id = '../voice'; }, (m: any) => { m.models.tts.revision = 'main'; },
    (m: any) => { m.models.tts.snapshotPath = '/different/snapshot'; },
    (m: any) => { m.models.tts.files[0].path = '../escape'; },
    (m: any) => { m.models.tts.files[0].path = 'a/../escape'; },
    (m: any) => { m.models.tts.files[0].path = 'a\\escape'; },
    (m: any) => { m.models.tts.files[0].size = -1; },
    (m: any) => { m.models.tts.files.push(m.models.tts.files[0]); },
    (m: any) => { delete m.models.tts.resolverTree; },
    (m: any) => { m.models.tts.resolverTree.sha256 = 'bad'; },
    (m: any) => { m.models.tts.resolverTree.size = 0; },
  ]) {
    const changed = structuredClone(manifest); change(changed);
    assert.throws(() => validateAudioProvision(changed), /AUDIO_PROVISION_SCHEMA/);
  }
});

test('schema3 binds the operator-selected provisioned default and separate language/model identities', () => {
  const manifest = currentFixture('/synthetic');
  assert.equal(validateAudioProvision(manifest), manifest);
  assert.equal(resolveProvisionVoice(manifest).id, 'copilot-female-1');
  assert.equal(resolveProvisionVoice(manifest, 'copper_warm').id, 'copper_warm');
  assert.throws(() => resolveProvisionVoice(manifest, 'unknown'), /AUDIO_UNPROVISIONED_VOICE/);
  assert.equal(audioLanguage(undefined), 'English'); assert.throws(() => audioLanguage('italian'), /AUDIO_UNSUPPORTED_LANGUAGE/);
  const selected = structuredClone(manifest); selected.defaultVoiceId = 'copper_warm';
  assert.equal(validateAudioProvision(selected), selected);
  assert.equal(resolveProvisionVoice(selected).id, 'copper_warm');
  assert.equal(synthesisIdentity(selected, 'English', 'copilot-female-1'), synthesisIdentity(manifest, 'English', 'copilot-female-1'), 'selection never changes explicit retained voice identity');
  for (const mutate of [(value: any) => { value.voices.push(value.voices[0]); }, (value: any) => { value.defaultVoiceId = 'missing-voice'; }, (value: any) => { delete value.models.asr; }]) {
    const invalid = structuredClone(manifest); mutate(invalid); assert.throws(() => validateAudioProvision(invalid), /AUDIO_PROVISION_SCHEMA/);
  }
  assert.notEqual(synthesisIdentity(manifest, 'English'), synthesisIdentity(manifest, 'Italian'));
  assert.notEqual(synthesisIdentity(manifest, 'English', 'copilot-female-1'), synthesisIdentity(manifest, 'English', 'copper_warm'), 'voice IDs stay distinct even with byte-identical references');
  assert.notEqual(alignmentIdentity(manifest, 'English'), alignmentIdentity(manifest, 'Italian'));
  const changed = structuredClone(manifest); changed.models.asr.files[0].sha256 = hash('updated ASR');
  assert.equal(synthesisIdentity(manifest), synthesisIdentity(changed)); assert.equal(alignmentIdentity(manifest), alignmentIdentity(changed));
  assert.notEqual(transcriptionIdentity(manifest, 'English'), transcriptionIdentity(changed, 'English'));
  assert.notEqual(transcriptionIdentity(manifest, 'English'), transcriptionIdentity(manifest, 'Italian'));
});

test('read checks presence and sizes; verification checks voice/model bytes and exact inventory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'walkthrough-audio-provision-')); t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = fixture(root); await materialize(manifest);
  const path = join(root, 'candidate.json'); await writeFile(path, JSON.stringify(manifest));
  assert.deepEqual(await readAudioProvision(path), manifest); await verifyAudioProvision(manifest);
  assert.equal(await digestFile(join(manifest.models.tts.snapshotPath, 'model.safetensors')), hash('data'));
  await put(join(manifest.models.tts.snapshotPath, 'model.safetensors'), 'edit');
  await readAudioProvision(path); // Same size is presence, not integrity proof.
  await assert.rejects(verifyAudioProvision(manifest), /AUDIO_MODEL_DIGEST_MISMATCH/);
  await put(join(manifest.models.tts.snapshotPath, 'model.safetensors'), 'data');
  const extra = join(manifest.models.tts.snapshotPath, 'extra.json'); await put(extra, '{}');
  await assert.rejects(verifyAudioProvision(manifest), /AUDIO_MODEL_FILESET_DRIFT/); await rm(extra);
  await put(join(manifest.voice.libraryPath, manifest.voice.id, 'reference.txt'), 'changed');
  await assert.rejects(verifyAudioProvision(manifest), /AUDIO_REFERENCE_DRIFT/);
  await assert.rejects(readAudioProvision('relative.json'), /AUDIO_ABSOLUTE_PROVISION_PATH_REQUIRED/);
});

test('HF snapshot symlinks admit owning blobs but reject outside targets and directory links', async t => {
  const root = await mkdtemp(join(tmpdir(), 'walkthrough-audio-symlink-')); t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = fixture(root); await materialize(manifest);
  const model = manifest.models.tts;
  const source = join(model.snapshotPath, 'model.safetensors'); const blob = join(dirname(dirname(model.snapshotPath)), 'blobs/fixture');
  await put(blob, 'data'); await rm(source); await symlink(blob, source); await verifyAudioProvision(manifest);
  const external = join(root, 'outside'); await put(external, 'data'); await rm(source); await symlink(external, source);
  await assert.rejects(verifyAudioProvision(manifest), /AUDIO_MODEL_PATH_ESCAPE/);
  await rm(source); await symlink(blob, source); await symlink(dirname(blob), join(model.snapshotPath, 'linked-directory'));
  await assert.rejects(verifyAudioProvision(manifest), /AUDIO_MODEL_PATH_ESCAPE/);
});

test('content identities ignore paths, property/file order, and synthesis ignores aligner changes', () => {
  const a = fixture('/first'); const b = fixture('/second');
  assert.equal(synthesisIdentity(a), synthesisIdentity(b)); assert.equal(alignmentIdentity(a), alignmentIdentity(b));
  b.models.tts.resolverTree = { size: 1234, sha256: hash('refreshed metadata') };
  b.models.aligner.resolverTree = { size: 1234, sha256: hash('refreshed metadata') };
  assert.equal(synthesisIdentity(a), synthesisIdentity(b)); assert.equal(alignmentIdentity(a), alignmentIdentity(b));
  b.runtime.packages = { mlx: '1.0.0', voices: '1.0.0' }; assert.equal(synthesisIdentity(a), synthesisIdentity(b));
  b.models.aligner.files[0].sha256 = hash('changed');
  assert.equal(synthesisIdentity(a), synthesisIdentity(b)); assert.notEqual(alignmentIdentity(a), alignmentIdentity(b));
  b.models.tts.files[0].sha256 = hash('changed'); assert.notEqual(synthesisIdentity(a), synthesisIdentity(b));
  for (const change of [(m: AudioProvision) => { m.voice.files['reference.wav'] = hash('different'); }, (m: AudioProvision) => { m.runtime.python = '3.14'; }, (m: AudioProvision) => { m.runtime.source_sha256 = hash('different'); }, (m: AudioProvision) => { m.runtime.packages.mlx = '2'; }]) {
    const changed = structuredClone(a); change(changed); assert.notEqual(synthesisIdentity(a), synthesisIdentity(changed));
  }
  assert.equal(stableJson({ z: 1, a: { z: 2, a: 3 } }), '{"a":{"a":3,"z":2},"z":1}');
  assert.throws(() => stableJson({ unknown: undefined }), /AUDIO_INVALID_IDENTITY_VALUE/);
});

test('production environment inherits no credential, proxy, injection or provider override', () => {
  const manifest = fixture('/synthetic');
  const env = audioEnvironment(manifest, '/synthetic/output', { ffmpegPath: '/custom/encoder/bin/ffmpeg', ffprobePath: '/custom/probe/bin/ffprobe' });
  assert.equal(env.HF_HUB_CACHE, manifest.hubCacheDirectory); assert.equal(env.HUGGINGFACE_HUB_CACHE, env.HF_HUB_CACHE);
  assert.equal(env.HF_HUB_OFFLINE, '1'); assert.equal(env.TRANSFORMERS_OFFLINE, '1'); assert.equal(env.HF_HUB_DISABLE_TELEMETRY, '1');
  for (const key of ['OPENAI_API_KEY', 'HF_TOKEN', 'HTTP_PROXY', 'PYTHONPATH', 'VOICES_LIBRARY', 'VOICES_BASE_MODEL', 'NODE_OPTIONS']) assert.equal(Object.hasOwn(env, key), false);
  assert.ok(env.PATH?.split(':').includes('/custom/encoder/bin')); assert.ok(env.PATH?.split(':').includes('/custom/probe/bin'));
  assert.equal(env.PATH?.split(':').includes('/opt/homebrew/bin'), false);
  assert.throws(() => audioEnvironment(manifest, 'relative'), /AUDIO_ABSOLUTE_ENVIRONMENT_PATH_REQUIRED/);
});

test('candidate mapping uses public doctor keys and rejects wrong revisions, cache and canonical weights', () => {
  const manifest = currentFixture('/synthetic');
  manifest.models.tts.files = [{ path: 'model.safetensors', size: 1, sha256: '81fb76175ff74e69be25fef2cc3e54f016df3034f1514c8e1c89da06a3510cff' }, { path: 'speech_tokenizer/model.safetensors', size: 1, sha256: '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258' }];
  manifest.models.aligner.files[0].sha256 = '9d0728e17e28ee122c366bfaa9748ccbbb8fc3df4c0ce09dd8a5eac8202989e8';
  const doctor = { runtime: manifest.runtime, library: { path: manifest.voices[0].libraryPath }, model_cache: manifest.hubCacheDirectory, models: { base: AUDIO_MODELS.tts.repository, aligner: AUDIO_MODELS.aligner.repository, stt: AUDIO_MODELS.asr.repository }, model_revisions: { base: AUDIO_MODELS.tts.revision, aligner: AUDIO_MODELS.aligner.revision, stt: AUDIO_MODELS.asr.revision } };
  const { schemaVersion: _schema, runtime: _runtime, ...input } = manifest;
  assert.deepEqual(candidateFromDoctor(doctor, input), manifest);
  assert.throws(() => candidateFromDoctor({ ...doctor, model_cache: '/private/cache' }, input), /AUDIO_DOCTOR_CANONICAL_MISMATCH/);
  assert.throws(() => candidateFromDoctor({ ...doctor, model_revisions: { base: 'main', aligner: AUDIO_MODELS.aligner.revision } }, input), /AUDIO_DOCTOR_CANONICAL_MISMATCH/);
  const changed = structuredClone(input); changed.models.tts.files[0].sha256 = hash('unapproved');
  assert.throws(() => candidateFromDoctor(doctor, changed), /AUDIO_CANONICAL_WEIGHT_MISMATCH/);
});

test('missing manifest, file and directory return useful provision errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'walkthrough-audio-missing-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'candidate.json');
  await assert.rejects(readAudioProvision(path), /AUDIO_PROVISION_REQUIRED/);
  await writeFile(path, '{'); await assert.rejects(readAudioProvision(path), /AUDIO_PROVISION_SCHEMA/);
  const manifest = fixture(root); await materialize(manifest); await writeFile(path, JSON.stringify(manifest));
  await rm(manifest.voicesExecutable); await assert.rejects(readAudioProvision(path), /AUDIO_PROVISION_MISSING_FILE/);
  await put(manifest.voicesExecutable, 'fixture'); await rm(manifest.cacheDirectory, { recursive: true });
  await assert.rejects(readAudioProvision(path), /AUDIO_PROVISION_MISSING_DIRECTORY/);
  await assert.rejects(digestFile(join(root, 'absent')), /AUDIO_PROVISION_MISSING_FILE/);
});

test('resolver metadata must be an existing regular file with retained size and hash', async t => {
  const root = await mkdtemp(join(tmpdir(), 'walkthrough-audio-resolver-')); t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = fixture(root); await materialize(manifest);
  const path = join(root, 'candidate.json'); await writeFile(path, JSON.stringify(manifest));
  const model = manifest.models.tts;
  const treePath = resolverTreePath(manifest.hubCacheDirectory, model);
  assert.deepEqual(await readResolverTree(manifest.hubCacheDirectory, model), model.resolverTree);
  await readAudioProvision(path); await verifyAudioProvision(manifest);
  await rm(treePath);
  await assert.rejects(readAudioProvision(path), /AUDIO_MODEL_RESOLVER_TREE_MISSING/);
  await assert.rejects(verifyAudioProvision(manifest), /AUDIO_MODEL_RESOLVER_TREE_MISSING/);
  await put(treePath, syntheticTree.replace('file', 'edit'));
  await assert.rejects(readAudioProvision(path), /AUDIO_MODEL_RESOLVER_TREE_DRIFT/);
  await assert.rejects(verifyAudioProvision(manifest), /AUDIO_MODEL_RESOLVER_TREE_DRIFT/);
  await put(treePath, syntheticTree + '\n');
  await assert.rejects(readAudioProvision(path), /AUDIO_MODEL_RESOLVER_TREE_DRIFT/);
  await rm(treePath); await mkdir(treePath);
  await assert.rejects(readAudioProvision(path), /AUDIO_MODEL_RESOLVER_TREE_INVALID/);
  await rm(treePath, { recursive: true });
  const alternative = join(root, 'other-tree.json'); await put(alternative, syntheticTree); await symlink(alternative, treePath);
  await assert.rejects(verifyAudioProvision(manifest), /AUDIO_MODEL_RESOLVER_TREE_INVALID/);
});
