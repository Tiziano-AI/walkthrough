import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeLocal } from "../src/render/media.ts";
import { patchBrowserRunnerSource, verifyBrowserCustodyPatch, REMOTION_CUSTODY_PATCHED_SHA256 } from "../src/render/browser-custody.ts";

const worker = fileURLToPath(new URL("./render-custody-worker.ts", import.meta.url));
const root = path.resolve(path.dirname(worker), "..");

async function fixture(mode: "waiting" | "exit" | "websocket-failure") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "walkthrough-browser-custody-"));
  const executable = path.join(directory, "synthetic-browser");
  const receipt = path.join(directory, "processes.json");
  const script = `#!${process.execPath}
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const helper=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
process.on('SIGTERM',()=>{});
fs.writeFileSync(process.env.TEST_CUSTODY_RECEIPT,JSON.stringify({browser:process.pid,helper:helper.pid,worker:process.ppid}),{flag:'wx'});
if(process.env.TEST_CUSTODY_MODE==='exit')setTimeout(()=>process.exit(23),150);
if(process.env.TEST_CUSTODY_MODE==='websocket-failure')setTimeout(()=>console.error('DevTools listening on ws://127.0.0.1:1/devtools/browser/synthetic-not-listening'),150);
setInterval(()=>{},1000);
`;
  await fs.writeFile(executable, script, { flag: "wx", mode: 0o700 });
  const env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, TEST_CUSTODY_RECEIPT: receipt, TEST_CUSTODY_MODE: mode };
  return { directory, executable, receipt, env };
}

async function readReceipt(file: string) {
  const deadline = Date.now() + 10000;
  while (true) {
    try { return JSON.parse(await fs.readFile(file, "utf8")) as { browser: number; helper: number; worker: number }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (Date.now() >= deadline) throw new Error("test:browser_never_launched");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function absent(pid: number) {
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH", `process ${pid} must be gone`);
}

async function containFailedTest(pids: { browser: number; helper: number; worker: number }) {
  // Assertions above establish the result. This finally-only recovery prevents
  // a future regression from leaving our deliberately resistant fake processes.
  for (const pid of Object.values(pids)) {
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  const deadline = Date.now() + 5000;
  for (const pid of Object.values(pids)) {
    while (true) {
      try { process.kill(pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error; }
      if (Date.now() >= deadline) throw new Error("test:synthetic_process_recovery_unsettled");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

test("renderer verifies actual version-pinned patched dependency bytes", async () => {
  assert.equal((await verifyBrowserCustodyPatch()).sha256, REMOTION_CUSTODY_PATCHED_SHA256);
  assert.throws(() => patchBrowserRunnerSource("unknown version or local edits"), /upstream_hash_mismatch/);
});

test("transient permission-denied group observation cannot mask the worker result or release custody early", async (t) => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'walkthrough-group-observation-'));
  const originalKill=process.kill;
  let pendingObservations=2, observedAbsent=false;
  const probe=t.mock.method(process,'kill',function(pid:number,signal?:number|NodeJS.Signals){
    if(pid<0&&signal===0){
      if(pendingObservations-->0)throw Object.assign(new Error('transient group observation'),{code:'EPERM'});
      try{return originalKill.call(process,pid,signal);}
      catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')observedAbsent=true;throw error;}
    }
    return originalKill.call(process,pid,signal);
  });
  try{
    await assert.rejects(executeLocal(process.execPath,['-e','process.exit(23)'],path.join(directory,'worker.log')),/render:local_process_failed/);
    assert.ok(pendingObservations<0,'permission denial must be followed by another kernel observation');
    assert.equal(observedAbsent,true,'the worker failure can settle only after ESRCH, never on EPERM');
  }finally{probe.mock.restore();await fs.rm(directory,{recursive:true,force:true});}
});

test("cancellation before browser readiness settles exact browser and resistant helper", async () => {
  const f = await fixture("waiting");
  const abort = new AbortController();
  const result = executeLocal("/usr/bin/sandbox-exec", ["-f", path.join(root, "scripts/loopback-only.sb"), process.execPath, worker, f.executable], path.join(f.directory, "worker.log"), 20000, f.env, abort.signal);
  const rejection = assert.rejects(result, /render:cancelled/);
  const pids = await readReceipt(f.receipt);
  abort.abort();
  try {
    await rejection;
    absent(pids.browser); absent(pids.helper); absent(pids.worker);
    absent(-pids.worker);
  } finally { await containFailedTest(pids); }
});

test("hard worker death before readiness cannot strand the browser in another group", async () => {
  const f = await fixture("waiting");
  const result = executeLocal("/usr/bin/sandbox-exec", ["-f", path.join(root, "scripts/loopback-only.sb"), process.execPath, worker, f.executable], path.join(f.directory, "worker.log"), 20000, f.env);
  const rejection = assert.rejects(result, /render:local_process_failed/);
  const pids = await readReceipt(f.receipt);
  process.kill(pids.worker, "SIGKILL");
  try {
    await rejection;
    absent(pids.browser); absent(pids.helper); absent(pids.worker);
    absent(-pids.worker);
  } finally { await containFailedTest(pids); }
});

for (const mode of ["exit", "websocket-failure"] as const) {
  test(`browser ${mode} during readiness leaves neither browser nor helper behind`, async () => {
    const f = await fixture(mode);
    const result = executeLocal("/usr/bin/sandbox-exec", ["-f", path.join(root, "scripts/loopback-only.sb"), process.execPath, worker, f.executable], path.join(f.directory, "worker.log"), 20000, f.env);
    const rejection = assert.rejects(result, /render:local_process_failed/);
    const pids = await readReceipt(f.receipt);
    try {
      await rejection;
      absent(pids.browser); absent(pids.helper); absent(pids.worker);
      absent(-pids.worker);
    } finally { await containFailedTest(pids); }
  });
}
