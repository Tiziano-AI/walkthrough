import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

export const REMOTION_MEMORY_ADMISSION_VERSION = "4.0.520";
export const REMOTION_MEMORY_ADMISSION_PATCH_ID = "walkthrough-memory-admission-v1";
export const REMOTION_MEMORY_ADMISSION_UPSTREAM_SHA256 = "dd61f030b2603447063a007a07a705ebf7aa4e33d737dc1f83e119a80906ef00";
export const REMOTION_MEMORY_ADMISSION_PATCHED_SHA256 = "39b52814771bcb4c40dc107eca214bf91bfddc55811d168b84d24d9a0a6c0d82";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const require = createRequire(import.meta.url);

/** Only the prestitcher admission sample changes. Cache and thread sizing keep
 * Remotion's getAvailableMemory; its estimate and strict reserve stay intact. */
export function patchMemoryAdmissionSource(source: string) {
  if (digest(source) !== REMOTION_MEMORY_ADMISSION_UPSTREAM_SHA256) throw new Error("render:memory_admission_upstream_hash_mismatch");
  const before = "    const freeMemory = (0, get_available_memory_1.getAvailableMemory)(logLevel);";
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error("render:memory_admission_patch_context_mismatch");
  const sample = `    // ${REMOTION_MEMORY_ADMISSION_PATCH_ID}: Node 24's Darwin sample includes
    // reclaimable inactive/purgeable memory; free-only bytes understate admission.
    const freeMemory = process.platform === 'darwin'
        ? process.availableMemory()
        : (0, get_available_memory_1.getAvailableMemory)(logLevel);
    const validMemorySample = Number.isSafeInteger(freeMemory) && freeMemory >= 0;`;
  let patched = source.replace(before, sample);
  const admission = "    const hasEnoughMemory = (0, exports.hasEnoughMemoryForParallelEncoding)({";
  if (patched.indexOf(admission) < 0 || patched.indexOf(admission) !== patched.lastIndexOf(admission)) throw new Error("render:memory_admission_patch_context_mismatch");
  patched = patched.replace(admission, "    const hasEnoughMemory = (process.platform !== 'darwin' || validMemorySample) && (0, exports.hasEnoughMemoryForParallelEncoding)({");
  const returnPoint = "    return {\n        hasEnoughMemory,\n        freeMemory,\n        estimatedUsage,\n    };";
  if (patched.indexOf(returnPoint) < 0 || patched.indexOf(returnPoint) !== patched.lastIndexOf(returnPoint)) throw new Error("render:memory_admission_patch_context_mismatch");
  patched = patched.replace(returnPoint, `    // Keep the actual admission input before onStart or browser cleanup can fail.
    // stderr is the already-owned renderer log, never the public JSON channel.
    process.stderr.write(JSON.stringify({
        kind: 'walkthrough-render-memory-admission', schemaVersion: 1,
        platform: process.platform,
        memorySource: process.platform === 'darwin' ? 'node:process.availableMemory' : '@remotion/renderer:getAvailableMemory',
        sampleValid: validMemorySample,
        availableBytes: validMemorySample ? freeMemory : null, estimatedUsageBytes: estimatedUsage,
        minimumRemainingBytes: MINIMUM_MEMORY_LEFT,
        requiredAvailableBytesExclusive: estimatedUsage + MINIMUM_MEMORY_LEFT,
        width, height, hasEnoughMemory,
    }) + '\\n');
${returnPoint}`);
  return patched;
}

async function dependencyIdentity() {
  const dist = path.dirname(require.resolve("@remotion/renderer"));
  const manifest = JSON.parse(await fs.readFile(path.join(dist, "../package.json"), "utf8"));
  if (manifest.version !== REMOTION_MEMORY_ADMISSION_VERSION) throw new Error("render:memory_admission_version_mismatch");
  return { filePath: path.join(dist, "prestitcher-memory-usage.js"), version: REMOTION_MEMORY_ADMISSION_VERSION };
}

/** Production verifies exact bytes; it never provisions or repairs dependencies. */
export async function verifyMemoryAdmissionPatch() {
  const identity = await dependencyIdentity();
  const sha256 = digest(await fs.readFile(identity.filePath));
  if (sha256 !== REMOTION_MEMORY_ADMISSION_PATCHED_SHA256) throw new Error("render:memory_admission_patch_not_provisioned");
  return { ...identity, sha256, patchId: REMOTION_MEMORY_ADMISSION_PATCH_ID };
}

