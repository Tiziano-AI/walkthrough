import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioEnvironment, readAudioProvision, stableJson, validateAudioProvision, provisionVoices, defaultVoiceId } from '../audio/provision.ts';
import { runtimePaths } from './runtime-paths.ts';

const runtimeKeys = ['python', 'executable', 'platform', 'voices_version', 'source_sha256', 'source_scope', 'packages', 'package_scope'] as const;
type RuntimeKey = typeof runtimeKeys[number];
type UnavailableReason = 'command-failed' | 'timeout' | 'output-limit' | 'aborted' | 'invalid-response' | 'toolchain-invalid';

export interface AudioReadinessInspection {
  status: 'missing' | 'invalid' | 'runtime-drift' | 'unavailable' | 'legacy-provision' | 'provisioned';
  manifestPath: string;
  checks: 'manifest-file-presence-and-public-runtime-identity';
  runtimeIdentityVerified: boolean;
  runtimeIntegrityVerified: false;
  mismatchKeys: RuntimeKey[];
  reason?: UnavailableReason;
  voices?: string[];
  defaultVoiceId?: string;
  languages?: ['English', 'Italian'];
  transcriptionProvisioned?: boolean;
}

/** Read-only availability and public runtime identity observation. This does
 * not synthesize, load models, verify model/voice bytes, or establish complete
 * environment integrity. The caller's loopback-only sandbox is inherited.
 * No raw command output, paths from doctor, or exception messages are returned.
 */
export async function inspectAudioReadiness(
  provisionManifestPath?: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AudioReadinessInspection> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const manifestPath = provisionManifestPath ?? runtimePaths().audioProvisionPath;
  const report = (status: AudioReadinessInspection['status'], extra: Partial<Pick<AudioReadinessInspection, 'reason' | 'mismatchKeys'>> = {}): AudioReadinessInspection => ({
    status, manifestPath, checks: 'manifest-file-presence-and-public-runtime-identity',
    runtimeIdentityVerified: status === 'provisioned' || status === 'legacy-provision', runtimeIntegrityVerified: false, mismatchKeys: [], ...extra,
  });
  if (options.signal?.aborted) return report('unavailable', { reason: 'aborted' });
  let manifest;
  try { manifest = await readAudioProvision(manifestPath); }
  catch (error) { return report(error instanceof Error && error.message === 'AUDIO_PROVISION_REQUIRED' ? 'missing' : 'invalid'); }
  if (options.signal?.aborted) return report('unavailable', { reason: 'aborted' });
  // Tests may shorten the deadline; callers cannot expand the production bound.
  const timeout = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(60_000, options.timeoutMs!)) : 60_000;
  let env: NodeJS.ProcessEnv;
  try { env = audioEnvironment(manifest, dirname(manifestPath)); }
  catch { return report('unavailable', { reason: 'toolchain-invalid' }); }
  const result = await new Promise<{ stdout: string } | { reason: UnavailableReason }>(accept => {
    execFile(manifest.voicesExecutable, ['--json', 'doctor'], {
      cwd: root, env,
      timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', killSignal: 'SIGKILL', signal: options.signal,
    }, (error, stdout) => {
      if (!error) return accept({ stdout });
      if (options.signal?.aborted) return accept({ reason: 'aborted' });
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return accept({ reason: 'output-limit' });
      if (error.killed && error.signal === 'SIGKILL') return accept({ reason: 'timeout' });
      accept({ reason: 'command-failed' });
    });
  });
  if ('reason' in result) return report('unavailable', result);
  try {
    const doctor: unknown = JSON.parse(result.stdout);
    if (!doctor || typeof doctor !== 'object' || Array.isArray(doctor) || !Object.hasOwn(doctor, 'runtime')) return report('unavailable', { reason: 'invalid-response' });
    const runtime = (doctor as { runtime: unknown }).runtime;
    // Reuse the selected provision's strict public runtime schema, without
    // accepting arbitrary output keys as diagnostic labels.
    const observed = validateAudioProvision({ ...manifest, runtime }).runtime;
    if (stableJson(observed) !== stableJson(manifest.runtime)) return report('runtime-drift', {
      mismatchKeys: runtimeKeys.filter(key => stableJson(observed[key]) !== stableJson(manifest.runtime[key])),
    });
    return { ...report(manifest.schemaVersion === 3 ? 'provisioned' : 'legacy-provision'), voices: provisionVoices(manifest).map(voice => voice.id),
      defaultVoiceId: defaultVoiceId(manifest), languages: ['English', 'Italian'], transcriptionProvisioned: manifest.schemaVersion === 3 };
  } catch { return report('unavailable', { reason: 'invalid-response' }); }
}
