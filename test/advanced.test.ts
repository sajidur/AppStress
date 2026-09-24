import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { buildWorkflow, effectiveResourceTypes, type BuildOptions } from '../src/builder/builder.js';
import { applyAuth } from '../src/engine/auth.js';
import { VirtualUser, type StepTrace } from '../src/engine/executor.js';
import { MetricsCollector } from '../src/metrics/collector.js';
import { workflowSchema } from '../src/server/schemas.js';
import { sampleExchange } from '../src/server/services/helpers.js';
import type { RecordedExchange, Recording, Workflow } from '../src/types.js';

let seq = 0;
function ex(method: string, url: string, type: string, resBody?: string, mime = 'application/json'): RecordedExchange {
  seq++;
  return {
    id: seq,
    startedAt: seq * 100,
    durationMs: 10,
    pageUrl: 'https://shop.test/',
    resourceType: type,
    request: { method, url, headers: {} },
    response: { status: 200, headers: { 'content-type': mime }, body: resBody, mimeType: mime },
  };
}

const BASE: BuildOptions = { exclude: [], userFields: {}, minThinkMs: 500, maxThinkMs: 10_000, correlate: false };

function recording(): Recording {
  seq = 0;
  return {
    version: 1,
    startUrl: 'https://shop.test/',
    recordedAt: '',
    navigations: [],
    exchanges: [
      ex('GET', 'https://shop.test/', 'document', '<html></html>', 'text/html'),
      ex('GET', 'https://shop.test/static/app.js', 'script', undefined, 'application/javascript'),
      ex('GET', 'https://shop.test/static/site.css', 'stylesheet', undefined, 'text/css'),
      ex('GET', 'https://shop.test/api/items', 'xhr', '{"items":[]}'),
      ex('POST', 'https://shop.test/api/orders', 'fetch', '{}'),
      ex('GET', 'https://shop.test/img/logo.png', 'image', undefined, 'image/png'),
    ],
  };
}

const namesOf = (wf: Workflow) => [...wf.setup, ...wf.steps].map((s) => s.name);

describe('request type filter', () => {
  it('keeps document + xhr/fetch by default and drops scripts, css and images', () => {
    const { workflow } = buildWorkflow(recording(), BASE);
    assert.deepEqual(namesOf(workflow), ['GET /', 'GET /api/items', 'POST /api/orders']);
  });

  it('keeps only the selected types; xhr selects fetch too', () => {
    const { workflow } = buildWorkflow(recording(), { ...BASE, resourceTypes: ['xhr'] });
    assert.deepEqual(namesOf(workflow), ['GET /api/items', 'POST /api/orders']);
  });

  it('includes JavaScript files when the script type is selected', () => {
    const { workflow } = buildWorkflow(recording(), { ...BASE, resourceTypes: ['document', 'xhr', 'script'] });
    assert.deepEqual(namesOf(workflow), ['GET /', 'GET /static/app.js', 'GET /api/items', 'POST /api/orders']);
    assert.equal(workflow.steps.find((s) => s.name === 'GET /static/app.js')?.resourceType, 'script');
  });

  it('records the source exchange on every step', () => {
    const { workflow } = buildWorkflow(recording(), BASE);
    assert.deepEqual([...workflow.setup, ...workflow.steps].map((s) => s.sourceId), [1, 4, 5]);
  });

  it('falls back to the legacy includeDocuments switch', () => {
    assert.deepEqual([...effectiveResourceTypes({ includeDocuments: false })].sort(), ['fetch', 'xhr']);
    assert.deepEqual([...effectiveResourceTypes({ includeDocuments: true })].sort(), ['document', 'fetch', 'xhr']);
  });
});

