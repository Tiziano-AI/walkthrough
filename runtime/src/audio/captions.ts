import type { NarrationCaption, NarrationWord } from './index.ts';
import type { AudioLanguage } from './provision.ts';

export interface CanonicalWord { text: string; normalized: string; charStart: number; charEnd: number }
export interface RawAlignmentWord { text: string; start_time: number; end_time: number }

// Python's Unicode whitespace set, matching the retired runtime's tokenizer.
const whitespace = '\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const boundaryWhitespace = new RegExp(`^[${whitespace}]|[${whitespace}]$`, 'u');
const cjkIdeograph = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ee5f}\u{2f800}-\u{2fa1f}\u{30000}-\u{3347f}]/u;

/** Canonical spelling is never rewritten. Offsets use JS UTF-16 string indices. */
export function canonicalWords(text: string): CanonicalWord[] {
  if (typeof text !== 'string' || !text || text.length > 5000 || boundaryWhitespace.test(text) || [...text].length > 2500 || /[\u0000-\u0009\u000b-\u001f]/u.test(text)) {
    throw new Error('AUDIO_INVALID_CANONICAL_TEXT');
  }
  const words: CanonicalWord[] = [];
  for (const match of text.matchAll(new RegExp(`[^${whitespace}]+`, 'gu'))) {
    const token = match[0];
    const normalized = [...token].filter(char => /[\p{L}\p{N}']/u.test(char)).join('');
    if (!normalized) throw new Error('AUDIO_STANDALONE_PUNCTUATION_UNSUPPORTED');
    if (cjkIdeograph.test(normalized)) throw new Error('AUDIO_UNSUPPORTED_LANGUAGE_SCRIPT');
    words.push({ text: token, normalized, charStart: match.index, charEnd: match.index + token.length });
  }
  if (words.length < 3 || words.length > 160) throw new Error('AUDIO_BEAT_LENGTH_UNSUPPORTED');
  return words;
}

/** Validate the complete provider result; no missing-word or timing fallback. */
export function validateAlignment(text: string, rawItems: unknown, duration: number): NarrationWord[] {
  const canonical = canonicalWords(text);
  if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(rawItems) || rawItems.length !== canonical.length) {
    throw new Error('AUDIO_ALIGNMENT_COVERAGE');
  }
  let previousEnd = 0;
  const words = canonical.map((expected, index): NarrationWord => {
    const item = rawItems[index] as Partial<RawAlignmentWord> | null;
    if (!item || item.text !== expected.normalized) throw new Error('AUDIO_ALIGNMENT_CANONICAL_MISMATCH');
    const start = item.start_time;
    const end = item.end_time;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end < start || end > duration + 0.001 || start < previousEnd) {
      throw new Error('AUDIO_ALIGNMENT_INVALID_SPAN');
    }
    if (end - start > 2.5 || start - previousEnd > 2) throw new Error('AUDIO_ALIGNMENT_IMPLAUSIBLE_SPAN');
    previousEnd = end;
    return { text: expected.text, startSeconds: start, endSeconds: end, charStart: expected.charStart, charEnd: expected.charEnd, timingResolved: end > start };
  });
  if (duration - previousEnd > 3) throw new Error('AUDIO_ALIGNMENT_EXCESS_TRAILING_AUDIO');
  return words;
}

