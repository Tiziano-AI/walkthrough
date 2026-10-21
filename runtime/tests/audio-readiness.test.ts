import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { inspectAudioReadiness } from '../src/core/audio-readiness.ts';
import { AUDIO_MODELS, VOICE_FILES, resolverTreePath } from '../src/audio/provision.ts';
import type { AudioProvision } from '../src/audio/provision.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function put(path: string, value: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); }
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'walkthrough-audio-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hub = join(root, 'hub');
  const tree = '[{"type":"file","path":"model.safetensors","size":4}]';
  const model = (role: 'tts' | 'aligner') => ({ ...AUDIO_MODELS[role], snapshotPath: join(hub, `models--${AUDIO_MODELS[role].repository.replaceAll('/', '--')}`, 'snapshots', AUDIO_MODELS[role].revision), files: [{ path: 'model.safetensors', size: 4, sha256: hash('data') }], resolverTree: { size: Buffer.byteLength(tree), sha256: hash(tree) } });
  const manifest: AudioProvision = { schemaVersion: 2, voicesExecutable: join(root, 'bin/voices'), hubCacheDirectory: hub, cacheDirectory: join(root, 'audio'),
    runtime: { python: '3.13.5', executable: join(root, 'bin/python'), platform: 'synthetic-platform', voices_version: '1.0.0', source_sha256: hash('source'), source_scope: 'installed-python-source-at-observation', packages: { voices: '1.0.0', mlx: '1.0.0' }, package_scope: 'selected-runtime-dependencies' },
    models: { tts: model('tts'), aligner: model('aligner') }, voice: { id: 'copper_warm', libraryPath: join(root, 'voices'), files: { 'reference.wav': hash('reference.wav'), 'reference.txt': hash('reference.txt'), 'voice.json': hash('voice.json') } } };
  await put(manifest.runtime.executable, 'synthetic interpreter');
  await mkdir(manifest.cacheDirectory, { recursive: true });
  for (const name of VOICE_FILES) await put(join(manifest.voice.libraryPath, manifest.voice.id, name), name);
  for (const entry of Object.values(manifest.models)) {
    await put(join(entry.snapshotPath, 'model.safetensors'), 'data');
    await put(resolverTreePath(hub, entry), tree);
  }
  const path = join(root, 'provision.json');
  const marker = join(root, 'invocations.json');
  const command = async (body: string) => {
    await put(manifest.voicesExecutable, `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }));\n${body}\n`);
    await chmod(manifest.voicesExecutable, 0o700);
  };
  await command(`process.stdout.write(${JSON.stringify(JSON.stringify({ runtime: manifest.runtime }))});`);
  await writeFile(path, JSON.stringify(manifest));
  return { root, path, marker, manifest, command };
}

