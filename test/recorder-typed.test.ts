import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import { buildWorkflow } from '../src/builder/builder.js';
import { RecordingSession } from '../src/recorder/recorder.js';
import { addTyped } from '../src/recorder/typed-inputs.js';
import type { TypedInput } from '../src/types.js';

const hasBrowser = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe('typed inputs', () => {
  it('keeps the latest value per field and skips repeats', () => {
    const list: TypedInput[] = [];
    const t = { field: 'q', label: 'Search', type: 'text', page: 'p' };
    addTyped(list, { ...t, value: 'a' });
    addTyped(list, { ...t, value: 'a' });
    addTyped(list, { ...t, value: 'ab' });
    addTyped(list, { ...t, field: 'x', value: '' });
    assert.deepEqual(list.map((x) => [x.field, x.value]), [['q', 'ab']]);
  });
});

describe('recording what is typed into the page', { skip: hasBrowser ? false : 'Chromium not installed' }, () => {
  let server: Server;
  let base: string;
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><body>
          <label for="uid">Employee ID</label><input id="uid" name="UserId">
          <label for="pw">Password</label><input id="pw" name="Password" type="password">
          <input name="hidden" type="hidden" value="zzz">
          <button id="go" type="button">Log in</button>
          <script>
            document.getElementById('go').onclick = () => fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ user: document.getElementById('uid').value, secret: btoa(document.getElementById('pw').value) }) });
          </script></body>`);
      } else res.writeHead(200, { 'content-type': 'application/json' }).end('{"token":"tok-0123456789abcdef"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('captures which field each value was typed into, and notices the value the page transforms', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lt-typed-'));
    const script = join(dir, 'flow.mjs');
    writeFileSync(script, `export default async (page) => {
      page.setDefaultTimeout(90000); // a busy machine can start Chrome slowly
      await page.fill('#uid', 'alice01');
      await page.fill('#pw', 'hunter2!');
      const done = page.waitForResponse((r) => r.url().endsWith('/api/login'));
      await page.click('#go');
      await done;
    };`);
    const rec = await RecordingSession.start({ url: `${base}/`, headless: true, script, timeoutSec: 150 }).done;

    assert.deepEqual(
      rec.typedInputs!.map((t) => [t.field, t.label, t.type, t.value]),
      [['UserId', 'Employee ID', 'text', 'alice01'], ['Password', 'Password', 'password', 'hunter2!']],
    );

    const { report, workflow } = buildWorkflow(rec, { exclude: [], userFields: { name: 'alice01', pw: 'hunter2!' }, minThinkMs: 500, maxThinkMs: 10_000, correlate: true });
    const byField = Object.fromEntries(report.typed!.map((t) => [t.field, t]));
    assert.deepEqual(byField.UserId.sentIn, ['POST /api/login']);
    assert.equal(byField.UserId.column, 'name');
    assert.deepEqual(byField.UserId.encoding, undefined, 'sent as typed');
    assert.deepEqual(byField.Password.sentIn, ['POST /api/login'], 'the page sends it Base64 encoded, and that is recognised');
    assert.deepEqual(byField.Password.encoding, ['base64']);
    assert.equal(byField.Password.value, '••••••', 'passwords are not stored in the report');
    assert.ok(!report.flow!.issues.some((i) => i.kind === 'encrypted'));
    assert.ok(report.flow!.issues.some((i) => i.kind === 'encoded' && /Password.*base64/.test(i.message)));
    const login = [...workflow.setup, ...workflow.steps].find((s) => s.name.includes('/api/login'))!;
    assert.ok(login.request.body!.includes('"secret":"${user.pw|base64}"'), `each user gets their own encoded password: ${login.request.body}`);
    assert.deepEqual(report.encoded, [{ step: 'POST /api/login', field: 'pw', filters: 'base64' }]);
  });
});
