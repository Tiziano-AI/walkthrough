import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';

export const CAPTURE_CUSTODY_VERSION = '1.63.0';
export const CAPTURE_CUSTODY_UPSTREAM_SHA256 = '549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171';
export const CAPTURE_CUSTODY_PATCH_ID = 'walkthrough-capture-browser-custody-v1';
export const CAPTURE_CUSTODY_PATCHED_SHA256 = 'a308452e0ba659c3aa22e770833721d97c6297e4205e10ce6ef2d9c7f3037863';
const require = createRequire(import.meta.url);
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function replaceOnce(source: string, before: string, after: string) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error('capture:browser_custody_patch_context_mismatch');
  return source.replace(before, after);
}

export function patchCaptureBrowserSource(source: string) {
  if (digest(source) !== CAPTURE_CUSTODY_UPSTREAM_SHA256) throw new Error('capture:browser_custody_upstream_hash_mismatch');
  let result = replaceOnce(source, 'async function launchProcess(options) {', `async function launchProcess(options) {
  // ${CAPTURE_CUSTODY_PATCH_ID}: the public supervisor already owns this
  // coordinator group. Inherit it atomically, including before browser readiness.
  const inheritsCoordinatorGroup = process.env.WALKTHROUGH_CAPTURE_GROUP_PID === String(process.pid);`);
  result = replaceOnce(result, '    detached: process.platform !== "win32",', '    detached: !inheritsCoordinatorGroup && process.platform !== "win32",');
  result = replaceOnce(result, '          process.kill(-spawnedProcess.pid, "SIGKILL");', `          // Inherited mode has no group named after the browser PID.
          process.kill(inheritsCoordinatorGroup ? spawnedProcess.pid : -spawnedProcess.pid, "SIGKILL");`);
  return result;
}

async function dependencyIdentity() {
  const manifest = JSON.parse(await fs.readFile(require.resolve('playwright-core/package.json'), 'utf8'));
  if (manifest.version !== CAPTURE_CUSTODY_VERSION) throw new Error('capture:browser_custody_version_mismatch');
  // Both public ESM and CJS exports converge on this one coreBundle owner.
  return { filePath: require.resolve('playwright-core/lib/coreBundle'), version: CAPTURE_CUSTODY_VERSION };
}

export async function verifyCaptureBrowserCustodyPatch() {
  const identity = await dependencyIdentity();
  const sha256 = digest(await fs.readFile(identity.filePath));
  if (sha256 !== CAPTURE_CUSTODY_PATCHED_SHA256) throw new Error('capture:browser_custody_patch_not_provisioned');
  return { ...identity, sha256, patchId: CAPTURE_CUSTODY_PATCH_ID };
}

export async function enableCaptureBrowserGroupCustody() {
  await verifyCaptureBrowserCustodyPatch();
  if (process.env.WALKTHROUGH_STAGE_CUSTODY !== 'fd3-v1') throw new Error('capture:supervisor_custody_required');
  try { process.kill(-process.pid, 0); }
  catch { throw new Error('capture:coordinator_not_process_group_leader'); }
  process.env.WALKTHROUGH_CAPTURE_GROUP_PID = String(process.pid);
}

/** Explicit no-download provisioning; production only verifies installed bytes. */
export async function provisionCaptureBrowserCustodyPatch() {
  const identity = await dependencyIdentity();
  const original = await fs.readFile(identity.filePath, 'utf8');
  if (digest(original) === CAPTURE_CUSTODY_PATCHED_SHA256) return verifyCaptureBrowserCustodyPatch();
  const patched = patchCaptureBrowserSource(original);
  if (digest(patched) !== CAPTURE_CUSTODY_PATCHED_SHA256) throw new Error('capture:browser_custody_patch_hash_mismatch');
  const temporary = `${identity.filePath}.walkthrough-patch-${process.pid}`;
  await fs.writeFile(temporary, patched, { flag: 'wx', mode: (await fs.stat(identity.filePath)).mode & 0o777 });
  if (digest(await fs.readFile(identity.filePath)) !== CAPTURE_CUSTODY_UPSTREAM_SHA256) throw new Error('capture:browser_custody_dependency_changed_during_provision');
  await fs.rename(temporary, identity.filePath);
  return verifyCaptureBrowserCustodyPatch();
}
