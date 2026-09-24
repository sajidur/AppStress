import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CookieJar } from '../src/engine/cookies.js';
import { parseSetCookies, runExtractor, type ResponseView } from '../src/engine/extract.js';
import { formatPath, getPath, tokenizePath } from '../src/engine/jsonpath.js';
import { render, TemplateError } from '../src/engine/template.js';
import { bucketOf, bucketValue, percentiles } from '../src/metrics/histogram.js';
import { parseCsv } from '../src/util.js';

describe('template', () => {
  it('renders variables, user fields and filters', () => {
    const vars = { baseUrl: 'http://x', 'user.name': 'a b', q: 'say "hi"' };
    assert.equal(render('${baseUrl}/u/${user.name|urlencode}', vars), 'http://x/u/a%20b');
    assert.equal(render('{"q":"${q|json}"}', vars), '{"q":"say \\"hi\\""}');
  });
  it('supports built-ins', () => {
    assert.match(render('${$uuid}', {}), /^[0-9a-f-]{36}$/);
    const n = Number(render('${$randomInt(5,7)}', {}));
    assert.ok(n >= 5 && n <= 7);
  });
  it('throws on unresolved variables', () => {
    assert.throws(() => render('${missing}', {}), TemplateError);
  });
});

describe('jsonpath', () => {
  it('round-trips paths and reads values', () => {
    const tokens = tokenizePath('$.a["b-c"][2].d');
    assert.deepEqual(tokens, ['a', 'b-c', 2, 'd']);
    assert.equal(formatPath(tokens), '$.a["b-c"][2].d');
    assert.equal(getPath({ a: { 'b-c': [0, 0, { d: 'ok' }] } }, '$.a["b-c"][2].d'), 'ok');
  });
  it('rejects malformed paths', () => {
    assert.throws(() => tokenizePath('$.a[x]'));
  });
});

describe('cookie jar', () => {
  it('scopes cookies by domain, path and expiry', () => {
    const jar = new CookieJar();
    jar.store('https://app.example.com/login', ['sid=1; Path=/; HttpOnly', 'pref=2; Domain=example.com; Path=/', 'old=3; Max-Age=0']);
    assert.equal(jar.header('https://app.example.com/api'), 'sid=1; pref=2');
    assert.equal(jar.header('https://other.example.com/'), 'pref=2');
    assert.equal(jar.header('https://evil.com/'), undefined);
  });
  it('does not send secure cookies over http', () => {
    const jar = new CookieJar();
    jar.store('https://a.test/', ['s=1; Secure; Path=/']);
    assert.equal(jar.header('http://a.test/'), undefined);
  });
});

describe('extractors', () => {
  const res: ResponseView = {
    status: 201,
    headers: new Headers({ 'x-csrf-token': 'abc' }),
    body: '{"data":{"items":[{"id":7}]}} <input name="t" value="zz">',
    setCookies: parseSetCookies(['sid=s1; Path=/']),
  };
  it('reads body, header, cookie, status and regex', () => {
    const jsonRes = { ...res, body: '{"data":{"items":[{"id":7}]}}' };
    assert.equal(runExtractor({ var: 'v', from: 'body', path: '$.data.items[0].id' }, jsonRes), '7');
    assert.equal(runExtractor({ var: 'v', from: 'header', name: 'x-csrf-token' }, res), 'abc');
    assert.equal(runExtractor({ var: 'v', from: 'cookie', name: 'sid' }, res), 's1');
    assert.equal(runExtractor({ var: 'v', from: 'status' }, res), '201');
    assert.equal(runExtractor({ var: 'v', from: 'regex', regex: 'value="([^"]+)"' }, res), 'zz');
  });
});

describe('histogram', () => {
  it('keeps percentile error within a few percent', () => {
    const buckets = new Map<number, number>();
    for (let ms = 1; ms <= 1000; ms++) buckets.set(bucketOf(ms), (buckets.get(bucketOf(ms)) ?? 0) + 1);
    const [p50, p95, p99] = percentiles(buckets, [50, 95, 99]);
    assert.ok(Math.abs(p50 - 500) / 500 < 0.05, `p50=${p50}`);
    assert.ok(Math.abs(p95 - 950) / 950 < 0.05, `p95=${p95}`);
    assert.ok(Math.abs(p99 - 990) / 990 < 0.05, `p99=${p99}`);
    assert.ok(bucketValue(bucketOf(123)) > 115 && bucketValue(bucketOf(123)) < 130);
  });
});

describe('csv', () => {
  it('handles quotes, commas, CRLF and BOM', () => {
    const rows = parseCsv('﻿user,pass\r\n"a,b","p""q"\r\nc,d\r\n\r\n');
    assert.deepEqual(rows, [
      { user: 'a,b', pass: 'p"q' },
      { user: 'c', pass: 'd' },
    ]);
  });
});
