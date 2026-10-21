import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import test, { type TestContext } from "node:test";
import {
  patchFrameTransportSource, verifyFrameTransportPatch,
  REMOTION_FRAME_TRANSPORT_FILES, REMOTION_FRAME_TRANSPORT_PATCH_ID, REMOTION_FRAME_TRANSPORT_VERSION,
} from "../src/render/frame-transport.ts";

type Format = keyof typeof REMOTION_FRAME_TRANSPORT_FILES;
type PatchModule = typeof import("../src/render/frame-transport.ts");
const formats: Format[] = ["esm", "cjs"];
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const packageDirectory = path.dirname(createRequire(import.meta.url).resolve("remotion/package.json"));

async function upstreamSource(format: Format) {
  const pin = REMOTION_FRAME_TRANSPORT_FILES[format];
  const installed = await fs.readFile(path.join(packageDirectory, pin.relativePath), "utf8");
  if (digest(installed) === pin.upstreamSha256) return installed;
  assert.equal(digest(installed), pin.patchedSha256, "tests require the exact admitted dependency, not an unknown local edit");
  // Recover the pinned upstream fixture without downloading or mutating it.
  // Matching its independent hash also proves all error/abort/URL code outside
  // the transport replacement is byte-for-byte unchanged.
  const original = installed.replace(
    /^( +)\/\/ walkthrough-frame-transport-v1: register complete bytes, not a streamed Blob\.\n +\/\/ Normal Blob quotas still apply; this does not remove retained-frame memory\.\n +const bytes = await res\.arrayBuffer\(\);\n +const blob = new Blob\(\[bytes\], \{ type: res\.headers\.get\("content-type"\) \?\? undefined \}\);/m,
    "$1const blob = await res.blob();",
  );
  assert.equal(digest(original), pin.upstreamSha256);
  return original;
}

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "walkthrough-frame-transport-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dependency = path.join(directory, "node_modules/remotion");
  await fs.mkdir(dependency, { recursive: true });
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await fs.writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "remotion", version: REMOTION_FRAME_TRANSPORT_VERSION }));
  const files = {} as Record<Format, string>;
  for (const format of formats) {
    const file = path.join(dependency, REMOTION_FRAME_TRANSPORT_FILES[format].relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, await upstreamSource(format), { mode: 0o640 });
    files[format] = file;
  }
  const modulePath = path.join(directory, "frame-transport.ts");
  await fs.copyFile(new URL("../src/render/frame-transport.ts", import.meta.url), modulePath);
  const module = await import(pathToFileURL(modulePath).href) as PatchModule;
  return { directory, dependency, files, module };
}

test("installed transport verifies the actual version and both exact patched dependency files", async () => {
  const result = await verifyFrameTransportPatch();
  assert.equal(result.version, REMOTION_FRAME_TRANSPORT_VERSION);
  assert.equal(result.patchId, REMOTION_FRAME_TRANSPORT_PATCH_ID);
  assert.equal(result.files.length, 2);
  for (const file of result.files) {
    assert.equal(file.sha256, REMOTION_FRAME_TRANSPORT_FILES[file.format].patchedSha256);
    assert.equal(digest(await fs.readFile(file.filePath)), file.sha256);
  }
});

test("exact upstream sources produce only the pinned transport replacements", async () => {
  for (const format of formats) {
    const upstream = await upstreamSource(format);
    const patched = patchFrameTransportSource(upstream, format);
    assert.equal(digest(patched), REMOTION_FRAME_TRANSPORT_FILES[format].patchedSha256);
    assert.throws(() => patchFrameTransportSource(`${upstream}\n`, format), /upstream_hash_mismatch/);
    assert.throws(() => patchFrameTransportSource(patched, format), /upstream_hash_mismatch/);
    assert.throws(() => patchFrameTransportSource("unknown bytes", format), /upstream_hash_mismatch/);
  }
});

