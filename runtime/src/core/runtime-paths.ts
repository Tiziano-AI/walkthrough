import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Immutable program bytes and mutable user state have independent owners. */
export function runtimePaths() {
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const stateRoot = process.env.WALKTHROUGH_STATE_ROOT ?? join(homedir(), '.local/state/walkthrough');
  const configRoot = process.env.WALKTHROUGH_CONFIG_ROOT ?? join(homedir(), '.config/walkthrough');
  if (![stateRoot, configRoot].every(value => isAbsolute(value) && resolve(value) === value)) throw new Error('RUNTIME_ABSOLUTE_STATE_PATH_REQUIRED');
  return { runtimeRoot, stateRoot, configRoot, activeRoot: join(stateRoot, 'active'),
    audioProvisionPath: join(stateRoot, 'audio/provision.json'), audioCacheDirectory: join(stateRoot, 'audio/cache') };
}
