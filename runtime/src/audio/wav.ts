import type { NarrationBeat } from './index.ts';
import { canonicalWords } from './captions.ts';

export type AudioMetrics = NarrationBeat['metrics'];

/** Inspect only the production format: little-endian RIFF PCM signed16, mono,
 * 24 kHz. No decoder, resampling, network access or model loading is involved.
 */
export function audioMetrics(wavBytes: Buffer, text: string): AudioMetrics {
  const invalid = (): never => { throw new Error('AUDIO_INVALID_WAV'); };
  if (!Buffer.isBuffer(wavBytes) || wavBytes.length < 12) invalid();
  if (wavBytes.toString('latin1', 0, 4) !== 'RIFF' || wavBytes.toString('latin1', 8, 12) !== 'WAVE') invalid();
  const riffEnd = wavBytes.readUInt32LE(4) + 8;
  if (riffEnd !== wavBytes.length) invalid();
  let formatSeen = false;
  let data: Buffer | undefined;
  for (let offset = 12; offset < riffEnd;) {
    if (riffEnd - offset < 8) invalid();
    const id = wavBytes.toString('latin1', offset, offset + 4);
    const size = wavBytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    const paddedEnd = end + (size % 2);
    if (paddedEnd > riffEnd) invalid();
    if (id === 'fmt ') {
      if (formatSeen || size < 16) invalid();
      formatSeen = true;
      if (wavBytes.readUInt16LE(start) !== 1 || wavBytes.readUInt16LE(start + 2) !== 1
        || wavBytes.readUInt32LE(start + 4) !== 24_000 || wavBytes.readUInt16LE(start + 14) !== 16
        || (size !== 16 && (size !== 18 || wavBytes.readUInt16LE(start + 16) !== 0))) {
        throw new Error('AUDIO_UNSUPPORTED_WAV_FORMAT');
      }
      if (wavBytes.readUInt32LE(start + 8) !== 48_000 || wavBytes.readUInt16LE(start + 12) !== 2) invalid();
    } else if (id === 'data') {
      if (data !== undefined || size === 0 || size % 2 !== 0) invalid();
      data = wavBytes.subarray(start, end);
    }
    offset = paddedEnd;
  }
  if (!formatSeen || !data) return invalid();
  const sampleCount = data.length / 2;
  const durationSeconds = sampleCount / 24_000;
  const wordsPerMinute = canonicalWords(text).length * 60 / durationSeconds;
  // Reject impossible beat duration before scanning samples; canonical text is
  // capped at 160 words, so this also bounds the admitted sample workload.
  if (wordsPerMinute < 65 || wordsPerMinute > 250) throw new Error('AUDIO_IMPLAUSIBLE_WAV_METRICS');
  let peak = 0;
  let sumSquares = 0;
  let clippedSamples = 0;
  for (let offset = 0; offset < data.length; offset += 2) {
    const sample = data.readInt16LE(offset) / 32768;
    const absolute = Math.abs(sample);
    peak = Math.max(peak, absolute);
    sumSquares += sample * sample;
    if (absolute >= 0.999) clippedSamples++;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  const clippedSampleFraction = clippedSamples / sampleCount;
  if (rms < 0.005 || clippedSampleFraction > 0.001) {
    throw new Error('AUDIO_IMPLAUSIBLE_WAV_METRICS');
  }
  return { durationSeconds, sampleRate: 24_000, channels: 1, peak, rms, clippedSampleFraction, wordsPerMinute };
}
