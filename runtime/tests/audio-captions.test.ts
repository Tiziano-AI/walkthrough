import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWords, captionCues, validateAlignment, vttTime } from '../src/audio/captions.ts';

const text = 'Save this proposal.';
const raw = (source = text, step = 0.4) => canonicalWords(source).map((word, i) => ({ text: word.normalized, start_time: i * step, end_time: (i + 1) * step }));

test('canonical punctuation, apostrophes, Unicode L/N, case and whitespace survive', () => {
  const source = "Save  the three-day proposal.\nDon't café ½ 𐐀.";
  const tokens = canonicalWords(source);
  assert.deepEqual(tokens.map(word => word.normalized), ['Save', 'the', 'threeday', 'proposal', "Don't", 'café', '½', '𐐀']);
  assert.ok(tokens.every(word => source.slice(word.charStart, word.charEnd) === word.text));
  assert.deepEqual(captionCues(source, validateAlignment(source, raw(source), 3.5)).map(cue => cue.text), ["Save  the three-day proposal.", "Don't café ½ 𐐀."]);
  assert.deepEqual(canonicalWords('Save\u0085this\u00a0proposal.').map(word => word.text), ['Save', 'this', 'proposal.']);
  assert.equal(canonicalWords('Use curly’s cafe\u0301.')[1].normalized, 'curlys');
  assert.equal(canonicalWords('Use curly’s cafe\u0301.')[2].normalized, 'cafe');
});

test('canonical text is bounded and unsupported standalone punctuation or CJK is rejected', () => {
  for (const source of ['', ' Save this proposal.', 'Save this proposal.\n', 'Save\tthis proposal.', 'Save\u0000 this proposal.']) {
    assert.throws(() => canonicalWords(source), /AUDIO_INVALID_CANONICAL_TEXT/);
  }
  for (const source of ['Save proposal.', Array(161).fill('word').join(' ')]) assert.throws(() => canonicalWords(source), /AUDIO_BEAT_LENGTH_UNSUPPORTED/);
  assert.throws(() => canonicalWords(`Save this ${'x'.repeat(2500)}`), /AUDIO_INVALID_CANONICAL_TEXT/);
  assert.throws(() => canonicalWords('Save — proposal.'), /AUDIO_STANDALONE_PUNCTUATION_UNSUPPORTED/);
  assert.throws(() => canonicalWords('Save this 中.'), /AUDIO_UNSUPPORTED_LANGUAGE_SCRIPT/);
});

test('alignment requires exact normalized spelling, order and complete coverage', () => {
  for (const items of [[], null, {}, raw().slice(1), [...raw(), raw()[0]]]) assert.throws(() => validateAlignment(text, items, 2), /AUDIO_ALIGNMENT_COVERAGE/);
  for (const replacement of ['save', 'Wrong', 'proposal.']) {
    const items = raw(); items[0].text = replacement;
    assert.throws(() => validateAlignment(text, items, 2), /AUDIO_ALIGNMENT_CANONICAL_MISMATCH/);
  }
  for (const duration of [0, -1, NaN, Infinity]) assert.throws(() => validateAlignment(text, raw(), duration), /AUDIO_ALIGNMENT_COVERAGE/);
});

test('invalid timestamps and overlaps are rejected rather than repaired', () => {
  for (const [start, end] of [[-1, 1], [2, 1], [0, 4], [NaN, 1], [0, Infinity], ['0', 1], [false, 1], [0, null]]) {
    const items: unknown[] = raw(); items[0] = { text: 'Save', start_time: start, end_time: end };
    assert.throws(() => validateAlignment(text, items, 2), /AUDIO_ALIGNMENT_INVALID_SPAN/);
  }
  const items = raw(); items[1].start_time = 0.2;
  assert.throws(() => validateAlignment(text, items, 2), /AUDIO_ALIGNMENT_INVALID_SPAN/);
  const missing = raw().map(({ text: token }) => ({ text: token }));
  assert.throws(() => validateAlignment(text, missing, 2), /AUDIO_ALIGNMENT_INVALID_SPAN/);
});

