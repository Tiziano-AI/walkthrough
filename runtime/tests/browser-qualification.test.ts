import assert from 'node:assert/strict';
import test from 'node:test';
import {browserQualification, qualifiedBrowserVersion, verifyBrowserMetadata} from '../src/core/browser-qualification.ts';

test('browser admission checks the exact reviewed version, never a version substring', () => {
  assert.equal(qualifiedBrowserVersion(`Google Chrome for Testing ${browserQualification.version}\n`),true);
  for(const value of ['156.0.8078.4','156.0.8078.470','156.0.8078.48'])assert.equal(qualifiedBrowserVersion(`Google Chrome for Testing ${value}`),false);
  assert.equal(qualifiedBrowserVersion(`Google Chrome ${browserQualification.version}`),false);
});
test('explicit acquisition refuses unavailable or changed official metadata', async () => {
  await assert.rejects(verifyBrowserMetadata(async () => new Response('missing',{status:404})),/BROWSER_METADATA_UNAVAILABLE/);
  await assert.rejects(verifyBrowserMetadata(async (url,options) => {
    assert.equal(url,browserQualification.metadata);assert.equal(options?.redirect,'error');
    return new Response(JSON.stringify({version:browserQualification.version,downloads:{chrome:[]}}));
  }),/BROWSER_METADATA_CHANGED/);
});
