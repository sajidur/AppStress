import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunStats, StepStats } from '../src/metrics/stats.js';
import { evaluateThresholds, toJUnit } from '../src/metrics/thresholds.js';
import { Store } from '../src/server/db.js';
import { settingsSchema, workflowSchema } from '../src/server/schemas.js';
import { maskRows, parseUsersFile, suggestUserFields } from '../src/server/services/helpers.js';
import { DEFAULT_SETTINGS, type Recording } from '../src/types.js';

const step = (name: string, over: Partial<StepStats> = {}): StepStats => ({
  name,
  count: 100,
  errors: 0,
  errorRate: 0,
  rps: 10,
  avgMs: 50,
  minMs: 5,
  maxMs: 200,
  p50: 40,
  p90: 90,
  p95: 120,
  p99: 180,
  statuses: { '200': 100 },
  ...over,
});

const stats = (steps: StepStats[], total: StepStats): RunStats => ({
  runId: 'r1',
  config: null,
  steps,
  total,
  timeline: [],
  errors: [],
  vus: { started: 1, active: 0, done: 1 },
  durationSec: 10,
});

describe('thresholds', () => {
  it('passes when all criteria hold and fails otherwise', () => {
    const s = stats([step('login', { p95: 300 })], step('TOTAL', { errorRate: 0.02 }));
    const ok = evaluateThresholds(s, [{ metric: 'p95', op: '<', value: 500 }]);
    assert.equal(ok.verdict, 'passed');
    const bad = evaluateThresholds(s, [
      { metric: 'errorRate', op: '<', value: 1 },
      { metric: 'p95', op: '<=', value: 250, step: 'login' },
    ]);
    assert.equal(bad.verdict, 'failed');
    assert.deepEqual(bad.results.map((r) => [r.actual, r.passed]), [[2, false], [300, false]]);
  });

  it('fails thresholds on steps that never ran and runs with no requests', () => {
    const s = stats([], step('TOTAL', { count: 0 }));
    const r = evaluateThresholds(s, []);
    assert.equal(r.verdict, 'failed');
    const missing = evaluateThresholds(stats([], step('TOTAL')), [{ metric: 'p95', op: '<', value: 1, step: 'nope' }]);
    assert.equal(missing.results[0].passed, false);
  });

  it('emits valid-looking JUnit with escaped names', () => {
    const s = stats([step('GET /a?x=1&y=<2>', { errors: 3, errorRate: 0.03 })], step('TOTAL'));
    const { results } = evaluateThresholds(s, [{ metric: 'p95', op: '<', value: 10 }]);
    const xml = toJUnit('My "test"', s, results);
    assert.match(xml, /failures="2"/);
    assert.match(xml, /GET \/a\?x=1&amp;y=&lt;2&gt;/);
    assert.match(xml, /name="My &quot;test&quot;"/);
  });
});

describe('users files', () => {
  it('parses CSV and JSON and validates columns', () => {
    assert.deepEqual(parseUsersFile('u.csv', 'username,password\na,b\n').rows, [{ username: 'a', password: 'b' }]);
    assert.deepEqual(parseUsersFile('u.json', '[{"id":1,"name":"x"}]').rows, [{ id: '1', name: 'x' }]);
    assert.throws(() => parseUsersFile('u.csv', 'bad column,x\n1,2'));
    assert.throws(() => parseUsersFile('u.csv', 'only,header\n'));
  });
  it('masks sensitive columns in previews', () => {
    assert.deepEqual(maskRows([{ user: 'a', password: 'p', apiToken: 't' }], ['user', 'password', 'apiToken']), [{ user: 'a', password: '••••••', apiToken: '••••••' }]);
  });
  it('suggests the columns that were typed during recording', () => {
    const rec = {
      version: 1,
      startUrl: 'http://x/',
      recordedAt: '',
      navigations: [],
      exchanges: [
        { id: 1, startedAt: 0, durationMs: 1, pageUrl: '', resourceType: 'fetch', request: { method: 'POST', url: 'http://x/login', headers: {}, postData: 'email=bob%40x.io&password=hunter22' } },
      ],
    } as Recording;
    const rows = [
      { email: 'alice@x.io', password: 'pw1', name: 'Alice' },
      { email: 'bob@x.io', password: 'hunter22', name: 'Bob' },
    ];
    assert.deepEqual(suggestUserFields(rec, rows), { email: 'bob@x.io', password: 'hunter22' });
  });
});

describe('schemas', () => {
  it('accepts the default settings and rejects invalid ones', () => {
    assert.ok(settingsSchema.parse(DEFAULT_SETTINGS));
    assert.throws(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, vus: 0 }));
    assert.throws(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, baseUrl: 'ftp://x' }));
  });
  it('rejects workflows with duplicate step names or broken extractors', () => {
    const s = { name: 'a', request: { method: 'GET', url: '/' } };
    assert.throws(() => workflowSchema.parse({ name: 'w', variables: {}, setup: [s], steps: [s] }));
    assert.throws(() =>
      workflowSchema.parse({ name: 'w', variables: {}, setup: [], steps: [{ ...s, extract: [{ var: 'x', from: 'regex', regex: '(' }] }] }),
    );
  });
});

describe('store', () => {
  it('persists tests, datasets and runs with cascading deletes', () => {
    const store = new Store(':memory:');
    store.createTest({ id: 't1', name: 'T', description: '', startUrl: 'http://x', settings: DEFAULT_SETTINGS });
    store.saveDataset('t1', 'u.csv', ['a'], [{ a: '1' }, { a: '2' }]);
    store.createRun({ id: 'r1', testId: 't1', settings: DEFAULT_SETTINGS, workflow: { name: 'w', variables: {}, setup: [], steps: [] }, triggeredBy: 'test' });
    store.updateRun('r1', { status: 'completed', verdict: 'passed', finishedAt: 1 });
    const list = store.listTests();
    assert.equal(list[0].users, 2);
    assert.equal(list[0].lastVerdict, 'passed');
    assert.equal(store.listRuns({ statuses: ['running'] }).length, 0);
    assert.ok(store.deleteTest('t1'));
    assert.equal(store.getRun('r1'), null);
    store.close();
  });
});