describe('workflow authentication', () => {
  it('adds a bearer token, and only when the variable is available', () => {
    const auth = { type: 'bearer' as const, token: '${token}' };
    const headers: Record<string, string> = {};
    assert.equal(applyAuth(auth, {}, headers, 'http://a.test/x').status, 'skipped');
    assert.deepEqual(headers, {});
    assert.equal(applyAuth(auth, { token: 'abc' }, headers, 'http://a.test/x').status, 'applied');
    assert.equal(headers.authorization, 'Bearer abc');
  });

  it('does not double the Bearer prefix and respects a step-level Authorization header', () => {
    const h1: Record<string, string> = {};
    applyAuth({ type: 'bearer', token: '${t}' }, { t: 'Bearer xyz' }, h1, 'http://a.test/');
    assert.equal(h1.authorization, 'Bearer xyz');
    const h2: Record<string, string> = { Authorization: 'Custom 1' };
    assert.equal(applyAuth({ type: 'bearer', token: 'zzz' }, {}, h2, 'http://a.test/').status, 'own');
    assert.equal(h2.Authorization, 'Custom 1');
    assert.equal(h2.authorization, undefined);
  });

  it('supports basic, API-key header and API-key query parameter', () => {
    const basic: Record<string, string> = {};
    applyAuth({ type: 'basic', username: '${user.name}', password: 'pw' }, { 'user.name': 'al' }, basic, 'http://a.test/');
    assert.equal(basic.authorization, `Basic ${Buffer.from('al:pw').toString('base64')}`);

    const key: Record<string, string> = {};
    applyAuth({ type: 'header', name: 'X-API-Key', value: 'k1' }, {}, key, 'http://a.test/');
    assert.equal(key['x-api-key'], 'k1');

    const q = applyAuth({ type: 'query', name: 'api_key', value: '${k}' }, { k: 'a b' }, {}, 'http://a.test/x?y=1');
    assert.equal(q.url, 'http://a.test/x?y=1&api_key=a+b');
  });

  it('is validated by the workflow schema', () => {
    const wf = { name: 'x', variables: {}, setup: [], steps: [] };
    assert.equal(workflowSchema.safeParse({ ...wf, auth: { type: 'bearer', token: '${token}' } }).success, true);
    assert.equal(workflowSchema.safeParse({ ...wf, auth: { type: 'bearer' } }).success, false);
    assert.equal(workflowSchema.safeParse({ ...wf, auth: { type: 'header', name: 'X-Key' } }).success, false);
  });
});

describe('data flowing between steps (end to end)', () => {
  it('logs in, then sends the token and values from earlier responses in later requests', async () => {
    const seen: { url: string; auth?: string; body: string }[] = [];
    const server = createServer(async (req: IncomingMessage, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/login') res.end('{"access_token":"tok-123","user":{"id":42}}');
      else if (req.url === '/items') res.end('{"items":[{"id":"a1"},{"id":"b2"}]}');
      else res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const wf: Workflow = {
      name: 't',
      variables: { baseUrl: base },
      auth: { type: 'bearer', token: '${accessToken}' },
      setup: [
        {
          name: 'login',
          skipAuth: true,
          request: { method: 'POST', url: '${baseUrl}/login', body: '{"u":"${user.name}"}' },
          extract: [
            { var: 'accessToken', from: 'body', path: '$.access_token' },
            { var: 'userId', from: 'body', path: '$.user.id' },
          ],
        },
      ],
      steps: [
        { name: 'list', request: { method: 'GET', url: '${baseUrl}/items' }, extract: [{ var: 'itemId', from: 'body', path: '$.items[1].id' }] },
        { name: 'order', request: { method: 'POST', url: '${baseUrl}/orders?item=${itemId}', body: '{"item":"${itemId}","owner":${userId}}' } },
      ],
    };

    const traces: StepTrace[] = [];
    const vu = new VirtualUser({
      workflow: wf,
      user: { name: 'al' },
      vuIndex: 0,
      metrics: new MetricsCollector(),
      requestTimeoutMs: 5000,
      thinkTimeScale: 0,
      shouldStop: () => false,
      onTrace: (t) => traces.push(t),
    });
    try {
      assert.equal(await vu.runSetup(), true);
      assert.equal(await vu.runIteration(0), true);
    } finally {
      server.close();
    }

    assert.equal(seen[0].auth, undefined, 'login is sent without authentication');
    assert.equal(seen[1].auth, 'Bearer tok-123');
    assert.equal(seen[2].auth, 'Bearer tok-123');
    assert.equal(seen[2].url, '/orders?item=b2');
    assert.equal(seen[2].body, '{"item":"b2","owner":42}');
    assert.deepEqual(traces.map((t) => t.auth), [undefined, 'applied', 'applied']);
  });
});

describe('recorded response samples', () => {
  it('lists JSON paths, headers, cookies and hidden fields to bind from', () => {
    const json = ex('GET', 'https://shop.test/api/me', 'xhr', '{"user":{"id":7,"tags":["a"]},"token":"t-1"}');
    json.response!.headers['x-request-id'] = 'req-9';
    json.response!.headers['set-cookie'] = 'sid=s1; Path=/\nlang=en; Path=/';
    const s = sampleExchange(json);
    assert.deepEqual(s.jsonPaths.map((p) => p.path), ['$.user.id', '$.user.tags[0]', '$.token']);
    assert.ok(s.headers.some((h) => h.name === 'x-request-id' && h.value === 'req-9'));
    assert.deepEqual(s.cookies.map((c) => c.name), ['sid', 'lang']);

    const html = ex('GET', 'https://shop.test/login', 'document', '<form><input type="hidden" name="csrf" value="abc123"></form>', 'text/html');
    const h = sampleExchange(html);
    assert.equal(h.htmlFields[0].name, 'csrf');
    assert.equal(new RegExp(h.htmlFields[0].regex).exec(html.response!.body!)?.[1], 'abc123');
  });
});
