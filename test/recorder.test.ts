import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import { RecordingSession } from '../src/recorder/recorder.js';

const hasBrowser = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe('RecordingSession', { skip: hasBrowser ? false : 'Chromium not installed (npx playwright install chromium)' }, () => {
  let server: Server;
  let base: string;

  before(async () => {
    // A page that registers a service worker which itself makes requests: requests
    // without an associated frame used to crash the recorder (and the server).
    server = createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><script>
          navigator.serviceWorker?.register('/sw.js').catch(() => {});
          fetch('/api/data').then((r) => r.json()).then((d) => fetch('/api/items/' + d.id));
        </script>`);
      } else if (req.url === '/sw.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' }).end(`
          self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(fetch('/sw-precache')); });
          self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
          self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"abc123def456"}');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('records a site that uses a service worker without crashing', async () => {
    const session = RecordingSession.start({ url: `${base}/`, headless: true, timeoutSec: 30 });
    setTimeout(() => session.stop(), 3000);
    const rec = await session.done;
    const paths = rec.exchanges.map((e) => new URL(e.request.url).pathname);
    assert.ok(paths.includes('/'), `recorded: ${paths.join(', ')}`);
    assert.ok(paths.includes('/api/data'));
    assert.ok(paths.includes('/api/items/abc123def456'));
    const api = rec.exchanges.find((e) => e.request.url.endsWith('/api/data'))!;
    assert.equal(api.pageUrl, `${base}/`); // attributed to the page, not to a worker
  });
});