test('alignment retains the existing timing plausibility and 1ms end tolerance', () => {
  assert.throws(() => validateAlignment(text, raw(text, 3), 9), /AUDIO_ALIGNMENT_IMPLAUSIBLE_SPAN/);
  const gap = raw().map(word => ({ ...word, start_time: word.start_time + 2.01, end_time: word.end_time + 2.01 }));
  assert.throws(() => validateAlignment(text, gap, 4), /AUDIO_ALIGNMENT_IMPLAUSIBLE_SPAN/);
  assert.throws(() => validateAlignment(text, raw(), 4.3), /AUDIO_ALIGNMENT_EXCESS_TRAILING_AUDIO/);
  const items = raw(); items[2].end_time = 1.2005;
  assert.equal(validateAlignment(text, items, 1.2)[2].endSeconds, 1.2005);
  items[2].end_time = 1.202;
  assert.throws(() => validateAlignment(text, items, 1.2), /AUDIO_ALIGNMENT_INVALID_SPAN/);
});

test('zero-width estimates stay unresolved, but a supported enclosing cue survives', () => {
  const items = raw(); items[1].end_time = items[1].start_time;
  const words = validateAlignment(text, items, 1.5);
  assert.equal(words[1].timingResolved, false);
  assert.equal(words[1].startSeconds, 0.4);
  assert.equal(words[1].endSeconds, 0.4);
  assert.deepEqual(captionCues(text, words), [{ text, startSeconds: 0, endSeconds: 1.2000000000000002 }]);
  const unresolved = raw().map(word => ({ ...word, start_time: 0.4, end_time: 0.4 }));
  assert.throws(() => captionCues(text, validateAlignment(text, unresolved, 1)), /AUDIO_CAPTION_WITHOUT_SUPPORTED_SPAN/);
});

test('cue boundaries honor 9 words, 56 characters, 6 seconds, and sentence punctuation', () => {
  for (const source of ['Choose the package and then select a person before saving the proposal once.', Array(20).fill('readability').join(' '), Array(8).fill('word').join(' ')]) {
    const step = source.startsWith('word') ? 1 : 0.5;
    const items = raw(source, step);
    const cues = captionCues(source, validateAlignment(source, items, items.length * step));
    assert.ok(cues.length > 1);
    assert.ok(cues.every(cue => cue.text.length <= 56 && cue.text.split(' ').length <= 9 && cue.endSeconds - cue.startSeconds <= 6));
    assert.equal(cues.map(cue => cue.text).join(' '), source);
  }
  const source = 'Save this proposal! Now choose another;';
  assert.deepEqual(captionCues(source, validateAlignment(source, raw(source), 2.5)).map(cue => cue.text), ['Save this proposal!', 'Now choose another;']);
});

test('VTT milliseconds roll over correctly and match ties-to-even rounding', () => {
  assert.equal(vttTime(65.125), '00:01:05.125');
  assert.equal(vttTime(3599.9996), '01:00:00.000');
  assert.equal(vttTime(0.0005), '00:00:00.000');
  assert.equal(vttTime(0.0015), '00:00:00.002');
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => vttTime(value), /AUDIO_INVALID_VTT_TIME/);
});