const sentenceEnd = /[.?!;]["'”’)\]]*$/u;
const phraseEnd = /[,:]["'”’)\]]*$/u;
const conjunctions = { English: /^(?:and|or|but|while)$/iu, Italian: /^(?:e|ed|o|oppure|ma|mentre)$/iu };
const weakEndings = { English: /^(?:a|an|the|and|or|but|as|at|by|for|from|in|into|of|on|per|to|with|without|worth|that|which|is|are|was|were|be|been|can|could|will|would|should|not|its|our|their)$/iu, Italian: /^(?:il|lo|la|i|gli|le|un|uno|una|e|ed|o|ma|a|al|alla|alle|ai|agli|da|dal|dalla|di|del|della|dei|delle|in|nel|nella|nei|nelle|su|sul|sulla|per|con|senza|che|non|è|sono|può)$/iu };
const number = /^[+-]?\d+(?:[,.]\d+)*%?$/u;
export const CAPTION_MAX_WORDS = 9;
export const CAPTION_MAX_CHARACTERS = 56;
export const CAPTION_SILENCE_SECONDS = 0.35;

/** Group canonical slices at supported phrase boundaries, without retiming words. */
export function captionCues(text: string, words: readonly NarrationWord[], language: AudioLanguage = 'English'): NarrationCaption[] {
  const conjunction = conjunctions[language], weakEnding = weakEndings[language];
  // A measured pause is a hard cue boundary, including inside a sentence. An
  // unresolved word is not evidence of silence and still needs an enclosing span.
  const spans: (readonly NarrationWord[])[] = [];
  let spanStart = 0;
  for (let index = 1; index < words.length; index++) {
    const prior = words[index - 1], next = words[index];
    if (prior.timingResolved && next.timingResolved && next.startSeconds - prior.endSeconds >= CAPTION_SILENCE_SECONDS - 1e-9) {
      spans.push(words.slice(spanStart, index)); spanStart = index;
    }
  }
  if (spans.length) {
    spans.push(words.slice(spanStart));
    return spans.flatMap(span => captionCues(text, span, language));
  }
  const cues: NarrationCaption[] = [];
  const supported = (start: number, end: number) => words[end - 1].endSeconds > words[start].startSeconds
    && words.slice(start, end).some(word => word.timingResolved);
  const fits = (start: number, end: number) => end - start <= CAPTION_MAX_WORDS
    && words[end - 1].charEnd - words[start].charStart <= CAPTION_MAX_CHARACTERS
    && words[end - 1].endSeconds - words[start].startSeconds <= 6;

  const sentences: { start: number; end: number }[] = [];
  for (let start = 0, end = 1; end <= words.length; end++) {
    if (end === words.length || sentenceEnd.test(words[end - 1].text)) {
      sentences.push({ start, end }); start = end;
    }
  }
  // A wholly unresolved sentence cannot be its own cue. Enclose it with a
  // neighbour's real span; all ordinary sentence boundaries remain intact.
  for (let index = 0; index < sentences.length; index++) {
    const sentence = sentences[index];
    if (supported(sentence.start, sentence.end)) continue;
    if (index + 1 < sentences.length) sentences[index + 1].start = sentence.start;
    else if (index > 0) sentences[index - 1].end = sentence.end;
    else throw new Error('AUDIO_CAPTION_WITHOUT_SUPPORTED_SPAN');
    sentences.splice(index, 1); index--;
  }

  for (const sentence of sentences) {
    type Partition = { ends: number[]; shortCues: number };
    const memo = new Map<number, Partition | null>();
    const partition = (start: number): Partition | null => {
      if (start === sentence.end) return { ends: [], shortCues: 0 };
      if (memo.has(start)) return memo.get(start)!;
      if (fits(start, sentence.end) && supported(start, sentence.end)) {
        const whole = { ends: [sentence.end], shortCues: Number(sentence.end - start < 3) };
        memo.set(start, whole); return whole;
      }
      let best: (Partition & { rank: number; firstEnd: number }) | null = null;
      for (let end = start + 1; end < sentence.end && end <= start + CAPTION_MAX_WORDS; end++) {
        // Unsupported leading words do not stop the search for an enclosing span.
        if (!fits(start, end) || !supported(start, end)) continue;
        const rest = partition(end);
        if (!rest) continue;
        const previous = words[end - 1].text, next = words[end].text;
        const numericUnit = number.test(previous) && /^\p{L}/u.test(next);
        const rank = numericUnit ? -1 : phraseEnd.test(previous) ? 3 : conjunction.test(next) ? 2 : weakEnding.test(previous) ? 0 : 1;
        const shortCues = Number(end - start < 3) + rest.shortCues;
        // First avoid avoidable orphan fragments, then choose a phrase boundary;
        // prefer the latest equally good boundary instead of adding tiny cues.
        if (!best || shortCues < best.shortCues || (shortCues === best.shortCues
          && (rank > best.rank || (rank === best.rank && end > best.firstEnd)))) {
          best = { ends: [end, ...rest.ends], shortCues, rank, firstEnd: end };
        }
      }
      memo.set(start, best); return best;
    };
    const result = partition(sentence.start);
    if (!result) throw new Error('AUDIO_CAPTION_LIMIT_UNSUPPORTED');
    let start = sentence.start;
    for (const end of result.ends) {
      const first = words[start], last = words[end - 1];
      cues.push({ text: text.slice(first.charStart, last.charEnd), startSeconds: first.startSeconds, endSeconds: last.endSeconds });
      start = end;
    }
  }
  return cues;
}

export function vttTime(seconds: number): string {
  const raw = seconds * 1000;
  if (!Number.isFinite(seconds) || seconds < 0 || raw > Number.MAX_SAFE_INTEGER) throw new Error('AUDIO_INVALID_VTT_TIME');
  // Match Python round's ties-to-even at half milliseconds.
  const lower = Math.floor(raw);
  const milliseconds = raw - lower === 0.5 ? lower + (lower % 2) : Math.round(raw);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const wholeSeconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}
