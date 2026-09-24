import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildWorkflow, siteDomain, type BuildOptions } from '../src/builder/builder.js';
import type { RecordedExchange, Recording } from '../src/types.js';

let seq = 0;
function ex(method: string, url: string, opts: { body?: string; headers?: Record<string, string>; status?: number; resBody?: string; resHeaders?: Record<string, string>; type?: string; at?: number } = {}): RecordedExchange {
  seq++;
  return {
    id: seq,
    startedAt: opts.at ?? seq * 100,
    durationMs: 20,
    pageUrl: 'https://shop.test/',
    resourceType: opts.type ?? 'fetch',
    request: { method, url, headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) }, postData: opts.body },
    response: { status: opts.status ?? 200, headers: { 'content-type': 'application/json', ...(opts.resHeaders ?? {}) }, body: opts.resBody, mimeType: 'application/json' },
  };
}

const OPTS: BuildOptions = { includeDocuments: true, exclude: [], userFields: {}, minThinkMs: 500, maxThinkMs: 10_000, correlate: true };

function recording(): Recording {
  seq = 0;
  return {
    version: 1,
    startUrl: 'https://shop.test/',
    recordedAt: '',
    navigations: [],
    exchanges: [
      ex('GET', 'https://shop.test/app.js', { type: 'script' }),
      ex('GET', 'https://tracker.other/collect', {}),
      ex('POST', 'https://shop.test/api/login', {
        body: '{"username":"alice@x.io","password":"s3cret!"}',
        resBody: '{"token":"eyJhbGciOiJIUzI1NiJ9.abc123","user":{"id":42}}',
      }),
      ex('GET', 'https://shop.test/api/products', {
        headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc123' },
        resBody: '{"products":[{"id":101,"name":"A"},{"id":102,"name":"B"}]}',
        at: 2000,
      }),
      ex('POST', 'https://shop.test/api/cart', {
        headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc123' },
        body: '{"productId":102,"quantity":1}',
        resBody: '{"cartId":"cart_9f8e7d6c5b"}',
        at: 2600,
      }),
      ex('POST', 'https://shop.test/api/cart/cart_9f8e7d6c5b/checkout', {
        headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc123' },
        body: '{}',
        at: 2700,
      }),
    ],
  };
}

describe('buildWorkflow', () => {
  it('filters static assets and foreign domains', () => {
    const { report } = buildWorkflow(recording(), OPTS);
    assert.equal(report.kept, 4);
    assert.equal(report.dropped, 2);
  });

  it('parameterizes user fields and splits login into setup', () => {
    const { workflow } = buildWorkflow(recording(), { ...OPTS, userFields: { email: 'alice@x.io', password: 's3cret!' } });
    assert.equal(workflow.setup.length, 1);
    assert.equal(workflow.setup[0].request.body, '{"username":"${user.email|json}","password":"${user.password|json}"}');
    assert.equal(workflow.steps.length, 3);
    assert.equal(workflow.variables.baseUrl, 'https://shop.test');
    assert.ok(workflow.setup[0].request.url.startsWith('${baseUrl}'));
  });

  it('correlates tokens, numeric ids (JSON body) and string ids (URL path)', () => {
    const { workflow, report } = buildWorkflow(recording(), { ...OPTS, userFields: { email: 'alice@x.io', password: 's3cret!' } });
    const [products, cart, checkout] = workflow.steps;
    assert.deepEqual(workflow.setup[0].extract, [{ var: 'token', from: 'body', path: '$.token' }]);
    assert.equal(products.request.headers?.authorization, 'Bearer ${token}');
    assert.deepEqual(products.extract, [{ var: 'productId', from: 'body', path: '$.products[1].id' }]);
    assert.equal(cart.request.body, '{"productId":${productId},"quantity":1}');
    assert.equal(checkout.request.url, '${baseUrl}/api/cart/${cartId}/checkout');
    assert.deepEqual(report.correlations.map((c) => c.variable).sort(), ['cartId', 'productId', 'token']);
  });

  it('records think time from pauses and caps it', () => {
    // no user fields -> no setup section: steps are [login, products, cart, checkout]
    const { workflow } = buildWorkflow(recording(), { ...OPTS, maxThinkMs: 1000 });
    assert.equal(workflow.steps[0].thinkTimeMs, undefined); // first step never waits
    assert.equal(workflow.steps[1].thinkTimeMs, 1000); // 1.7s pause capped at 1s
    assert.equal(workflow.steps[2].thinkTimeMs, 600); // 580ms rounded to 100ms
    assert.equal(workflow.steps[3].thinkTimeMs, undefined); // 80ms gap is below minThinkMs
  });

  it('can disable correlation', () => {
    const { workflow, report } = buildWorkflow(recording(), { ...OPTS, correlate: false });
    assert.equal(report.correlations.length, 0);
    assert.ok(JSON.stringify(workflow).includes('cart_9f8e7d6c5b'));
  });

  it('keeps API subdomains, gives each host a variable and drops tracking beacons', () => {
    seq = 0;
    const rec: Recording = {
      version: 1,
      startUrl: 'https://www.shop.test/',
      recordedAt: '',
      navigations: [],
      exchanges: [
        ex('GET', 'https://www.shop.test/', { type: 'document' }),
        ex('POST', 'https://api.shop.test/v1/login', { body: '{"u":"a"}', resBody: '{"accessToken":"tok_1234567890abcdef"}', headers: { origin: 'https://www.shop.test' } }),
        ex('GET', 'https://api.shop.test/v1/me', { headers: { authorization: 'Bearer tok_1234567890abcdef' } }),
        ex('POST', 'https://www.shop.test/cdn-cgi/rum?', {}),
        ex('POST', 'https://www.google-analytics.com/g/collect?v=2', {}),
        ex('POST', 'https://o123.ingest.sentry.io/api/1/envelope/', {}),
      ],
    };
    const { workflow, report } = buildWorkflow(rec, OPTS);
    assert.equal(report.kept, 3);
    assert.deepEqual(workflow.variables, { baseUrl: 'https://www.shop.test', apiUrl: 'https://api.shop.test' });
    assert.equal(workflow.steps[1].request.url, '${apiUrl}/v1/login');
    assert.equal(workflow.steps[1].request.headers?.origin, '${baseUrl}');
    assert.equal(workflow.steps[2].request.headers?.authorization, 'Bearer ${accessToken}');
    assert.equal(buildWorkflow(rec, { ...OPTS, keepTracking: true }).report.kept, 4); // rum beacon kept; other domains still filtered
  });

  it('derives the site domain', () => {
    assert.equal(siteDomain('app.shop.example.com'), 'example.com');
    assert.equal(siteDomain('www.example.co.uk'), 'example.co.uk');
    assert.equal(siteDomain('localhost'), 'localhost');
    assert.equal(siteDomain('10.0.0.5'), '10.0.0.5');
  });

  it('adds a shared login cache when requested', () => {
    const { workflow } = buildWorkflow(recording(), { ...OPTS, userFields: { email: 'alice@x.io' }, cacheLoginTtlSec: 300 });
    assert.deepEqual(workflow.setup[0].cache, { key: 'auth:${user.email}', ttlSec: 300, vars: ['token'] });
  });
});
