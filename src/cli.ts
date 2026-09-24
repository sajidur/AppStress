#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Command, Option } from 'commander';
import { buildWorkflow } from './builder/builder.js';
import { createBackend } from './backend/index.js';
import { config } from './config.js';
import { runAndReport } from './distributed/controller.js';
import { LoadWorker, startWorker } from './distributed/worker.js';
import { VirtualUser, type StepTrace } from './engine/executor.js';
import { MetricsCollector } from './metrics/collector.js';
import { printSummary, writeReports } from './metrics/report.js';
import { harToRecording } from './recorder/har.js';
import { DEFAULT_CAPTURE, type Recording, type UsersMode, type Workflow } from './types.js';
import { collect, loadUsers, log, parseKeyValues, readJson } from './util.js';

const program = new Command();
program
  .name('lt')
  .description('Record browser flows, turn them into API workflows, and run them as distributed load tests.');

/* ------------------------------------------------------------------ record */
program
  .command('record')
  .description('Open a browser and record the API calls of a business flow (Playwright)')
  .argument('<url>', 'start URL')
  .option('-o, --out <file>', 'recording output file', 'recordings/recording.json')
  .option('-u, --user-field <field=value>', 'value you will type that should come from the users list (repeatable)', collect, [])
  .option('--headless', 'run the browser headless (use with --script)', false)
  .option('--browser <name>', 'chrome (installed Google Chrome), msedge, or chromium (Playwright bundled)', config.recorderBrowser)
  .option('--script <file>', 'automate the flow: module exporting default async (page, userFields) => {}')
  .option('--timeout <sec>', 'stop recording after N seconds', (v) => Number(v))
  .action(async (url: string, o) => {
    const { record } = await import('./recorder/recorder.js');
    await record({ url, out: o.out, userFields: parseKeyValues(o.userField), headless: o.headless, browser: o.browser, script: o.script, timeoutSec: o.timeout });
  });

/* ------------------------------------------------------------------ build */
program
  .command('build')
  .description('Convert a recording (or a browser HAR export) into an API workflow with automatic correlation')
  .argument('<input>', 'recording .json or .har file')
  .option('-o, --out <file>', 'workflow output file', 'workflows/workflow.json')
  .option('-n, --name <name>', 'workflow name')
  .option('-d, --domain <host>', 'only keep requests to this host (suffix match, repeatable). Default: the start URL site domain incl. subdomains', collect, [])
  .option('-x, --exclude <regex>', 'drop requests whose URL matches (repeatable)', collect, [])
  .option('-u, --user-field <field=value>', 'recorded value -> ${user.field} (repeatable; adds to those given at record time)', collect, [])
  .option('--no-documents', 'drop HTML page loads, keep only XHR/fetch API calls')
  .option('-t, --types <list>', 'request types that count as test steps, comma separated: document,xhr,script,stylesheet,image,font,media,other (default: document,xhr)')
  .option('--no-correlate', 'disable automatic correlation of dynamic values')
  .option('--min-think <ms>', 'ignore pauses shorter than this', (v) => Number(v), 500)
  .option('--max-think <ms>', 'cap recorded pauses', (v) => Number(v), 10000)
  .option('--keep-tracking', 'keep analytics/RUM/telemetry beacons (dropped by default)', false)
  .option('--cache-login <sec>', 'share the login step result (e.g. token) per user via Redis for N seconds', (v) => Number(v))
  .action((input: string, o) => {
    const raw = readJson<Recording | { log: unknown }>(input);
    const rec: Recording = 'log' in raw ? harToRecording(raw as never) : (raw as Recording);
    const { workflow, report } = buildWorkflow(rec, {
      name: o.name,
      domains: o.domain,
      exclude: o.exclude,
      includeDocuments: o.documents,
      resourceTypes: o.types ? String(o.types).split(',').map((t: string) => t.trim()).filter(Boolean) : undefined,
      userFields: parseKeyValues(o.userField),
      correlate: o.correlate,
      minThinkMs: o.minThink,
      maxThinkMs: o.maxThink,
      cacheLoginTtlSec: o.cacheLogin,
      keepTracking: o.keepTracking,
    });
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(o.out, JSON.stringify(workflow, null, 2));
    log('build', `${report.kept} requests kept, ${report.dropped} dropped (static assets / other domains / noise)`);
    log('build', `setup (once per VU): ${workflow.setup.length} steps, main (per iteration): ${workflow.steps.length} steps${workflow.teardown?.length ? `, teardown (logout): ${workflow.teardown.length} steps` : ''}`);
    if (report.userFieldSteps.length) log('build', `user data used in: ${report.userFieldSteps.join(', ')}`);
    else log('build', 'NOTE: no --user-field values were found in requests; every VU will send the recorded credentials.');
    for (const c of report.correlations) log('build', `correlated \${${c.variable}} <- [${c.source}] ${c.extractor}  used in: ${c.usedIn.join(', ')}`);
    for (const g of report.generated ?? []) log('build', `made up by the browser: ${g.kind} in ${g.step} (${g.where}) -> generated fresh for every call`);
    for (const t of report.typed ?? []) log('build', `typed into "${t.label || t.field}": ${t.column ? `from users-file column ${t.column}` : 'kept as recorded'}; sent in ${t.sentIn.length ? t.sentIn.join(', ') : 'no request as typed'}`);
    for (const i of report.flow?.issues ?? []) if (i.level === 'warn') log('build', `WARNING: ${i.message}${i.hint ? ` (${i.hint})` : ''}`);
    log('build', `Workflow written to ${o.out} — review it, then run "lt validate ${o.out} --users <file>"`);
  });

