import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { AUDIO_MODELS, VOICE_FILES, digestFile, resolverTreePath, type CurrentAudioProvision } from '../src/audio/provision.ts';
import { sha256 } from '../src/core/files.ts';
import { LICENSE_BASES, operatorLicenseAssertion, validateLicenseAssertion, verifyLicense } from '../src/core/license.ts';
import { inspectSetupTools, observeSetupDoctor, setupApply, setupInspect, setupPendingPath, setupPrepare, type SetupCandidate } from '../src/core/setup.ts';
import type { LocalTools } from '../src/core/contracts.ts';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
async function put(path: string, value: string) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, value, { mode: 0o600 }); }
async function fixture(t: { after: (body: () => void | Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'walkthrough-setup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = { state: process.env.WALKTHROUGH_STATE_ROOT, config: process.env.WALKTHROUGH_CONFIG_ROOT };
  process.env.WALKTHROUGH_STATE_ROOT = join(root, 'state'); process.env.WALKTHROUGH_CONFIG_ROOT = join(root, 'config');
  t.after(() => {
    if (previous.state === undefined) delete process.env.WALKTHROUGH_STATE_ROOT; else process.env.WALKTHROUGH_STATE_ROOT = previous.state;
    if (previous.config === undefined) delete process.env.WALKTHROUGH_CONFIG_ROOT; else process.env.WALKTHROUGH_CONFIG_ROOT = previous.config;
  });
  const executable = async (name: string, output: unknown) => {
    const path = join(root, 'bin', name);
    await put(path, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(typeof output === 'string' ? output : JSON.stringify(output))});\n`);
    await chmod(path, 0o700); return path;
  };
  const tools: LocalTools = { nodePath: process.execPath, browserPath: await executable('browser', 'Google Chrome for Testing 153.0.8010.12'),
    ffmpegPath: await executable('ffmpeg', 'ffmpeg version synthetic'), ffprobePath: await executable('ffprobe', 'ffprobe version synthetic') };
  const voiceId = 'studio-reader', hub = join(root, 'shared-hub'), libraryPath = join(root, 'shared-library');
  const tree = '[{"type":"file","path":"model.safetensors","size":4}]';
  const model = async (role: keyof typeof AUDIO_MODELS) => {
    const snapshotPath = join(hub, `models--${AUDIO_MODELS[role].repository.replaceAll('/', '--')}`, 'snapshots', AUDIO_MODELS[role].revision);
    await put(join(snapshotPath, 'model.safetensors'), 'data'); await put(resolverTreePath(hub, AUDIO_MODELS[role]), tree);
    return { ...AUDIO_MODELS[role], snapshotPath, files: [{ path: 'model.safetensors', size: 4, sha256: sha256('data') }], resolverTree: { size: Buffer.byteLength(tree), sha256: sha256(tree) } };
  };
  const files = {} as CurrentAudioProvision['voices'][number]['files'];
  for (const name of VOICE_FILES) { await put(join(libraryPath, voiceId, name), name); files[name] = sha256(name); }
  const python = await executable('python', 'synthetic runtime, never executed');
  const runtime = { python: '3.13.5', executable: python, platform: 'synthetic-platform', voices_version: '0.2.0', source_sha256: sha256('source'), source_scope: 'installed-python-source-at-observation' as const, packages: { voices: '0.2.0', mlx: 'synthetic' }, package_scope: 'selected-runtime-dependencies' as const };
  const doctor = { runtime, library: { path: libraryPath }, model_cache: hub, models: { base: AUDIO_MODELS.tts.repository, aligner: AUDIO_MODELS.aligner.repository, stt: AUDIO_MODELS.asr.repository }, model_revisions: { base: AUDIO_MODELS.tts.revision, aligner: AUDIO_MODELS.aligner.revision, stt: AUDIO_MODELS.asr.revision } };
  const voicesExecutable = await executable('voices', doctor);
  const provision: CurrentAudioProvision = { schemaVersion: 3, voicesExecutable, runtime, hubCacheDirectory: hub, cacheDirectory: join(root, 'state/audio/cache'),
    defaultVoiceId: voiceId, voices: [{ id: voiceId, libraryPath, files }], models: { tts: await model('tts'), aligner: await model('aligner'), asr: await model('asr') } };
  const dependencies = { inspectTools: inspectSetupTools, observeDoctor: observeSetupDoctor, prepareAudio: async () => structuredClone(provision) };
  const input = { candidatePath: join(root, 'candidate.json'), tools, voicesExecutable, defaultVoiceId: voiceId, license: operatorLicenseAssertion('small-organization') };
  const prepare = () => setupPrepare(input, dependencies);
  const apply = (candidateSha256: string) => setupApply({ candidatePath: input.candidatePath, candidateSha256 }, dependencies);
  return { root, input, provision, doctor, executable, dependencies, prepare, apply };
}

test('operator license assertion is explicit, permits qualified bases and preserves historical shape', async t => {
  for (const basis of LICENSE_BASES) assert.equal(validateLicenseAssertion(operatorLicenseAssertion(basis)).eligibility, basis);
  const historical = { ...operatorLicenseAssertion('individual'), schemaVersion: 1 };
  assert.deepEqual(validateLicenseAssertion(historical), historical);
  for (const value of [null, { ...historical, eligibility: 'company-license' }, { ...historical, telemetry: true }, { ...historical, licenseKey: 'free-license' }, { ...historical, version: '5.0.0' }, { ...historical, assertedBy: 'installer' }]) assert.throws(() => validateLicenseAssertion(value), /LICENSE_ASSERTION_INVALID/);
  const f = await fixture(t), path = join(f.root, 'operator-license.json');
  await put(path, json(operatorLicenseAssertion('non-profit')));
  assert.equal((await verifyLicense(path)).eligibility, 'non-profit');
  await chmod(path, 0o644);
  await assert.rejects(verifyLicense(path), { code: 'LICENSE_ELIGIBILITY_NOT_PROVISIONED' });
});

test('historical license evidence remains readable without rewriting or accepting it as new setup input', async t => {
  const historical = { ...operatorLicenseAssertion('individual'), schemaVersion: 1,
    assertedAt: '2026-01-01T00:00:00.000Z', basis: 'Operator-asserted individual eligibility',
    license: 'Remotion license terms reviewed by the operator', scope: 'Local film rendering' };
  assert.equal(validateLicenseAssertion(historical), historical);
  const f = await fixture(t), path = join(f.root, 'config/remotion-license.json'), before = json(historical);
  await put(path, before);
  assert.deepEqual(await verifyLicense(path), { renderer: 'Remotion', version: '4.0.520', eligibility: 'individual', telemetry: false });
  const report = await setupInspect({}, f.dependencies);
  assert.equal(report.checks.find(check => check.id === 'license-configuration')?.status, 'ready');
  assert.equal(report.checks.find(check => check.id === 'operator-license')?.status, 'ready');
  assert.equal(await readFile(path, 'utf8'), before);
  await assert.rejects(setupPrepare({ ...f.input, license: historical as unknown as typeof f.input.license }, f.dependencies), { code: 'SETUP_LICENSE_ASSERTION_REQUIRED' });
  for (const field of ['assertedAt', 'basis', 'license', 'scope']) {
    assert.throws(() => validateLicenseAssertion({ ...operatorLicenseAssertion('individual'), [field]: historical[field as keyof typeof historical] }), /LICENSE_ASSERTION_INVALID/);
  }
  assert.throws(() => validateLicenseAssertion({ ...historical, licenseKey: 'free-license' }), /LICENSE_ASSERTION_INVALID/);
});

test('prepare observes selected portable tools and writes only a new reviewed candidate', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.selected, false); assert.equal(prepared.inference, false); assert.equal(prepared.downloads, false);
  assert.equal(prepared.audio.defaultVoiceId, 'studio-reader'); assert.equal(prepared.candidateSha256, await digestFile(f.input.candidatePath));
  for (const path of Object.values(prepared.targets)) await assert.rejects(lstat(path), { code: 'ENOENT' });
  assert.equal((await lstat(f.input.candidatePath)).mode & 0o777, 0o600);
  assert.equal(await readFile(join(f.provision.voices[0].libraryPath, 'studio-reader/reference.txt'), 'utf8'), 'reference.txt');
  await assert.rejects(f.prepare(), { code: 'SETUP_CANDIDATE_EXISTS' });
});

test('apply revalidates runtime/assets and selects once without changing the candidate or shared assets', async t => {
  const f = await fixture(t), prepared = await f.prepare(), before = await readFile(f.input.candidatePath, 'utf8');
  const applied = await f.apply(prepared.candidateSha256);
  assert.equal(applied.status, 'applied'); assert.equal(applied.changed, true);
  assert.deepEqual(JSON.parse(await readFile(prepared.targets.toolchain, 'utf8')), { schemaVersion: 1, tools: f.input.tools });
  assert.deepEqual(JSON.parse(await readFile(prepared.targets.audio, 'utf8')), f.provision);
  assert.equal(await readFile(f.input.candidatePath, 'utf8'), before);
  assert.equal((await f.apply(prepared.candidateSha256)).changed, false);
  const report = await setupInspect({}, f.dependencies);
  assert.equal(report.status, 'ready'); assert.equal(report.audio.defaultVoiceId, 'studio-reader'); assert.equal(report.pending, null);
  await assert.rejects(lstat(setupPendingPath()), { code: 'ENOENT' });
});

test('stable prerequisite paths survive replacement while inspect and apply detect changed executable bytes', async t => {
  const f = await fixture(t), keys = ['nodePath', 'ffmpegPath', 'ffprobePath'] as const;
  const oldTargets = { nodePath: await f.executable('node-first', 'v24.20.0'), ffmpegPath: f.input.tools.ffmpegPath, ffprobePath: f.input.tools.ffprobePath };
  const stableDirectory = join(f.root, 'selected-tools'); await mkdir(stableDirectory);
  for (const key of keys) {
    const path = join(stableDirectory, key); await symlink(oldTargets[key], path); f.input.tools[key] = path;
  }
  const prepared = await f.prepare(); await f.apply(prepared.candidateSha256);
  const candidate = JSON.parse(await readFile(f.input.candidatePath, 'utf8')) as SetupCandidate;
  assert.deepEqual(candidate.tools, f.input.tools);
  for (const key of keys) {
    assert.equal(candidate.toolIdentities[key].path, f.input.tools[key]);
    const replacement = join(f.root, `${key}-replacement`);
    // Identical reported versions cannot hide a changed executable identity.
    await writeFile(replacement, (await readFile(oldTargets[key], 'utf8')) + '\n// Replacement synthetic prerequisite.\n', { mode: 0o700 });
    await rm(f.input.tools[key]); await symlink(replacement, f.input.tools[key]); await rm(oldTargets[key]);
  }
  const identities = await inspectSetupTools(f.input.tools);
  for (const key of keys) {
    assert.equal(identities[key].path, candidate.toolIdentities[key].path);
    assert.equal(identities[key].version, candidate.toolIdentities[key].version);
    assert.notEqual(identities[key].sha256, candidate.toolIdentities[key].sha256);
  }
  const report = await setupInspect({}, f.dependencies);
  assert.equal(report.checks.find(check => check.id === 'prerequisites')?.status, 'changed');
  await assert.rejects(f.apply(prepared.candidateSha256), { code: 'SETUP_PREREQUISITE_CHANGED' });
  assert.deepEqual(JSON.parse(await readFile(prepared.targets.toolchain, 'utf8')).tools, f.input.tools);
  await assert.rejects(lstat(setupPendingPath()), { code: 'ENOENT' });
});

test('changed candidate, selected preimage, voice bytes and installed Voices cannot be silently accepted', async t => {
  const f = await fixture(t), prepared = await f.prepare(), original = await readFile(f.input.candidatePath, 'utf8');
  await writeFile(f.input.candidatePath, original + ' ');
  await assert.rejects(f.apply(prepared.candidateSha256), { code: 'SETUP_CANDIDATE_CHANGED' });
  await writeFile(f.input.candidatePath, original);
  await put(prepared.targets.toolchain, '{}');
  await assert.rejects(f.apply(prepared.candidateSha256), { code: 'SETUP_SELECTION_CHANGED' });
  await rm(prepared.targets.toolchain);
  const reference = join(f.provision.voices[0].libraryPath, 'studio-reader/reference.txt');
  await writeFile(reference, 'changed');
  await assert.rejects(f.apply(prepared.candidateSha256), /AUDIO_REFERENCE_DRIFT/);
  await writeFile(reference, 'reference.txt');
  const changed = { ...f.doctor, runtime: { ...f.doctor.runtime, voices_version: '0.3.0' } };
  await f.executable('voices', changed);
  await assert.rejects(f.apply(prepared.candidateSha256), { code: 'SETUP_VOICES_CHANGED' });
  for (const path of Object.values(prepared.targets)) await assert.rejects(lstat(path), { code: 'ENOENT' });
});

test('setup inspect keeps absence separate from drift and does not create operational state', async t => {
  const f = await fixture(t), before = await setupInspect({}, f.dependencies);
  assert.equal(before.status, 'not-ready'); assert.equal(before.audio.status, 'missing');
  assert.equal(before.checks.find(check => check.id === 'toolchain')?.status, 'missing');
  await assert.rejects(lstat(join(f.root, 'state')), { code: 'ENOENT' });
  const prepared = await f.prepare(); await f.apply(prepared.candidateSha256);
  await f.executable('voices', { ...f.doctor, runtime: { ...f.doctor.runtime, source_sha256: sha256('updated') } });
  const drift = await setupInspect({}, f.dependencies);
  assert.equal(drift.audio.status, 'runtime-drift'); assert.equal(drift.checks.find(check => check.id === 'audio-runtime')?.status, 'changed');
  await f.executable('browser', 'Google Chrome for Testing 153.0.8010.12\nchanged binary');
  const toolDrift = await setupInspect({}, f.dependencies);
  assert.equal(toolDrift.checks.find(check => check.id === 'prerequisites')?.status, 'changed');
});

test('explicit portable tools can replace malformed selected configuration without an import-time crash', async t => {
  const f = await fixture(t);
  await put(join(f.root, 'config/toolchain.json'), '{');
  const before = await setupInspect({}, f.dependencies);
  assert.equal(before.status, 'not-ready');
  assert.equal(before.checks.find(check => check.id === 'prerequisites')?.code, 'TOOLCHAIN_SELECTION_INVALID');
  assert.equal(before.checks.find(check => check.id === 'toolchain')?.status, 'invalid');
  const prepared = await f.prepare(); await f.apply(prepared.candidateSha256);
  await put(prepared.targets.toolchain, '{');
  const invalid = await setupInspect({}, f.dependencies);
  assert.equal(invalid.status, 'not-ready'); assert.equal(invalid.audio.status, 'unavailable'); assert.equal(invalid.audio.reason, 'toolchain-invalid');
  await put(prepared.targets.license, '{');
  const badLicense = await setupInspect({}, f.dependencies);
  assert.equal(badLicense.checks.find(check => check.id === 'license-configuration')?.status, 'invalid');
  assert.equal(badLicense.checks.find(check => check.id === 'operator-license')?.status, 'invalid');
  const replacement = await setupPrepare({ ...f.input, candidatePath: join(f.root, 'replacement.json') }, f.dependencies);
  await setupApply({ candidatePath: replacement.candidatePath, candidateSha256: replacement.candidateSha256 }, f.dependencies);
  assert.equal((await setupInspect({}, f.dependencies)).status, 'ready');
});

test('active work prevents selection and an interrupted exact apply resumes instead of replacing inputs', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  await put(join(f.root, 'state/active/session.json'), json({ schemaVersion: 1, kind: 'session', pid: process.pid, status: 'running' }));
  await assert.rejects(f.apply(prepared.candidateSha256), { code: 'SETUP_ACTIVE_WORK' });
  await rm(join(f.root, 'state/active/session.json'));
  const candidate: SetupCandidate = JSON.parse(await readFile(f.input.candidatePath, 'utf8'));
  const receipt = { schemaVersion: 1, kind: 'walkthrough-setup-selection', candidatePath: f.input.candidatePath, candidateSha256: prepared.candidateSha256, toolIdentities: candidate.toolIdentities, audioSha256: sha256(json(candidate.audio)), licenseSha256: sha256(json(candidate.license)) };
  const values = { toolchain: { schemaVersion: 1, tools: candidate.tools }, audio: candidate.audio, license: candidate.license, receipt };
  const outputs = (['toolchain', 'audio', 'license', 'receipt'] as const).map(key => ({ path: candidate.targets[key], temporary: `${candidate.targets[key]}.setup-${prepared.candidateSha256}.next`, before: candidate.previous[key], after: sha256(json(values[key])), value: values[key] }));
  const stopped = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(stopped.stdout); assert.throws(() => process.kill(deadPid, 0));
  await put(setupPendingPath(), json({ schemaVersion: 1, kind: 'walkthrough-setup-apply', candidatePath: f.input.candidatePath, candidateSha256: prepared.candidateSha256, pid: deadPid, outputs }));
  await put(outputs[0].path, json(outputs[0].value));
  // A killed writer may leave a partial output or journal staging file. Both
  // slots belong to the retained transaction, not a directory scan or glob.
  await put(outputs[0].temporary, 'already-selected scratch');
  await put(outputs[1].temporary, '{');
  const journalScratch = `${setupPendingPath()}.setup-${prepared.candidateSha256}.next`;
  await put(journalScratch, '{');
  const pending = await setupInspect({}, f.dependencies);
  assert.equal(pending.status, 'not-ready'); assert.equal(pending.pending?.candidateSha256, prepared.candidateSha256);
  assert.equal((await f.apply(prepared.candidateSha256)).status, 'applied');
  assert.equal((await setupInspect({}, f.dependencies)).status, 'ready');
  assert.equal(await readFile(f.input.candidatePath, 'utf8'), json(candidate));
  for (const path of [...outputs.map(output => output.temporary), journalScratch]) await assert.rejects(lstat(path), { code: 'ENOENT' });
});

test('a scratch slot not reserved by an apply journal is preserved rather than overwritten', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  const scratch = `${prepared.targets.toolchain}.setup-${prepared.candidateSha256}.next`;
  await put(scratch, 'not owned by an apply journal');
  await assert.rejects(f.apply(prepared.candidateSha256), { code: 'SETUP_SCRATCH_EXISTS' });
  assert.equal(await readFile(scratch, 'utf8'), 'not owned by an apply journal');
  for (const path of [...Object.values(prepared.targets), setupPendingPath()]) await assert.rejects(lstat(path), { code: 'ENOENT' });
});