test('captions keep sentence tails, linked phrases and measurements together', () => {
  for (const [source, expected] of [
    ['Better. Save this proposal.', ['Better.', 'Save this proposal.']],
    ['Lower cost per index task and lower median end-to-end response time are better. The response estimate assumes a five-hundred-token answer.', ['Lower cost per index task', 'and lower median end-to-end response time are better.', 'The response estimate assumes', 'a five-hundred-token answer.']],
    ['We will turn that evidence into a small, annotated shortlist we can reopen.', ['We will turn that evidence into a small,', 'annotated shortlist we can reopen.']],
    ['Medium effort adds 5.7 intelligence points, 8.29 cents per task and 3.63 seconds.', ['Medium effort adds 5.7 intelligence points,', '8.29 cents per task and 3.63 seconds.']],
  ] as const) {
    const items = raw(source, 0.3);
    const words = validateAlignment(source, items, items.length * 0.3);
    const cues = captionCues(source, words);
    assert.deepEqual(cues.map(cue => cue.text), expected);
    assert.equal(cues.map(cue => cue.text).join(' '), source);
    for (const cue of cues) {
      const first = words.find(word => word.startSeconds === cue.startSeconds)!;
      const last = words.find(word => word.endSeconds === cue.endSeconds)!;
      assert.equal(cue.text, source.slice(first.charStart, last.charEnd));
    }
  }
});

test('caption grouping admits unresolved leading words without inventing timing', () => {
  const source = 'The first complete match is visible.';
  const items = raw(source); items[0].end_time = 0;
  const words = validateAlignment(source, items, items.length * 0.4);
  assert.deepEqual(captionCues(source, words), [{ text: source, startSeconds: 0, endSeconds: 2.4000000000000004 }]);
  assert.equal(words[0].timingResolved, false);
});

test('an unresolved short sentence borrows only a real enclosing span', () => {
  for (const source of ['Done. Save this proposal.', 'Save this proposal. Done.']) {
    const items = raw(source);
    const unresolved = source.startsWith('Done.') ? 0 : items.length - 1;
    items[unresolved].end_time = items[unresolved].start_time;
    const words = validateAlignment(source, items, items.length * 0.4);
    assert.deepEqual(captionCues(source, words), [{ text: source, startSeconds: words[0].startSeconds, endSeconds: words.at(-1)!.endSeconds }]);
    assert.equal(words[unresolved].timingResolved, false);
  }
});

test('punctuated numbers remain phrase boundaries', () => {
  const source = 'Its intelligence score rises to 47.8, while cost and response time also rise.';
  const items = raw(source, 0.3);
  assert.deepEqual(captionCues(source, validateAlignment(source, items, items.length * 0.3)).map(cue => cue.text), [
    'Its intelligence score rises to 47.8,', 'while cost and response time also rise.',
  ]);
});

test('short visible phrases retain canonical spelling and whitespace without rewording', () => {
  for (const source of [
    ['a'.repeat(23), 'b'.repeat(23), 'c'.repeat(23)].join(' '),
    `Read ${'x'.repeat(45)} now.`,
    'Keep  this\nline intact.',
  ]) {
    const items = raw(source);
    const words = validateAlignment(source, items, items.length * 0.4);
    const cues = captionCues(source, words);
    assert.equal(cues.map(cue => cue.text).join(' '), source);
    assert.ok(cues.every(cue => cue.text.length <= 56));
  }
  const indivisible = `Read ${'x'.repeat(77)} now.`;
  assert.throws(() => captionCues(indivisible, validateAlignment(indivisible, raw(indivisible), 1.5)), /AUDIO_CAPTION_LIMIT_UNSUPPORTED/);
});

test('a real aligned pause clears captions rather than holding the phrase through silence', () => {
  const source = 'Explore the frontier and inspect the trade-offs.';
  const items = raw(source, .3).map((word, index) => index < 3 ? word : {...word, start_time: word.start_time + .6, end_time: word.end_time + .6});
  const cues = captionCues(source, validateAlignment(source, items, 3));
  assert.deepEqual(cues.map(cue => cue.text), ['Explore the frontier', 'and inspect the trade-offs.']);
  assert.ok(Math.abs(cues[0].endSeconds - .9) < 1e-9);
  assert.equal(cues[1].startSeconds, 1.5);
  assert.equal(cues.map(cue => cue.text).join(' '), source);
});