test("explicit provision changes both owners, preserves modes and is idempotent", async t => {
  const f = await fixture(t);
  await assert.rejects(f.module.verifyFrameTransportPatch(), /patch_not_provisioned/);
  const result = await f.module.provisionFrameTransportPatch();
  assert.deepEqual(result, await f.module.verifyFrameTransportPatch());
  assert.deepEqual(await f.module.provisionFrameTransportPatch(), result);
  for (const format of formats) {
    assert.equal(digest(await fs.readFile(f.files[format])), REMOTION_FRAME_TRANSPORT_FILES[format].patchedSha256);
    assert.equal((await fs.stat(f.files[format])).mode & 0o777, 0o640);
    assert.deepEqual((await fs.readdir(path.dirname(f.files[format]))).filter(name => name.includes("walkthrough-patch")), []);
  }
});

test("unknown second preimage refuses all writes, even when the first is admitted", async t => {
  const f = await fixture(t);
  await fs.appendFile(f.files.cjs, "\n// foreign change\n");
  const before = await Promise.all(formats.map(format => fs.readFile(f.files[format])));
  await assert.rejects(f.module.provisionFrameTransportPatch(), /upstream_hash_mismatch/);
  for (const [index, format] of formats.entries()) {
    assert.deepEqual(await fs.readFile(f.files[format]), before[index]);
    assert.deepEqual((await fs.readdir(path.dirname(f.files[format]))).filter(name => name.includes("walkthrough-patch")), []);
  }
});

test("version drift and marker-bearing modified bytes fail closed without runtime repair", async t => {
  const f = await fixture(t);
  await f.module.provisionFrameTransportPatch();
  await fs.appendFile(f.files.cjs, "\n// changed despite the retained patch marker\n");
  const changed = await fs.readFile(f.files.cjs);
  await assert.rejects(f.module.verifyFrameTransportPatch(), /patch_not_provisioned/);
  await assert.rejects(f.module.provisionFrameTransportPatch(), /upstream_hash_mismatch/);
  assert.deepEqual(await fs.readFile(f.files.cjs), changed);
  await fs.writeFile(path.join(f.dependency, "package.json"), JSON.stringify({ version: "4.0.521" }));
  await assert.rejects(f.module.verifyFrameTransportPatch(), /version_mismatch/);
  await assert.rejects(f.module.provisionFrameTransportPatch(), /version_mismatch/);
});

test("explicit provision rejoins an exact known partial provision", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.files.esm, patchFrameTransportSource(await upstreamSource("esm"), "esm"));
  await assert.rejects(f.module.verifyFrameTransportPatch(), /patch_not_provisioned/);
  assert.deepEqual(await f.module.provisionFrameTransportPatch(), await f.module.verifyFrameTransportPatch());
});

async function frameExecution(format: Format, response: Pick<Response, "status" | "headers" | "arrayBuffer" | "json">, options: { aborted?: boolean; onError?: boolean } = {}) {
  const source = patchFrameTransportSource(await upstreamSource(format), format);
  const bodyIndex = source.indexOf("const bytes = await res.arrayBuffer();");
  const start = source.lastIndexOf("const execute = async () => {", bodyIndex);
  const end = source.indexOf("\n" + (format === "esm" ? "    " : "        ") + "execute();", bodyIndex);
  assert.ok(start >= 0 && end > start);
  const declaration = source.slice(start, end).trim();
  assert.ok(!declaration.includes("res.blob("));
  const expression = declaration.slice("const execute = ".length, -1);
  const controller = new AbortController();
  if (options.aborted) controller.abort();
  const blobs: Blob[] = [], revoked: string[] = [], cleanup: Array<() => void> = [];
  const images: Array<{ src: string; handle: number }> = [], continued: number[] = [], errors: Error[] = [], canceled: Error[] = [];
  const requests: Array<{ src: string; init: RequestInit }> = [];
  const execute = vm.runInNewContext(`(${expression})`, {
    Blob, Error, controller, cleanup, newHandle: 73, actualSrc: "http://127.0.0.1/frame.png",
    fetch: async (src: string, init: RequestInit) => { requests.push({ src, init }); return response; },
    URL: {
      createObjectURL: (blob: Blob) => { blobs.push(blob); return "blob:retained-frame"; },
      revokeObjectURL: (url: string) => revoked.push(url),
    },
    setImageSrc: (image: { src: string; handle: number }) => images.push(image),
    continueRender: (handle: number) => continued.push(handle),
    continueRender2: (handle: number) => continued.push(handle),
    onError: options.onError === false ? undefined : (error: Error) => errors.push(error),
    cancelRender: (error: Error) => canceled.push(error),
    cancel_render_js_1: { cancelRender: (error: Error) => canceled.push(error) },
  }) as () => Promise<void>;
  await execute();
  assert.equal(requests.length, 1, "there is no fallback or retry");
  assert.equal(requests[0].init.signal, controller.signal);
  assert.equal(requests[0].init.cache, "no-store");
  return { blobs, revoked, cleanup, images, continued, errors, canceled };
}

