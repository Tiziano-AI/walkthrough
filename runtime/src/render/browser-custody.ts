import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

export const REMOTION_CUSTODY_VERSION = "4.0.538";
export const REMOTION_CUSTODY_UPSTREAM_SHA256 = "e5401a2f9ddacefd34814025ce2a26c378584cab31237b1655d74c880e07adfe";
// Deterministically derived from the one admitted upstream file by patchSource.
export const REMOTION_CUSTODY_PATCH_ID = "walkthrough-browser-custody-v1";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const require = createRequire(import.meta.url);

function replaceOnce(source: string, before: string, after: string) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error("render:browser_custody_patch_context_mismatch");
  return source.replace(before, after);
}

/** Narrow repair of the pinned dependency's actual spawn/readiness owner. */
export function patchBrowserRunnerSource(source: string) {
  if (digest(source) !== REMOTION_CUSTODY_UPSTREAM_SHA256) throw new Error("render:browser_custody_upstream_hash_mismatch");
  let result = replaceOnce(source, "    const proc = childProcess.spawn(launch.executablePath, launch.args, {", `    // ${REMOTION_CUSTODY_PATCH_ID}: the production worker is an already-owned
    // process-group leader. Inherit its group atomically at spawn, so even a
    // hard-killed worker cannot strand a detached pre-readiness browser.
    const inheritsWorkerGroup = process.env.WALKTHROUGH_RENDER_GROUP_PID === String(process.pid);
    const proc = childProcess.spawn(launch.executablePath, launch.args, {`);
  result = replaceOnce(result, "        detached: process.platform !== 'win32',", "        detached: !inheritsWorkerGroup && process.platform !== 'win32',");
  const readiness = `    const browserWSEndpoint = await waitForWSEndpoint({
        browserProcess: proc,
        timeout,
        indent,
        logLevel,
    });
    const transport = await NodeWebSocketTransport_1.NodeWebSocketTransport.create(browserWSEndpoint);
    const connection = new Connection_1.Connection(transport);
`;
  result = replaceOnce(result, readiness, "");
  result = replaceOnce(result, "                if (process.platform === 'win32') {", `                if (inheritsWorkerGroup) {
                    // The caller owns group settlement; never signal -proc.pid,
                    // which is not a group identifier in this mode.
                    proc.kill('SIGKILL');
                }
                else if (process.platform === 'win32') {`);
  result = replaceOnce(result, `        if (closed) {
            return Promise.resolve();
        }`, `        if (closed) {
            killProcess();
            return processClosing;
        }`);
  result = replaceOnce(result, `    const processClosing = new Promise((fulfill, reject) => {
        proc.once('exit', () => {`, `    const processClosing = new Promise((fulfill, reject) => {
        // Spawn errors have no exit event. Settle them before awaiting readiness.
        proc.once('error', () => { closed = true; fulfill(); });
        proc.once('exit', () => {`);
  result = replaceOnce(result, `    const deleteBrowserCaches = () => {`, `    // Custody, signal handlers and settlement listeners now precede both awaits.
    let connection;
    try {
        const browserWSEndpoint = await waitForWSEndpoint({browserProcess: proc, timeout, indent, logLevel});
        const transport = await NodeWebSocketTransport_1.NodeWebSocketTransport.create(browserWSEndpoint);
        connection = new Connection_1.Connection(transport);
    }
    catch (error) {
        await closeProcess();
        throw error;
    }
    const deleteBrowserCaches = () => {`);
  return result;
}

async function dependencyIdentity() {
  const dist = path.dirname(require.resolve("@remotion/renderer"));
  const manifest = JSON.parse(await fs.readFile(path.join(dist, "../package.json"), "utf8"));
  if (manifest.version !== REMOTION_CUSTODY_VERSION) throw new Error("render:browser_custody_version_mismatch");
  return { filePath: path.join(dist, "browser/BrowserRunner.js"), version: REMOTION_CUSTODY_VERSION };
}

// The exact patched hash is pinned, not inferred from a marker or a passing test.
export const REMOTION_CUSTODY_PATCHED_SHA256 = "16e66ed2726ec04cd80e22baa91baa5a20d3454ac16422ee6538736eefcf775d";

export async function verifyBrowserCustodyPatch() {
  const identity = await dependencyIdentity();
  const sha256 = digest(await fs.readFile(identity.filePath));
  if (sha256 !== REMOTION_CUSTODY_PATCHED_SHA256) throw new Error("render:browser_custody_patch_not_provisioned");
  return { ...identity, sha256, patchId: REMOTION_CUSTODY_PATCH_ID };
}

/** Resolve the public CJS export whose BrowserRunner is the patched owner.
 * The package's ESM export inlines a separate, unpatched runner; never use it
 * for production browser launch while this pinned repair is required. */
export async function loadCustodiedRenderer(): Promise<typeof import("@remotion/renderer")> {
  await verifyBrowserCustodyPatch();
  return require("@remotion/renderer") as typeof import("@remotion/renderer");
}

/** Admit the inherited-group mode only in an actual private group leader. */
export async function enableBrowserGroupCustody() {
  // A newly exec'd worker can own group PID only when its launcher created it
  // as group leader. Signal 0 observes that exact group without a /bin/ps helper
  // (macOS sandboxing may prevent spawning the setuid process-inspection tool).
  try { process.kill(-process.pid, 0); }
  catch { throw new Error("render:worker_not_process_group_leader"); }
  process.env.WALKTHROUGH_RENDER_GROUP_PID = String(process.pid);
}

/** Explicit local provisioning; no downloads or mutation during a production run. */
export async function provisionBrowserCustodyPatch() {
  const identity = await dependencyIdentity();
  const original = await fs.readFile(identity.filePath, "utf8");
  if (digest(original) === REMOTION_CUSTODY_PATCHED_SHA256) return verifyBrowserCustodyPatch();
  const patched = patchBrowserRunnerSource(original);
  if (digest(patched) !== REMOTION_CUSTODY_PATCHED_SHA256) throw new Error("render:browser_custody_patch_hash_mismatch");
  // Only this version/hash-admitted dependency file is replaced. No npm hook.
  const temporary = `${identity.filePath}.walkthrough-patch-${process.pid}`;
  await fs.writeFile(temporary, patched, { flag: "wx", mode: (await fs.stat(identity.filePath)).mode & 0o777 });
  if (digest(await fs.readFile(identity.filePath)) !== REMOTION_CUSTODY_UPSTREAM_SHA256) throw new Error("render:browser_custody_dependency_changed_during_provision");
  await fs.rename(temporary, identity.filePath);
  return verifyBrowserCustodyPatch();
}
