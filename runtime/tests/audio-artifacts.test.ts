import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIO_MODELS, type CurrentAudioProvision } from '../src/audio/provision.ts';
import { verifyRuntime, verifyRenderedArtifact, verifyAlignedArtifact, verifyTranscribedArtifact } from '../src/audio/artifacts.ts';

function fixture() {
  const runtime = { python: '3.13.5', executable: '/synthetic/python', platform: 'synthetic-platform', voices_version: '0.3.0', source_sha256: 'a'.repeat(64), source_scope: 'installed-python-source-at-observation' as const, packages: { voices: '0.3.0', mlx: 'synthetic' }, package_scope: 'selected-runtime-dependencies' as const, compute: null };
  const model = (role: keyof typeof AUDIO_MODELS) => ({ ...AUDIO_MODELS[role], snapshotPath: `/synthetic/${role}`, files: [], resolverTree: { size: 1, sha256: 'b'.repeat(64) } });
  const voice = { id: 'studio-reader', libraryPath: '/synthetic/library', files: { 'reference.wav': 'c'.repeat(64), 'reference.txt': 'd'.repeat(64), 'voice.json': 'e'.repeat(64) } };
  const provision: CurrentAudioProvision = { schemaVersion: 3, voicesExecutable: '/synthetic/voices', hubCacheDirectory: '/synthetic/hub', cacheDirectory: '/synthetic/cache', runtime, models: { tts: model('tts'), aligner: model('aligner'), asr: model('asr') }, defaultVoiceId: voice.id, voices: [voice] };
  const text = 'Preserve exact provenance.', wavSha256 = 'f'.repeat(64), duration = 1.5;
  const artifact = { schema_version: 2, runtime: structuredClone(runtime), voice_id: voice.id, reference_voice_id: voice.id, text, language: 'English', base_model_id: AUDIO_MODELS.tts.repository, base_model_revision: AUDIO_MODELS.tts.revision, reference_sha256: voice.files['reference.wav'] };
  const audio = { sha256: wavSha256, duration_seconds: duration, sample_rate: 16000, channels: 1, normalized_dtype: '<f4', normalized_sha256: '0'.repeat(64), waveform_basis: 'ffmpeg-normalized-mono-pcm16-to-float32' };
  const aligned = { runtime: structuredClone(runtime), model_id: AUDIO_MODELS.aligner.repository, model_revision: AUDIO_MODELS.aligner.revision, text, language: 'English', audio, timing_basis: 'qwen-forced-aligner-estimator-adjusted', spoken_content_verified: false, timing_diagnostics: null, diagnostic_limit: 'Synthetic timing only.', words: [{ text: 'Preserve', start: 0, end: .5 }, { text: 'exact', start: .5, end: 1 }, { text: 'provenance', start: 1, end: 1.5 }] };
  const transcribed = { runtime: structuredClone(runtime), model_id: AUDIO_MODELS.asr.repository, model_revision: AUDIO_MODELS.asr.revision, transcript: text, language: 'English', audio };
  return { provision, artifact, aligned, transcribed, checks: [
    () => verifyRenderedArtifact(artifact, text, provision),
    () => verifyAlignedArtifact(aligned, text, wavSha256, duration, provision),
    () => verifyTranscribedArtifact(transcribed, wavSha256, duration, provision, 'English'),
  ] };
}

test('fresh identities and retained artifacts admit local null, preserving absent historical provenance', () => {
  const f = fixture();
  verifyRuntime(f.provision.runtime, f.provision); for (const check of f.checks) check();
  for (const provider of [f.artifact, f.aligned, f.transcribed]) provider.runtime.executable = '/unavailable/original-python';
  for (const check of f.checks) check(); // Retained locators need not still exist.
  assert.throws(() => verifyRuntime(f.artifact.runtime, f.provision), /AUDIO_RUNTIME_IDENTITY_DRIFT/);
  delete f.provision.runtime.compute;
  for (const check of f.checks) assert.throws(check, /AUDIO_RUNTIME_IDENTITY_DRIFT/);
  for (const provider of [f.artifact, f.aligned, f.transcribed]) delete (provider.runtime as { compute?: null }).compute;
  for (const check of f.checks) check();
});

test('both sides of fresh and retained comparisons reject matched remote or malformed identities', () => {
  for (const mutate of [
    (runtime: any) => { runtime.compute = { backend: 'dgx' }; },
    (runtime: any) => { runtime.compute = undefined; },
    (runtime: any) => { runtime.source_scope = 'remote-python-source-at-observation'; },
    (runtime: any) => { runtime.unexpected = null; },
    (runtime: any) => { runtime.executable = 'python'; },
  ]) {
    for (const side of ['actual', 'expected', 'both']) {
      const f = fixture();
      if (side !== 'actual') mutate(f.provision.runtime);
      if (side !== 'expected') for (const provider of [f.artifact, f.aligned, f.transcribed]) mutate(provider.runtime);
      assert.throws(() => verifyRuntime(f.artifact.runtime, f.provision), /AUDIO_RUNTIME_IDENTITY_DRIFT/);
      for (const check of f.checks) assert.throws(check, /AUDIO_RUNTIME_IDENTITY_DRIFT/);
    }
  }
});
