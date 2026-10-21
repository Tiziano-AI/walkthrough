import assert from 'node:assert/strict';
import test from 'node:test';
import { audioMetrics } from '../src/audio/wav.ts';

const text = 'Save this proposal.';
function chunk(id: string, bytes: Buffer): Buffer {
  const result = Buffer.alloc(8 + bytes.length + bytes.length % 2);
  result.write(id, 0, 'latin1'); result.writeUInt32LE(bytes.length, 4); bytes.copy(result, 8);
  return result;
}
function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WAVE'), ...chunks]);
  const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
function format(): Buffer {
  const result = Buffer.alloc(16);
  result.writeUInt16LE(1, 0); result.writeUInt16LE(1, 2); result.writeUInt32LE(24_000, 4);
  result.writeUInt32LE(48_000, 8); result.writeUInt16LE(2, 12); result.writeUInt16LE(16, 14);
  return result;
}
function samples(count = 24_000, value = 8192): Buffer {
  const result = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) result.writeInt16LE(i % 2 ? value : -value, i * 2);
  return result;
}
function wav(data = samples(), fmt = format()): Buffer { return riff([chunk('fmt ', fmt), chunk('data', data)]); }

test('PCM16 mono24kHz metrics use signed samples normalized by 32768', () => {
  assert.deepEqual(audioMetrics(wav(), text), { durationSeconds: 1, sampleRate: 24_000, channels: 1, peak: 0.25, rms: 0.25, clippedSampleFraction: 0, wordsPerMinute: 180 });
  const data = samples(); data.writeInt16LE(-32768, 0); data.writeInt16LE(32767, 2);
  const metrics = audioMetrics(wav(data), text);
  assert.equal(metrics.peak, 1);
  assert.equal(metrics.clippedSampleFraction, 2 / 24_000);
  assert.ok(Math.abs(metrics.rms - Math.sqrt((23_998 * 0.25 ** 2 + 1 + (32767 / 32768) ** 2) / 24_000)) < 1e-12);
});

test('RIFF parsing skips bounded unknown chunks and odd-byte padding', () => {
  const bytes = riff([chunk('JUNK', Buffer.from([1, 2, 3])), chunk('data', samples()), chunk('fmt ', format()), chunk('LIST', Buffer.from([4]))]);
  assert.equal(audioMetrics(bytes, text).durationSeconds, 1);
  const extended = Buffer.concat([format(), Buffer.alloc(2)]);
  assert.equal(audioMetrics(wav(samples(), extended), text).sampleRate, 24_000);
});

test('WAV rejects malformed signatures, RIFF bounds and truncated chunk bodies', () => {
  const bytes = wav();
  for (const length of [0, 4, 11, 12, 19, 35, bytes.length - 1]) assert.throws(() => audioMetrics(bytes.subarray(0, length), text), /AUDIO_INVALID_WAV/);
  for (const index of [0, 8]) {
    const wrong = Buffer.from(bytes); wrong[index] |= 0x80;
    assert.throws(() => audioMetrics(wrong, text), /AUDIO_INVALID_WAV/);
  }
  assert.throws(() => audioMetrics(Buffer.concat([bytes, Buffer.from([0])]), text), /AUDIO_INVALID_WAV/);
  const truncatedChunk = Buffer.from(bytes); truncatedChunk.writeUInt32LE(0xffffffff, 40);
  assert.throws(() => audioMetrics(truncatedChunk, text), /AUDIO_INVALID_WAV/);
  assert.throws(() => audioMetrics(riff([chunk('fmt ', format()), chunk('data', samples()), Buffer.alloc(7)]), text), /AUDIO_INVALID_WAV/);
  const missingPad = chunk('JUNK', Buffer.from([1])).subarray(0, 9);
  assert.throws(() => audioMetrics(riff([chunk('fmt ', format()), chunk('data', samples()), missingPad]), text), /AUDIO_INVALID_WAV/);
});

test('WAV requires one format and one nonempty, sample-aligned data chunk', () => {
  for (const chunks of [[], [chunk('fmt ', format())], [chunk('data', samples())], [chunk('fmt ', format()), chunk('fmt ', format()), chunk('data', samples())], [chunk('fmt ', format()), chunk('data', samples()), chunk('data', samples())], [chunk('fmt ', format()), chunk('data', Buffer.alloc(0))], [chunk('fmt ', format()), chunk('data', Buffer.alloc(3))], [chunk('fmt ', Buffer.alloc(15)), chunk('data', samples())]]) {
    assert.throws(() => audioMetrics(riff(chunks), text), /AUDIO_INVALID_WAV/);
  }
});

test('unsupported encodings, channels, rates and format extensions are not guessed', () => {
  for (const [offset, value, width] of [[0, 3, 2], [0, 0xfffe, 2], [2, 2, 2], [4, 48_000, 4], [14, 24, 2]]) {
    const fmt = format(); if (width === 4) fmt.writeUInt32LE(value, offset); else fmt.writeUInt16LE(value, offset);
    assert.throws(() => audioMetrics(wav(samples(), fmt), text), /AUDIO_UNSUPPORTED_WAV_FORMAT/);
  }
  for (const extra of [Buffer.from([1]), Buffer.from([1, 0]), Buffer.alloc(4)]) assert.throws(() => audioMetrics(wav(samples(), Buffer.concat([format(), extra])), text), /AUDIO_UNSUPPORTED_WAV_FORMAT/);
  for (const offset of [8, 12]) {
    const fmt = format(); fmt.writeUInt16LE(0, offset);
    assert.throws(() => audioMetrics(wav(samples(), fmt), text), /AUDIO_INVALID_WAV/);
  }
});

test('silence, excessive clipping and implausible speech rates fail existing thresholds', () => {
  for (const data of [samples(24_000, 0), samples(24_000, 163), samples(1000), samples(72_000)]) assert.throws(() => audioMetrics(wav(data), text), /AUDIO_IMPLAUSIBLE_WAV_METRICS/);
  assert.ok(audioMetrics(wav(samples(24_000, 164)), text).rms >= 0.005);
  const data = samples();
  for (let i = 0; i < 24; i++) data.writeInt16LE(-32768, i * 2);
  assert.equal(audioMetrics(wav(data), text).clippedSampleFraction, 0.001);
  data.writeInt16LE(32767, 48);
  assert.throws(() => audioMetrics(wav(data), text), /AUDIO_IMPLAUSIBLE_WAV_METRICS/);
  assert.equal(audioMetrics(wav(samples(17_280)), text).wordsPerMinute, 250);
  assert.throws(() => audioMetrics(wav(samples(17_279)), text), /AUDIO_IMPLAUSIBLE_WAV_METRICS/);
  const thirteenWords = Array(13).fill('word').join(' ');
  assert.equal(audioMetrics(wav(samples(288_000)), thirteenWords).wordsPerMinute, 65);
  assert.throws(() => audioMetrics(wav(samples(288_001)), thirteenWords), /AUDIO_IMPLAUSIBLE_WAV_METRICS/);
  assert.throws(() => audioMetrics(wav(), 'Too short'), /AUDIO_BEAT_LENGTH_UNSUPPORTED/);
});