test('matching public runtime verifies only identity and excludes inherited credentials', async t => {
  const f = await fixture(t);
  const secrets = { OPENAI_API_KEY: 'private-test-key', HF_TOKEN: 'private-test-token', HTTP_PROXY: 'private-proxy', PYTHONPATH: '/private/injection', NODE_OPTIONS: '--trace-warnings', VOICES_LIBRARY: '/private/override' };
  const previous = Object.fromEntries(Object.keys(secrets).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(secrets)) process.env[key] = value;
  const report = await inspectAudioReadiness(f.path);
  assert.equal(report.status, 'legacy-provision'); assert.equal(report.runtimeIdentityVerified, true); assert.equal(report.runtimeIntegrityVerified, false);
  assert.equal(report.transcriptionProvisioned, false); assert.deepEqual(report.voices, ['copper_warm']);
  assert.deepEqual(report.mismatchKeys, []);
  const invocation = JSON.parse(await readFile(f.marker, 'utf8'));
  assert.deepEqual(invocation.args, ['--json', 'doctor']);
  for (const key of Object.keys(secrets)) assert.equal(invocation.env[key], undefined);
  for (const key of ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PYTHONDONTWRITEBYTECODE', 'PYTHONNOUSERSITE']) assert.equal(invocation.env[key], '1');
  assert.equal(invocation.env.HF_HUB_CACHE, f.manifest.hubCacheDirectory);
  assert.equal(JSON.stringify(report).includes('private'), false);
});

test('current provision reports available voices, explicit languages and ASR readiness', async t => {
  const f = await fixture(t), voice = { ...f.manifest.voice, id: 'copilot-female-1' };
  for (const name of VOICE_FILES) await put(join(voice.libraryPath, voice.id, name), name);
  const asr = { ...structuredClone(f.manifest.models.aligner), ...AUDIO_MODELS.asr,
    snapshotPath: join(f.manifest.hubCacheDirectory, `models--${AUDIO_MODELS.asr.repository.replaceAll('/', '--')}`, 'snapshots', AUDIO_MODELS.asr.revision) };
  await put(join(asr.snapshotPath, 'model.safetensors'), 'data');
  await put(resolverTreePath(f.manifest.hubCacheDirectory, asr), '[{"type":"file","path":"model.safetensors","size":4}]');
  const { voice: _voice, ...base } = f.manifest;
  await writeFile(f.path, JSON.stringify({ ...base, schemaVersion: 3, defaultVoiceId: voice.id, voices: [voice, f.manifest.voice], models: { ...f.manifest.models, asr } }));
  const result = await inspectAudioReadiness(f.path);
  assert.equal(result.status, 'provisioned'); assert.equal(result.transcriptionProvisioned, true);
  assert.equal(result.defaultVoiceId, 'copilot-female-1'); assert.deepEqual(result.voices, ['copilot-female-1', 'copper_warm']);
  assert.deepEqual(result.languages, ['English', 'Italian']);
});

test('public runtime drift returns fixed keys without runtime values', async t => {
  const f = await fixture(t);
  for (const key of ['platform', 'source_sha256', 'packages', 'executable'] as const) {
    const runtime = structuredClone(f.manifest.runtime);
    if (key === 'packages') runtime.packages.mlx = '2.0';
    else runtime[key] = key === 'source_sha256' ? hash('changed') : key === 'executable' ? '/private/changed' : 'private-platform';
    await f.command(`process.stdout.write(${JSON.stringify(JSON.stringify({ runtime }))});`);
    const report = await inspectAudioReadiness(f.path);
    assert.equal(report.status, 'runtime-drift'); assert.deepEqual(report.mismatchKeys, [key]);
    assert.equal(report.runtimeIdentityVerified, false); assert.equal(JSON.stringify(report).includes('private'), false);
  }
});

test('absent or invalid provision never starts the executable', async t => {
  const f = await fixture(t);
  for (const path of ['relative', '', f.path + '\0invalid', `${f.root}/bin/../provision.json`]) {
    const report = await inspectAudioReadiness(path);
    assert.equal(report.status, 'invalid'); assert.equal(report.runtimeIdentityVerified, false);
  }
  await rm(f.path);
  assert.equal((await inspectAudioReadiness(f.path)).status, 'missing');
  await writeFile(f.path, '{');
  assert.equal((await inspectAudioReadiness(f.path)).status, 'invalid');
  await writeFile(f.path, JSON.stringify(f.manifest));
  await rm(join(f.manifest.voice.libraryPath, f.manifest.voice.id, 'voice.json'));
  assert.equal((await inspectAudioReadiness(f.path)).status, 'invalid');
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
});

test('malformed output and command failures expose only bounded reasons', async t => {
  const f = await fixture(t);
  for (const output of ['private garbage', '{}', '{"runtime":null}', JSON.stringify({ runtime: { ...f.manifest.runtime, private_unexpected_key: 'secret' } })]) {
    await f.command(`process.stdout.write(${JSON.stringify(output)});`);
    const report = await inspectAudioReadiness(f.path);
    assert.equal(report.status, 'unavailable'); assert.equal(report.reason, 'invalid-response');
    assert.equal(JSON.stringify(report).includes('private'), false);
  }
  await f.command('process.stderr.write("private secret failure"); process.exit(2);');
  const report = await inspectAudioReadiness(f.path);
  assert.equal(report.reason, 'command-failed'); assert.equal(JSON.stringify(report).includes('private'), false);
  await chmod(f.manifest.voicesExecutable, 0o600);
  assert.equal((await inspectAudioReadiness(f.path)).reason, 'command-failed');
});

test('deadline, output ceiling and abort stop the public command', async t => {
  const f = await fixture(t);
  await f.command('setInterval(() => {}, 1000);');
  assert.equal((await inspectAudioReadiness(f.path, { timeoutMs: 100 })).reason, 'timeout');
  await f.command('process.stdout.write("x".repeat(4 * 1024 * 1024 + 1));');
  assert.equal((await inspectAudioReadiness(f.path)).reason, 'output-limit');
  await f.command('process.stderr.write("x".repeat(4 * 1024 * 1024 + 1));');
  assert.equal((await inspectAudioReadiness(f.path)).reason, 'output-limit');
  await f.command('setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const pending = inspectAudioReadiness(f.path, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 100);
  try { assert.equal((await pending).reason, 'aborted'); } finally { clearTimeout(timer); }
  await rm(f.marker);
  assert.equal((await inspectAudioReadiness(f.path, { signal: AbortSignal.abort() })).reason, 'aborted');
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
});