/* ------------------------------------------------------------------ validate */
program
  .command('validate')
  .description('Execute the workflow once for one user (no Redis/RabbitMQ needed) and print every step')
  .argument('<workflow>', 'workflow .json')
  .option('--users <file>', 'users .csv/.json')
  .option('--user-index <n>', 'which user to use', (v) => Number(v), 0)
  .option('--iterations <n>', 'iterations to run', (v) => Number(v), 1)
  .option('-v, --var <key=value>', 'override a workflow variable, e.g. baseUrl=http://staging (repeatable)', collect, [])
  .option('--timeout <ms>', 'request timeout', (v) => Number(v), 30000)
  .option('--no-think', 'skip think times')
  .option('--verbose', 'print request bodies and response snippets', false)
  .action(async (file: string, o) => {
    const workflow = withVars(readJson<Workflow>(file), parseKeyValues(o.var));
    const users = o.users ? loadUsers(o.users) : [];
    const user = users[o.userIndex % Math.max(1, users.length)] ?? {};
    let failures = 0;
    const onTrace = (t: StepTrace) => {
      const status = t.cached ? 'CACHE' : t.error ? `FAIL ${t.status || ''}` : `OK ${t.status}`;
      console.log(`${status.padEnd(9)} ${t.durationMs.toFixed(0).padStart(6)}ms  ${t.step}`);
      if (t.error) {
        failures++;
        console.log(`          error: ${t.error}\n          url:   ${t.method} ${t.url}`);
      }
      for (const [k, v] of Object.entries(t.extracted)) console.log(`          ${k} = ${v.length > 80 ? v.slice(0, 77) + '...' : v}`);
      if (o.verbose || t.error) {
        if (t.requestBody) console.log(`          request:  ${t.requestBody.slice(0, 300)}`);
        if (t.responseSnippet) console.log(`          response: ${t.responseSnippet.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
    };
    const vu = new VirtualUser({
      workflow,
      user,
      vuIndex: 0,
      metrics: new MetricsCollector(),
      requestTimeoutMs: o.timeout,
      thinkTimeScale: o.think ? 1 : 0,
      shouldStop: () => false,
      onTrace,
    });
    console.log(`Validating "${workflow.name}" as user ${JSON.stringify(user)}\n-- setup`);
    const ok = await vu.runSetup();
    if (ok) {
      for (let i = 0; i < o.iterations; i++) {
        console.log(`-- iteration ${i}`);
        await vu.runIteration(i);
      }
    }
    if (ok && workflow.teardown?.length) {
      console.log('-- teardown');
      await vu.runTeardown();
    }
    console.log(failures ? `\n${failures} step(s) failed` : '\nAll steps passed');
    process.exitCode = failures ? 1 : 0;
  });

/* ------------------------------------------------------------------ run */
program
  .command('run')
  .description('Run a load test: in-process with --local (no Redis/RabbitMQ), or distributed across workers')
  .argument('<workflow>', 'workflow .json')
  .option('--local', 'run everything in this process, in memory (no Redis/RabbitMQ needed)', config.mode === 'memory')
  .option('--distributed', 'use RabbitMQ + Redis and the worker fleet (overrides LT_MODE=memory)', false)
  .option('--users <file>', 'users .csv/.json; each VU logs in as a different user')
  .option('--vus <n>', 'number of virtual users', (v) => Number(v), 10)
  .option('--ramp-up <sec>', 'spread VU start times over N seconds', (v) => Number(v), 10)
  .option('--duration <sec>', 'test duration in seconds (includes ramp-up)', (v) => Number(v))
  .option('--iterations <n>', 'iterations per VU (default: unlimited within --duration)', (v) => Number(v))
  .addOption(
    new Option('--users-mode <mode>', 'per-vu: VU i uses user i (wraps); unique: require one user per VU; per-iteration: next user every iteration')
      .choices(['per-vu', 'unique', 'per-iteration'])
      .default('per-vu'),
  )
  .option('--think-scale <x>', 'multiply recorded think times (0 = no think time)', (v) => Number(v), 1)
  .option('--fresh-session', 'log in again with a clean session at the start of every iteration (the teardown/logout steps run first)', false)
  .option('--timeout <ms>', 'request timeout', (v) => Number(v), 30000)
  .option('-v, --var <key=value>', 'override a workflow variable, e.g. baseUrl=http://staging (repeatable)', collect, [])
  .option('--run-id <id>', 'custom run id')
  .option('--start-delay <sec>', 'time for workers to pick up jobs before VU #0 starts', (v) => Number(v))
  .option('--report-dir <dir>', 'report output directory', 'reports')
  .option('--samples <n>', 'keep only the first n successful calls per step in full (default: every call is kept)', (v) => Number(v))
  .option('--error-samples <n>', 'keep only the first n failed calls per step in full (default: every call is kept)', (v) => Number(v))
  .option('--max-calls <n>', 'stop keeping call details after this many calls (default 100000)', (v) => Number(v))
  .option('--body-kb <n>', 'cut request/response bodies in the report after this many KB', (v) => Number(v), DEFAULT_CAPTURE.bodyKb)
  .option('--no-mask', 'show Authorization/Cookie headers and password/token fields in the report instead of masking them')
  .action(async (file: string, o) => {
    const workflow = withVars(readJson<Workflow>(file), parseKeyValues(o.var));
    const local = o.local && !o.distributed;
    const backend = createBackend(local ? 'memory' : 'distributed');
    // In local mode this process is the only load generator.
    const worker = local ? new LoadWorker(backend, { concurrency: o.vus, kind: 'local', id: 'local' }) : undefined;
    await worker?.start();
    const stats = await runAndReport(backend, {
      workflow,
      users: o.users ? loadUsers(o.users) : [],
      vus: o.vus,
      rampUpSec: o.rampUp,
      durationSec: o.duration,
      iterations: o.iterations,
      usersMode: o.usersMode as UsersMode,
      thinkTimeScale: o.thinkScale,
      requestTimeoutMs: o.timeout,
      freshSession: o.freshSession,
      capture: {
        okSamples: o.samples ?? DEFAULT_CAPTURE.okSamples,
        errorSamples: o.errorSamples ?? DEFAULT_CAPTURE.errorSamples,
        bodyKb: o.bodyKb,
        maskSecrets: o.mask,
        keepAll: o.samples === undefined && o.errorSamples === undefined,
        ...(o.maxCalls ? { maxCalls: o.maxCalls } : {}),
      },
      runId: o.runId,
      reportDir: o.reportDir,
      startDelaySec: o.startDelay,
    });
    await worker?.stop();
    await backend.close();
    process.exit(stats.total.count > 0 ? 0 : 1);
  });

/* ------------------------------------------------------------------ worker (distributed mode) */
program
  .command('worker')
  .description('Start a load-generator worker for distributed mode (RabbitMQ + Redis); run as many as you need')
  .option('-c, --concurrency <n>', 'max concurrent virtual users on this worker', (v) => Number(v), Number(process.env.LT_CONCURRENCY ?? 200))
  .option('--id <id>', 'worker id')
  .action(async (o) => startWorker(createBackend('distributed'), { concurrency: o.concurrency, id: o.id }));

/* ------------------------------------------------------------------ ops (distributed mode) */
program
  .command('stop')
  .description('Signal all workers to stop a distributed run')
  .argument('<runId>')
  .action(async (runId: string) => {
    const backend = createBackend('distributed');
    await backend.state.requestStop(runId);
    log('controller', `Stop signal sent to ${runId}`);
    await backend.close();
  });

program
  .command('report')
  .description('(Re)generate the report of a distributed run from Redis')
  .argument('<runId>')
  .option('--report-dir <dir>', 'report output directory', 'reports')
  .action(async (runId: string, o) => {
    const backend = createBackend('distributed');
    const run = await backend.state.loadRun(runId);
    const order = run ? [...run.workflow.setup, ...run.workflow.steps, ...(run.workflow.teardown ?? [])].map((s) => s.name) : [];
    const stats = await backend.state.loadStats(runId, order);
    printSummary(stats);
    const samples = await backend.state.loadSamples(runId);
    log('report', `Reports: ${writeReports(stats, run?.workflow, o.reportDir, { samples, capture: run?.config.capture }).join(', ')}`);
    await backend.close();
  });

program
  .command('status')
  .description('List live workers and recent distributed runs')
  .action(async () => {
    const backend = createBackend('distributed');
    const workers = await backend.state.listWorkers();
    console.log(`Workers (${workers.length}):`);
    for (const w of workers) console.log(`  ${w.id}  active VUs ${w.activeVus}/${w.concurrency}`);
    console.log('Recent runs:');
    for (const r of await backend.state.recentRuns(10)) {
      const s = await backend.state.loadStats(r);
      const stopped = await backend.state.isStopped(r);
      console.log(`  ${r}  active=${s.vus.active} done=${s.vus.done} requests=${s.total.count}${stopped ? ' (stopped)' : ''}`);
    }
    await backend.close();
  });

/* ------------------------------------------------------------------ CI */
program
  .command('ci')
  .description('Run a saved Load Test Studio test from a CI pipeline; exits 0 if the verdict is PASSED, 1 if FAILED, 2 on error')
  .argument('<testId>', 'test id (see the test URL in the UI: /tests/<id>)')
  .option('--server <url>', 'Load Test Studio URL', process.env.LT_SERVER ?? 'http://localhost:4100')
  .option('--token <token>', 'API token (LT_API_TOKEN on the server)', process.env.LT_API_TOKEN)
  .option('--user <user>', 'basic-auth user', process.env.LT_AUTH_USER)
  .option('--password <password>', 'basic-auth password', process.env.LT_AUTH_PASSWORD)
  .option('--junit <file>', 'write a JUnit XML report', 'reports/junit.xml')
  .option('--html <file>', 'write the HTML report')
  .option('--vus <n>', 'override virtual users', (v) => Number(v))
  .option('--duration <sec>', 'override duration', (v) => Number(v))
  .option('--base-url <url>', 'override the target base URL')
  .action(async (testId: string, o) => {
    const server = String(o.server).replace(/\/+$/, '');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    else if (o.user) headers.authorization = `Basic ${Buffer.from(`${o.user}:${o.password ?? ''}`).toString('base64')}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${server}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      return text;
    };
    try {
      const overrides: Record<string, unknown> = {};
      if (o.vus) overrides.vus = o.vus;
      if (o.duration) Object.assign(overrides, { mode: 'duration', durationSec: o.duration });
      if (o.baseUrl) overrides.baseUrl = o.baseUrl;
      const run = JSON.parse(await call('POST', `/tests/${encodeURIComponent(testId)}/runs`, { triggeredBy: 'ci', settings: overrides }));
      log('ci', `Started ${run.id} (${run.settings.vus} VUs) — ${server}/runs/${run.id}`);
      let current = run;
      while (['starting', 'running', 'stopping'].includes(current.status)) {
        await new Promise((r) => setTimeout(r, 5000));
        current = JSON.parse(await call('GET', `/runs/${run.id}`));
        const t = current.progress?.stats?.total;
        if (t) log('ci', `${current.status}: ${t.count} requests, ${(t.errorRate * 100).toFixed(2)}% errors, p95 ${Math.round(t.p95)}ms`);
      }
      for (const t of current.thresholds ?? []) {
        log('ci', `${t.passed ? 'PASS' : 'FAIL'}  ${t.step ? `[${t.step}] ` : ''}${t.metric} ${t.op} ${t.value} (actual ${t.actual ?? 'no data'})`);
      }
      if (current.stats || current.summary) {
        mkdirSync(dirname(o.junit), { recursive: true });
        writeFileSync(o.junit, await call('GET', `/runs/${run.id}/junit.xml`));
        log('ci', `JUnit report: ${o.junit}`);
        if (o.html) {
          mkdirSync(dirname(o.html), { recursive: true });
          writeFileSync(o.html, await call('GET', `/runs/${run.id}/report.html`));
          log('ci', `HTML report: ${o.html}`);
        }
      }
      log('ci', `Run ${current.status}, verdict ${String(current.verdict ?? 'none').toUpperCase()}${current.error ? ` — ${current.error}` : ''}`);
      process.exit(current.verdict === 'passed' ? 0 : current.verdict === 'failed' ? 1 : 2);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    }
  });

function withVars(wf: Workflow, vars: Record<string, string>): Workflow {
  return { ...wf, variables: { ...wf.variables, ...vars } };
}

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
