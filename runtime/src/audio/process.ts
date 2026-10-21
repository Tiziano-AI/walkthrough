import { spawnOwnedStage, releaseOwnedStage, runSupervisedAudio } from '../core/stage-process.ts';
import { writeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // Darwin can return EPERM for an existing group containing only zombies:
    // killpg1 excludes SZOMB members before checking whether any can be signaled.
    // This is still unsettled, never evidence of absence. Wait for ESRCH.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw new Error('AUDIO_PROCESS_GROUP_OBSERVATION_FAILED', { cause: error });
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) {
    // The last member may become unreaped between observation and signaling.
    // A persistent permission failure remains fatal at the settlement deadline.
    if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new Error('AUDIO_PROCESS_GROUP_STOP_FAILED', { cause: error });
  }
}

async function settleGroup(pid: number): Promise<boolean> {
  if (!groupExists(pid)) return false;
  signalGroup(pid, 'SIGTERM');
  for (let i = 0; i < 30 && groupExists(pid); i++) await delay(100);
  if (groupExists(pid)) signalGroup(pid, 'SIGKILL');
  for (let i = 0; i < 50 && groupExists(pid); i++) await delay(100);
  if (groupExists(pid)) throw new Error('AUDIO_PROCESS_GROUP_NOT_SETTLED');
  return true;
}

/** One owned POSIX process group includes sandbox-exec, the Node worker, and Voices.
 * Do not reject until the direct child has closed and its group is gone. */
export async function runOwnedAudioProcess(input: {
  executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  stdout: number; stderr: number; signal?: AbortSignal;
  stdoutPath?: string; stderrPath?: string;
}): Promise<void> {
  if (input.signal?.aborted) throw new Error('AUDIO_ABORTED');
  if (process.env.WALKTHROUGH_STAGE_CUSTODY === 'fd3-v1') {
    if (!input.stdoutPath || !input.stderrPath) throw new Error('AUDIO_LOG_PATHS_REQUIRED');
    return runSupervisedAudio({ ...input, requestPath: input.args.at(-1)!, stdoutPath: input.stdoutPath, stderrPath: input.stderrPath });
  }
  await new Promise<void>((accept, reject) => {
    const child = spawnOwnedStage(input.executable, input.args, {
      cwd: input.cwd, env: input.env, detached: true,
      stdio: ['ignore', input.stdout, input.stderr],
    });
    let stopRequested = false;
    let startFailed = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopRequested = true;
      if (child.pid) {
        try { signalGroup(child.pid, 'SIGTERM'); } catch { /* close settlement retries and reports */ }
        escalation = setTimeout(() => {
          if (child.pid) { try { signalGroup(child.pid, 'SIGKILL'); } catch { /* close settlement reports */ } }
        }, 3000);
        escalation.unref();
      }
    };
    input.signal?.addEventListener('abort', stop, { once: true });
    if (input.signal?.aborted) stop();
    const ceiling = setTimeout(stop, 60 * 60 * 1000);
    ceiling.unref();
    child.once('spawn', () => writeSync(input.stderr, `${JSON.stringify({ lifecycle: 'audio-process-started', processGroupId: child.pid })}\n`));
    child.once('error', () => { startFailed = true; });
    child.once('close', async (code) => {
      clearTimeout(ceiling);
      if (escalation) clearTimeout(escalation);
      input.signal?.removeEventListener('abort', stop);
      try {
        const descendantsNeededCleanup = child.pid ? await settleGroup(child.pid) : false;
        releaseOwnedStage(child.pid);
        writeSync(input.stderr, `${JSON.stringify({ lifecycle: 'audio-process-settled', processGroupId: child.pid ?? null, aborted: stopRequested })}\n`);
        if (stopRequested) throw new Error('AUDIO_ABORTED');
        if (startFailed) throw new Error('AUDIO_PROCESS_START_FAILED');
        if (descendantsNeededCleanup) throw new Error('AUDIO_UNEXPECTED_DESCENDANT_CLEANED_UP');
        if (code !== 0) throw new Error('AUDIO_RUNTIME_FAILED_LOCAL_LOGS_RETAINED');
        accept();
      } catch (error) { reject(error); }
    });
  });
}
