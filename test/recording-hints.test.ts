import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { chromium } from 'playwright';
import { createMemoryBackend } from '../src/backend/memory.js';
import { buildApp } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import { EventHub } from '../src/server/events.js';
import { recordingHint } from '../src/server/services/recordings.js';

describe('what to do when a recording fails', () => {
  it('names the real problem instead of always saying "install Chrome"', () => {
    const startTimeout = "browserType.launchPersistentContext: Timeout 30000ms exceeded.\nCall log:\n  - <launching> chrome.exe";
    assert.match(recordingHint(startTimeout), /did not start in time.*antivirus/);
    assert.doesNotMatch(recordingHint(startTimeout), /Install it/);

    const missing = "browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    assert.match(recordingHint(missing), /Google Chrome was not found.*LT_RECORDER_BROWSER=chromium/);
    assert.match(recordingHint(missing, 'msedge'), /Microsoft Edge was not found/);
    assert.match(recordingHint("Executable doesn't exist at C:\\x\\chrome.exe", 'chromium'), /npx playwright install chromium/);

    assert.match(recordingHint('Target page, context or browser has been closed'), /window was closed/);
    assert.match(recordingHint('EPERM: operation not permitted, mkdir C:\\Temp\\lt-record-abc'), /temporary folder/);
    assert.match(recordingHint('Missing X server or $DISPLAY'), /no display.*LT_RECORDER_HEADLESS=true/);
    assert.equal(recordingHint('page.evaluate: something else entirely'), '');
  });

  it('recognises the message Playwright really gives for a browser that is not installed', async () => {
    let message = '';
    try {
      // "chrome-canary" is not installed on CI machines and is unusual on developer PCs
      await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'lt-hint-')), { channel: 'chrome-canary', headless: true, timeout: 20_000 });
    } catch (e) {
      message = (e as Error).message;
    }
    if (!message) return; // it is installed here: nothing to check
    assert.match(message, /is not found|Executable doesn't exist/);
    assert.notEqual(recordingHint(message), '', message);
  });
});

describe('API clients that send an empty JSON body', () => {
  it('are accepted (e.g. curl -X POST -H "content-type: application/json" .../recording/stop)', async () => {
    const store = new Store(':memory:');
    const { app } = await buildApp({ store, backend: createMemoryBackend(), hub: new EventHub(), recorderHeadless: true, recorderEnabled: false, redisRunTtlSec: 60, maxUploadMb: 1, logLevel: 'silent' });
    try {
      // used to be 400 "Body cannot be empty when content-type is set to 'application/json'"
      const empty = await app.inject({ method: 'POST', url: '/api/tests/nope/recording/stop', headers: { 'content-type': 'application/json' }, payload: '' });
      assert.equal(empty.statusCode, 404, empty.body);
      const bad = await app.inject({ method: 'POST', url: '/api/tests', headers: { 'content-type': 'application/json' }, payload: '{nope' });
      assert.equal(bad.statusCode, 400);
      assert.match(bad.json().error, /not valid JSON/);
      const ok = await app.inject({ method: 'POST', url: '/api/tests', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'x', startUrl: 'http://a.test/' }) });
      assert.equal(ok.statusCode, 201);
    } finally {
      await app.close();
      store.close();
    }
  });
});
