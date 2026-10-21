import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { synthesizeNarration } from '../src/audio/index.ts';
import { runOwnedAudioProcess } from '../src/audio/process.ts';

test('audio requires absolute local run identity', async () => {
  await assert.rejects(synthesizeNarration({ runDirectory: 'relative', beats: [{ id: 'sample', text: 'Save this proposal.' }] }), /AUDIO_ABSOLUTE_RUN_DIRECTORY_REQUIRED/);
});

test('audio rejects duplicate beat identities before runtime', async () => {
  await assert.rejects(synthesizeNarration({ runDirectory: '/not-used', beats: [{ id: 'sample', text: 'Save this proposal.' }, { id: 'sample', text: 'Save another proposal.' }] }), /AUDIO_INVALID_BEATS/);
});

test('audio rejects traversal beat identities before runtime', async () => {
  await assert.rejects(synthesizeNarration({ runDirectory: '/not-used', beats: [{ id: '../escape', text: 'Save this proposal.' }] }), /AUDIO_INVALID_BEATS/);
});

test('audio fails missing provision without a runtime download', async () => {
  await assert.rejects(synthesizeNarration({ runDirectory: '/not-used', provisionManifestPath: '/not-existing-walkthrough-provision.json', beats: [{ id: 'sample', text: 'Save this proposal.' }] }), /AUDIO_PROVISION_REQUIRED/);
});

test('audio rejects an incomplete provision before creating a run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'walkthrough-audio-binding-'));
  try {
    const manifest = join(root, 'provision.json');
    const runDirectory = join(root, 'never-created');
    await writeFile(manifest, JSON.stringify({ voice: { id: 'selected-voice' } }));
    await assert.rejects(synthesizeNarration({ runDirectory, provisionManifestPath: manifest, voiceId: 'wrong-voice', beats: [{ id: 'sample', text: 'Save this proposal.' }] }), /AUDIO_PROVISION_SCHEMA/);
    await assert.rejects(readFile(join(runDirectory, 'audio/request.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true }); }
});

test('audio abort settles the exact child and grandchild process group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'walkthrough-audio-cancel-'));
  const log = await open(join(root, 'synthetic.log'), 'wx');
  const pidPath = join(root, 'grandchild.pid');
  const controller = new AbortController();
  const code = `const{spawn}=require('node:child_process'); const{writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidPath)},String(child.pid));setInterval(()=>{},1000);`;
  const running = runOwnedAudioProcess({ executable: process.execPath, args: ['-e', code], cwd: root, env: process.env, stdout: log.fd, stderr: log.fd, signal: controller.signal });
  const settled = assert.rejects(running, /AUDIO_ABORTED/);
  try {
    let grandchild = 0;
    for (let i = 0; i < 100; i++) {
      try { grandchild = Number(await readFile(pidPath, 'utf8')); break; } catch { await delay(20); }
    }
    assert.ok(grandchild > 0);
    controller.abort();
    await settled;
    assert.throws(() => process.kill(grandchild, 0), { code: 'ESRCH' });
  } finally {
    controller.abort();
    await settled;
    await log.close();
    await rm(root, { recursive: true });
  }
});

for (const persistent of [false, true]) {
  test(`audio group observation ${persistent ? 'retains custody on persistent' : 'waits through transient'} EPERM`, { timeout: 15000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'walkthrough-audio-eperm-'));
    const logPath = join(root, 'synthetic.log');
    const log = await open(logPath, 'wx');
    const pidPath = join(root, 'stage.pid');
    const controller = new AbortController();
    let stage = 0, injected = 0;
    const kill = process.kill.bind(process);
    // Inject only the exact owned group's post-exit kernel transition. The
    // ordinary signal first kills the real child; no unrelated PID is touched.
    t.mock.method(process, 'kill', ((pid: number, signal?: number | NodeJS.Signals) => {
      if (stage && pid === -stage) {
        let absent = false;
        try { kill(pid, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (absent && (persistent || injected < 3)) {
          injected++;
          throw Object.assign(new Error('synthetic unreaped group'), { code: 'EPERM', errno: -1 });
        }
      }
      return kill(pid, signal);
    }) as typeof process.kill);
    const code = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);`;
    const running = runOwnedAudioProcess({ executable: process.execPath, args: ['-e', code], cwd: root, env: process.env, stdout: log.fd, stderr: log.fd, signal: controller.signal });
    // Attach immediately so a failure cannot escape the fixture's cleanup.
    const outcome = running.then(() => null, error => error as Error);
    try {
      for (let i = 0; i < 100; i++) {
        try { stage = Number(await readFile(pidPath, 'utf8')); break; } catch { await delay(20); }
      }
      assert.ok(stage > 0);
      controller.abort();
      const error = await outcome;
      assert.equal(error?.message, persistent ? 'AUDIO_PROCESS_GROUP_NOT_SETTLED' : 'AUDIO_ABORTED');
      assert.ok(injected >= 3, 'fixture must exercise repeated EPERM observations and signaling');
      const lifecycle = await readFile(logPath, 'utf8');
      if (persistent) assert.doesNotMatch(lifecycle, /audio-process-settled/);
      else assert.match(lifecycle, /audio-process-settled/);
      assert.throws(() => kill(-stage, 0), { code: 'ESRCH' });
    } finally {
      t.mock.restoreAll();
      controller.abort();
      await outcome;
      if (stage) { try { kill(-stage, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
      await log.close();
      await rm(root, { recursive: true });
    }
  });
}
