import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

export const REMOTION_MEMORY_ADMISSION_VERSION = "4.0.538";
export const REMOTION_STREAMING_STRATEGY_SHA256 = "46309d658e5909324558ecae96adfc2096146a087ee674a86ac54e1436e7ab41";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const require = createRequire(import.meta.url);

/** Upstream removed its prestitcher admission/fallback in 4.0.538. Verify the
 * reviewed CJS strategy without resurrecting or patching its deleted module. */
export async function verifyStreamingEncodingStrategy() {
  const dist = path.dirname(require.resolve("@remotion/renderer"));
  const manifest = JSON.parse(await fs.readFile(path.join(dist, "../package.json"), "utf8"));
  if (manifest.version !== REMOTION_MEMORY_ADMISSION_VERSION) throw new Error("render:memory_admission_version_mismatch");
  const filePath = path.join(dist, "render-media.js"), sha256 = digest(await fs.readFile(filePath));
  if (sha256 !== REMOTION_STREAMING_STRATEGY_SHA256) throw new Error("render:streaming_strategy_hash_mismatch");
  return { filePath, version: REMOTION_MEMORY_ADMISSION_VERSION, sha256, admission: 'walkthrough-worker' as const };
}

/** Preserve the former strict 1000-byte/pixel estimate and 2 GB reserve at the
 * existing worker boundary. A sample is admission evidence, not an OOM oracle. */
export function streamingMemoryAdmission(width: number, height: number, availableBytes = process.availableMemory()): MemoryAdmission {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)
    || !Number.isSafeInteger(width * height * 1000 + 2_000_000_000)) throw new Error('render:memory_admission_dimensions_invalid');
  const sampleValid = Number.isSafeInteger(availableBytes) && availableBytes >= 0;
  const estimatedUsageBytes = width * height * 1000, minimumRemainingBytes = 2_000_000_000;
  const requiredAvailableBytesExclusive = estimatedUsageBytes + minimumRemainingBytes;
  return {kind: 'walkthrough-render-memory-admission', schemaVersion: 1, platform: process.platform,
    memorySource: 'node:process.availableMemory', sampleValid, availableBytes: sampleValid ? availableBytes : null,
    estimatedUsageBytes, minimumRemainingBytes, requiredAvailableBytesExclusive, width, height,
    hasEnoughMemory: sampleValid && availableBytes > requiredAvailableBytesExclusive};
}

export function requireStreamingMemory(width: number, height: number) {
  const admission = streamingMemoryAdmission(width, height);
  process.stderr.write(JSON.stringify(admission) + '\n');
  if (!admission.hasEnoughMemory) {
    process.stderr.write('render:streaming_encoding_required\n');
    throw new Error('render:streaming_encoding_required');
  }
  return admission;
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
    && (item.memorySource === 'node:process.availableMemory' || item.platform !== 'darwin' && item.memorySource === '@remotion/renderer:getAvailableMemory')
    && [item.estimatedUsageBytes, item.minimumRemainingBytes, item.requiredAvailableBytesExclusive, item.width, item.height].every(value => Number.isSafeInteger(value) && value >= 0)
    && item.width > 0 && item.height > 0
    && item.estimatedUsageBytes === item.width * item.height * 1000
    && item.minimumRemainingBytes === 2_000_000_000
    && item.requiredAvailableBytesExclusive === item.estimatedUsageBytes + item.minimumRemainingBytes
    && (item.sampleValid === true && typeof item.availableBytes === 'number' && Number.isSafeInteger(item.availableBytes) && item.availableBytes >= 0
      && item.hasEnoughMemory === (item.availableBytes > item.requiredAvailableBytesExclusive)
      || item.sampleValid === false && item.availableBytes === null && item.hasEnoughMemory === false);
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
