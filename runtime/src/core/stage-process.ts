import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { Socket } from 'node:net';
import { writeSync, fstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// One inherited local channel, not a socket service. Gates write registrations;
// only the coordinator reads acknowledgements and releases its own gates.
let channel: Socket | undefined;
const gates = new Map<number, { child: ChildProcess; release: string }>();
let audioSequence = 0;
const audioRequests = new Map<string, { finish: (error?: string) => void }>();
function custodyChannel() {
  if (channel) return channel;
  channel = new Socket({ fd: 3, readable: true, writable: true });
  channel.unref();
  let buffer = '';
  channel.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      const message = JSON.parse(line) as { type: string; pid: number; id?: string; error?: string };
      const gate = gates.get(message.pid);
      if (message.type === 'registered' && gate) {
        gates.delete(message.pid);
        gate.child.stdin!.end(gate.release);
      }
      if (message.type === 'audio-settled' && message.id) audioRequests.get(message.id)?.finish(message.error);
    }
  });
  const closeGates = () => {
    for (const { child } of gates.values()) child.stdin?.destroy();
    gates.clear();
    for (const request of audioRequests.values()) request.finish('AUDIO_SUPERVISOR_CHANNEL_LOST');
  };
  channel.on('end', closeGates);
  channel.on('error', closeGates);
  return channel;
}

/** One fixed audio endpoint: no executable, arguments, environment or media
 * content crosses this protocol. The unsandboxed supervisor applies deny-all
 * once to its own audio child, rather than changing the coordinator's policy. */
export async function runSupervisedAudio(input: {
  requestPath: string; stdoutPath: string; stderrPath: string;
  stdout: number; stderr: number; signal?: AbortSignal;
}): Promise<void> {
  if (input.signal?.aborted) throw new Error('AUDIO_ABORTED');
  const channel = custodyChannel();
  const id = `audio-${++audioSequence}`;
  const identity = (fd: number) => { const stat = fstatSync(fd); return { dev: stat.dev, ino: stat.ino }; };
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      try { writeSync(3, JSON.stringify({ type: 'audio-stop', id }) + '\n'); }
      catch { finish('AUDIO_SUPERVISOR_CHANNEL_LOST'); }
    };
    const finish = (error?: string) => {
      audioRequests.delete(id);
      input.signal?.removeEventListener('abort', abort);
      if (!audioRequests.size) channel.unref();
      if (error) reject(new Error(error)); else resolve();
    };
    audioRequests.set(id, { finish });
    channel.ref();
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      writeSync(3, JSON.stringify({ type: 'audio-start', id, requestPath: input.requestPath,
        stdout: { path: input.stdoutPath, ...identity(input.stdout) }, stderr: { path: input.stderrPath, ...identity(input.stderr) } }) + '\n');
      if (input.signal?.aborted) abort();
    } catch { finish('AUDIO_SUPERVISOR_CHANNEL_LOST'); }
  });
}

/** Preserve stage-specific cancellation while putting every production stage
 * group in the outer supervisor's custody before any executable starts. */
export function spawnOwnedStage(executable: string, args: string[], options: SpawnOptions): ChildProcess {
  if (process.env.WALKTHROUGH_STAGE_CUSTODY !== 'fd3-v1') {
    return spawn(executable, args, { ...options, detached: true });
  }
  custodyChannel();
  const stdio = options.stdio as ['ignore', number, number];
  const child = spawn(process.execPath, [fileURLToPath(new URL('./stage-gate.mjs', import.meta.url))], {
    ...options, detached: true, stdio: ['pipe', stdio[1], stdio[2], 3],
  });
  // spawn() establishes the PID synchronously; channel callbacks cannot run
  // until this gate is entered in the map. No release precedes supervisor ACK.
  if (child.pid) gates.set(child.pid, { child, release: JSON.stringify({ executable, args, env: options.env ?? process.env }) + '\n' });
  child.stdin!.on('error', () => { /* child close remains the stage owner's result */ });
  child.once('close', () => { if (child.pid) gates.delete(child.pid); });
  return child;
}

/** Call only after kernel observation that the exact stage group is absent. */
export function releaseOwnedStage(pid: number | undefined) {
  if (pid && process.env.WALKTHROUGH_STAGE_CUSTODY === 'fd3-v1') {
    writeSync(3, JSON.stringify({ type: 'settled', pid }) + '\n');
  }
}
