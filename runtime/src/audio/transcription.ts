/** ASR is an independent observation, never a rewrite of the approved narration. */
export interface LexicalDifference { operation: 'insert' | 'delete' | 'replace'; expectedIndex: number; observedIndex: number; expected: string | null; observed: string | null }
export interface LexicalComparison {
  status: 'match' | 'mismatch';
  normalization: 'unicode-typography-whitespace-case-v1';
  expectedTokens: string[];
  observedTokens: string[];
  differences: LexicalDifference[];
}

/** Preserve accents, numbers, contractions and word order. Typography alone
 * (quote styles, punctuation, Unicode presentation, case and space) may differ. */
export function lexicalTokens(text: string): string[] {
  return text.normalize('NFKC').replace(/[‘’ʼ]/gu, "'").toLocaleLowerCase('en')
    .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
}

export function compareTranscript(expected: string, transcript: string): LexicalComparison {
  if (typeof transcript !== 'string' || transcript.length > 10_000) throw new Error('AUDIO_TRANSCRIPTION_INVALID');
  const a = lexicalTokens(expected), b = lexicalTokens(transcript);
  if (a.length > 500 || b.length > 1000) throw new Error('AUDIO_TRANSCRIPTION_INVALID');
  const rows = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
  }
  const differences: LexicalDifference[] = [];
  let i = a.length, j = b.length;
  while (i || j) {
    if (i && j && a[i - 1] === b[j - 1]) { i--; j--; }
    else if (i && j && rows[i][j] === rows[i - 1][j - 1] + 1) {
      differences.push({ operation: 'replace', expectedIndex: --i, observedIndex: --j, expected: a[i], observed: b[j] });
    } else if (i && rows[i][j] === rows[i - 1][j] + 1) {
      differences.push({ operation: 'delete', expectedIndex: --i, observedIndex: j, expected: a[i], observed: null });
    } else {
      differences.push({ operation: 'insert', expectedIndex: i, observedIndex: --j, expected: null, observed: b[j] });
    }
  }
  return { status: differences.length ? 'mismatch' : 'match', normalization: 'unicode-typography-whitespace-case-v1', expectedTokens: a, observedTokens: b, differences: differences.reverse() };
}
