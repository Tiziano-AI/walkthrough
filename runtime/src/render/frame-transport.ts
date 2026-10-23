import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

export const REMOTION_FRAME_TRANSPORT_VERSION = "4.0.538";
export const REMOTION_FRAME_TRANSPORT_PATCH_ID = "walkthrough-frame-transport-v1";
export const REMOTION_FRAME_TRANSPORT_FILES = {
  esm: {
    relativePath: "dist/esm/index.mjs",
    upstreamSha256: "11d895cf1290745cad71ea9ac7c589b9941a1cc2e8e0be3d416e13562bd1fff4",
    patchedSha256: "386b1792a81bff6b4b0aa6f819287c47a36d8b6974127c237efc7b944af1ef6b",
  },
  cjs: {
    relativePath: "dist/cjs/video/OffthreadVideoForRendering.js",
    upstreamSha256: "033a8684197792018a21f427fe0c4a5b2021e65a8a027d79ffe6e759bafdcec9",
    patchedSha256: "421f0564442aa65286f4f0b413a0e680ca189a0ac12680e05c9c0101170cd024",
  },
} as const;
type Format = keyof typeof REMOTION_FRAME_TRANSPORT_FILES;
const formats: Format[] = ["esm", "cjs"];
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const require = createRequire(import.meta.url);

/** Only the response-body transport changes; fetch, errors and URL custody stay upstream-owned. */
export function patchFrameTransportSource(source: string, format: Format) {
  if (digest(source) !== REMOTION_FRAME_TRANSPORT_FILES[format].upstreamSha256) throw new Error("render:frame_transport_upstream_hash_mismatch");
  const indent = format === "esm" ? "        " : "                ";
  const before = `${indent}const blob = await res.blob();`;
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error("render:frame_transport_patch_context_mismatch");
  return source.replace(before, [
    `${indent}// ${REMOTION_FRAME_TRANSPORT_PATCH_ID}: register complete bytes, not a streamed Blob.`,
    `${indent}// Normal Blob quotas still apply; this does not remove retained-frame memory.`,
    `${indent}const bytes = await res.arrayBuffer();`,
    `${indent}const blob = new Blob([bytes], { type: res.headers.get("content-type") ?? undefined });`,
  ].join("\n"));
}

async function dependencyIdentity() {
  const manifestPath = require.resolve("remotion/package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.version !== REMOTION_FRAME_TRANSPORT_VERSION) throw new Error("render:frame_transport_version_mismatch");
  return {
    version: REMOTION_FRAME_TRANSPORT_VERSION,
    files: formats.map(format => ({ format, ...REMOTION_FRAME_TRANSPORT_FILES[format], filePath: path.join(path.dirname(manifestPath), REMOTION_FRAME_TRANSPORT_FILES[format].relativePath) })),
  };
}

/** Runtime verification never provisions or mutates dependencies. Both entry points must agree. */
export async function verifyFrameTransportPatch() {
  const identity = await dependencyIdentity();
  const files = [];
  for (const file of identity.files) {
    const sha256 = digest(await fs.readFile(file.filePath));
    if (sha256 !== file.patchedSha256) throw new Error("render:frame_transport_patch_not_provisioned");
    files.push({ format: file.format, filePath: file.filePath, sha256 });
  }
  return { version: identity.version, patchId: REMOTION_FRAME_TRANSPORT_PATCH_ID, files };
}

/** Explicit setup only. Admit every preimage before writing any dependency. */
export async function provisionFrameTransportPatch() {
  const identity = await dependencyIdentity();
  const admitted = [];
  for (const file of identity.files) {
    const original = await fs.readFile(file.filePath, "utf8");
    const originalSha256 = digest(original);
    const patched = originalSha256 === file.patchedSha256 ? original : patchFrameTransportSource(original, file.format);
    if (digest(patched) !== file.patchedSha256) throw new Error("render:frame_transport_patch_hash_mismatch");
    admitted.push({ ...file, originalSha256, patched });
  }
  const pending = admitted.filter(file => file.originalSha256 !== file.patchedSha256);
  const temporaryFiles: string[] = [];
  try {
    for (const file of pending) {
      const temporary = `${file.filePath}.walkthrough-patch-${process.pid}`;
      const handle = await fs.open(temporary, "wx", (await fs.stat(file.filePath)).mode & 0o777);
      temporaryFiles.push(temporary);
      try { await handle.writeFile(file.patched); } finally { await handle.close(); }
    }
    // Recheck the entire pair before replacement; an unknown second file must
    // never leave a newly patched first file behind. A stopped known partial
    // provision can be explicitly rejoined because each file has a pinned hash.
    for (const file of admitted) {
      if (digest(await fs.readFile(file.filePath)) !== file.originalSha256) throw new Error("render:frame_transport_dependency_changed_during_provision");
    }
    for (const [index, file] of pending.entries()) {
      if (digest(await fs.readFile(file.filePath)) !== file.originalSha256) throw new Error("render:frame_transport_dependency_changed_during_provision");
      await fs.rename(temporaryFiles[index], file.filePath);
    }
  } finally {
    for (const temporary of temporaryFiles) await fs.rm(temporary, { force: true });
  }
  return verifyFrameTransportPatch();
}
