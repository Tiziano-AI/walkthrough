import {open} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import type {CDPSession,Page} from 'playwright';

/** One target-scoped session; stopping releases only this recording's lease. */
export type RecordingSession=Pick<CDPSession,'send'|'detach'>;
export type Recording=Awaited<ReturnType<typeof startRecordingOnSession>>;

/** Native WebContents recording. No Playwright WebM recorder or FPS conversion. */
export async function startRecording(page: Page, destination: string) {
  const session = await page.context().newCDPSession(page);
  return startRecordingOnSession(session,destination);
}

/** The caller selects the target; capture owns this session through stop. */
export async function startRecordingOnSession(session:RecordingSession,destination:string) {
  const before = performance.now();
  const {stream} = await session.send('Page.startScreenRecording', {
    audio: false, maxWidth: 3200, maxHeight: 1800, frameRate: 60,
  });
  const after = performance.now();
  let stopped = false;
  return {
    clock: 'node-performance-ms',
    requestedStartIntervalMs: [before, after],
    // Command acknowledgement is not a claim of first compositor presentation.
    async stop() {
      if (stopped) throw new Error('Recording already stopped');
      stopped = true;
      const stopBefore = performance.now();
      const result = await session.send('Page.stopScreenRecording');
      const stopAfter = performance.now();
      const file = await open(destination, 'wx', 0o600);
      try {
        let eof = false;
        while (!eof) {
          const chunk = await session.send('IO.read', {handle: result.stream ?? stream, size: 1024 * 1024});
          await file.write(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
          eof = chunk.eof;
        }
      } finally {
        await file.close();
        await session.send('IO.close', {handle: result.stream ?? stream});
        await session.detach();
      }
      return {destination, requestedStartIntervalMs: [before, after], requestedStopIntervalMs: [stopBefore, stopAfter]};
    },
  };
}