for (const format of formats) {
  test(`${format} response transport preserves bytes and MIME above the streamed-Blob threshold`, async () => {
    for (const size of [31, 5 * 1024 * 1024 + 31]) {
      const bytes = new Uint8Array(size);
      for (let index = 0; index < size; index++) bytes[index] = index % 251;
      for (const contentType of ["image/png", "image/jpeg", undefined]) {
        const headers = new Headers(contentType ? { "content-type": contentType } : {});
        const response = new Response(bytes, { headers });
        response.blob = () => { throw new Error("streamed Blob transport must not be used"); };
        const result = await frameExecution(format, response);
        assert.equal(result.blobs.length, 1);
        assert.equal(result.blobs[0].type, contentType ?? "");
        assert.deepEqual(new Uint8Array(await result.blobs[0].arrayBuffer()), bytes);
        assert.deepEqual(result.errors, []);
        assert.equal(result.images.length, 1);
        assert.equal(result.images[0].src, "blob:retained-frame");
        assert.equal(result.images[0].handle, 73);
        assert.deepEqual(result.revoked, [], "the URL stays live until upstream cleanup runs");
        assert.equal(result.cleanup.length, 1);
        result.cleanup[0]();
        assert.deepEqual(result.revoked, ["blob:retained-frame"]);
      }
    }
  });

  test(`${format} body rejection and abort keep upstream error and continuation handling`, async () => {
    const failure = new Error("body read failed");
    const response = { status: 200, headers: new Headers(), arrayBuffer: async (): Promise<ArrayBuffer> => { throw failure; }, json: async () => ({}) };
    const failed = await frameExecution(format, response);
    assert.deepEqual(failed.errors, [failure]);
    assert.deepEqual(failed.blobs, []);
    assert.deepEqual(failed.cleanup, []);
    assert.deepEqual(failed.images, []);
    assert.deepEqual((await frameExecution(format, response, { onError: false })).canceled, [failure]);
    const aborted = await frameExecution(format, response, { aborted: true });
    assert.deepEqual(aborted.continued, [73]);
    assert.deepEqual(aborted.errors, []);
    const abortMessage = { ...response, arrayBuffer: async (): Promise<ArrayBuffer> => { throw new Error("The operation was aborted."); } };
    assert.deepEqual((await frameExecution(format, abortMessage)).continued, [73]);
    const fetchFailure = new Error("Failed to fetch");
    const wrapped = await frameExecution(format, { ...response, arrayBuffer: async (): Promise<ArrayBuffer> => { throw fetchFailure; } });
    assert.match(wrapped.errors[0].message, /^Failed to fetch http:\/\/127\.0\.0\.1\/frame\.png\./);
    assert.equal(wrapped.errors[0].cause, fetchFailure);
  });

  test(`${format} non-success responses retain upstream server errors and never read a frame body`, async () => {
    let bodyReads = 0;
    const response = { status: 500, headers: new Headers(), arrayBuffer: async () => { bodyReads++; return new ArrayBuffer(0); }, json: async () => ({ error: "Error: decoder refused frame" }) };
    const serverError = await frameExecution(format, response);
    assert.equal(serverError.errors[0].message, "decoder refused frame");
    const notFound = await frameExecution(format, { ...response, status: 404 });
    assert.equal(notFound.errors[0].message, "Server returned status 404 while fetching http://127.0.0.1/frame.png");
    assert.equal(bodyReads, 0);
    assert.deepEqual(serverError.blobs, []);
    assert.deepEqual(notFound.blobs, []);
  });
}
