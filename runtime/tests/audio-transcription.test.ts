import assert from 'node:assert/strict';
import test from 'node:test';
import { compareTranscript, lexicalTokens } from '../src/audio/transcription.ts';

test('lexical comparison normalizes typography, case and whitespace but preserves canonical text', () => {
  const canonical = 'L’azione è pronta: SALVA il progetto.';
  const result = compareTranscript(canonical, "L'azione è pronta, salva   il progetto!");
  assert.equal(result.status, 'match'); assert.deepEqual(result.differences, []);
  assert.deepEqual(result.expectedTokens, ["l'azione", 'è', 'pronta', 'salva', 'il', 'progetto']);
  assert.equal(compareTranscript('Open the full-width Ａ panel.', 'open the full width A panel').status, 'match');
});

test('lexical differences retain missing, extra and replaced words rather than rewriting speech', () => {
  for (const [expected, observed, operation] of [
    ['Save the new project.', 'Save the project.', 'delete'],
    ['Save the project.', 'Save the new project.', 'insert'],
    ['Save the project.', 'Share the project.', 'replace'],
  ] as const) {
    const result = compareTranscript(expected, observed);
    assert.equal(result.status, 'mismatch'); assert.equal(result.differences[0].operation, operation);
  }
  for (const [expected, observed] of [['è pronto', 'e pronto'], ["don't save", 'dont save'], ['version 15', 'version fifteen'], ['OpenAI', 'Open AI']]) {
    assert.equal(compareTranscript(expected, observed).status, 'mismatch');
  }
  assert.equal(compareTranscript('Save this project.', '').differences.length, 3);
  assert.deepEqual(lexicalTokens('Crème — già!'), ['crème', 'già']);
});