/** Explicit installation/development provisioning of the one admitted file. */
export async function provisionMemoryAdmissionPatch() {
  const identity = await dependencyIdentity();
  const original = await fs.readFile(identity.filePath, "utf8");
  if (digest(original) === REMOTION_MEMORY_ADMISSION_PATCHED_SHA256) return verifyMemoryAdmissionPatch();
  const patched = patchMemoryAdmissionSource(original);
  if (digest(patched) !== REMOTION_MEMORY_ADMISSION_PATCHED_SHA256) throw new Error("render:memory_admission_patch_hash_mismatch");
  const temporary = `${identity.filePath}.walkthrough-patch-${process.pid}`;
  const handle = await fs.open(temporary, "wx", (await fs.stat(identity.filePath)).mode & 0o777);
  try {
    try { await handle.writeFile(patched); } finally { await handle.close(); }
    if (digest(await fs.readFile(identity.filePath)) !== REMOTION_MEMORY_ADMISSION_UPSTREAM_SHA256) throw new Error("render:memory_admission_dependency_changed_during_provision");
    await fs.rename(temporary, identity.filePath);
  } finally { await fs.rm(temporary, { force: true }); }
  return verifyMemoryAdmissionPatch();
}

export interface MemoryAdmission {
  kind: 'walkthrough-render-memory-admission'; schemaVersion: 1;
  platform: string; memorySource: 'node:process.availableMemory' | '@remotion/renderer:getAvailableMemory';
  sampleValid: boolean; availableBytes: number | null; estimatedUsageBytes: number; minimumRemainingBytes: number;
  requiredAvailableBytesExclusive: number; width: number; height: number; hasEnoughMemory: boolean;
}

/** Only bounded numeric metadata crosses into the public failure. The rest of
 * the retained child log, including any application text, stays private. */
function admittedDiagnostic(value: unknown): value is MemoryAdmission {
  if (!value || typeof value !== 'object') return false;
  const item = value as MemoryAdmission;
  return item.kind === 'walkthrough-render-memory-admission' && item.schemaVersion === 1
    && typeof item.platform === 'string' && item.platform.length <= 32
    && item.memorySource === (item.platform === 'darwin' ? 'node:process.availableMemory' : '@remotion/renderer:getAvailableMemory')
    && [item.estimatedUsageBytes, item.minimumRemainingBytes, item.requiredAvailableBytesExclusive, item.width, item.height].every(value => Number.isSafeInteger(value) && value >= 0)
    && item.width > 0 && item.height > 0
    && item.estimatedUsageBytes === item.width * item.height * 1000
    && item.minimumRemainingBytes === 2_000_000_000
    && item.requiredAvailableBytesExclusive === item.estimatedUsageBytes + item.minimumRemainingBytes
    && (item.sampleValid === true && typeof item.availableBytes === 'number' && Number.isSafeInteger(item.availableBytes) && item.availableBytes >= 0
      && item.hasEnoughMemory === (item.availableBytes > item.requiredAvailableBytesExclusive)
      || item.platform === 'darwin' && item.sampleValid === false && item.availableBytes === null && item.hasEnoughMemory === false);
}

export interface StreamingEncodingRefusal {
  causeCode: 'render:streaming_encoding_required';
  memoryAdmission?: MemoryAdmission;
}

/** The refusal precedes cleanup in the owned log. Do not mistake a later
 * Target closed error for its primary cause, or infer OOM from this decision. */
export async function readStreamingEncodingRefusal(diagnosticPath: string): Promise<StreamingEncodingRefusal | undefined> {
  const stream = createReadStream(diagnosticPath, { encoding: 'utf8', highWaterMark: 16 * 1024 });
  let memoryAdmission: MemoryAdmission | undefined;
  const refusal = (): StreamingEncodingRefusal => ({ causeCode: 'render:streaming_encoding_required', ...(memoryAdmission ? { memoryAdmission } : {}) });
  const acceptLine = (line: string) => {
    if (line === 'render:streaming_encoding_required') return true;
    if (line.startsWith('{"kind":"walkthrough-render-memory-admission",')) {
      try {
        const item: unknown = JSON.parse(line);
        if (admittedDiagnostic(item)) {
          const { kind, schemaVersion, platform, memorySource, sampleValid, availableBytes, estimatedUsageBytes, minimumRemainingBytes, requiredAvailableBytesExclusive, width, height, hasEnoughMemory } = item;
          memoryAdmission = { kind, schemaVersion, platform, memorySource, sampleValid, availableBytes, estimatedUsageBytes, minimumRemainingBytes, requiredAvailableBytesExclusive, width, height, hasEnoughMemory };
        }
      } catch { /* An incomplete or malformed diagnostic is not an admission. */ }
    }
    return false;
  };
  let line = '', dropping = false;
  try {
    // Skip oversized unrelated lines without retaining them. The primary cause
    // remains discoverable after verbose bundling output, not just in a prefix.
    for await (const chunk of stream) {
      const text = String(chunk);
      for (let start = 0; start < text.length;) {
        const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline;
        if (!dropping) {
          if (line.length + end - start > 2048) { line = ''; dropping = true; }
          else line += text.slice(start, end);
        }
        if (newline < 0) break;
        if (!dropping && acceptLine(line)) return refusal();
        line = ''; dropping = false; start = newline + 1;
      }
    }
    return !dropping && acceptLine(line) ? refusal() : undefined;
  } finally { stream.destroy(); }
}
