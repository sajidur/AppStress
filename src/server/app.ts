import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { buildWorkflow } from '../builder/builder.js';
import type { Backend } from '../backend/types.js';
import type { LoadWorker } from '../distributed/worker.js';
import { renderHtml } from '../metrics/report.js';
import { toJUnit } from '../metrics/thresholds.js';
import { harToRecording } from '../recorder/har.js';
import { API_TYPES } from '../recorder/recorder.js';
import { DEFAULT_SETTINGS, type Recording, type Workflow } from '../types.js';
import { ACTIVE_STATUSES, type Store } from './db.js';
import { EventHub, streamEvents } from './events.js';
import {
  buildOptionsSchema,
  createTestSchema,
  harUploadSchema,
  settingsSchema,
  startRecordingSchema,
  startRunSchema,
  updateTestSchema,
  usersUploadSchema,
  validateSchema,
  workflowSchema,
} from './schemas.js';
import { applySettings, HttpError, maskRows, parseUsersFile, sampleExchange, suggestUserFields, validateWorkflow } from './services/helpers.js';
import { recordingTopic, RecordingService } from './services/recordings.js';
import { RunService, runTopic } from './services/runs.js';

export interface AppDeps {
  store: Store;
  backend: Backend;
  hub: EventHub;
  worker?: LoadWorker;
  auth?: { user: string; password: string };
  apiToken?: string;
  webDir?: string;
  recorderHeadless: boolean;
  recorderEnabled: boolean;
  redisRunTtlSec: number;
  maxUploadMb: number;
  logLevel?: string;
}

export interface App {
  app: FastifyInstance;
  runs: RunService;
  recordings: RecordingService;
}

function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data ?? {});
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function buildApp(deps: AppDeps): Promise<App> {
  const { store, backend, hub } = deps;
  const app = Fastify({
    logger: { level: deps.logLevel ?? process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: deps.maxUploadMb * 1024 * 1024,
  });
  const recordings = new RecordingService(store, hub, app.log, deps.recorderHeadless);
  const runs = new RunService(store, backend, hub, app.log, deps.redisRunTtlSec);

  /* ---------------------------------------------------------------- errors */

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    }
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.status(status).send({ error: status >= 500 ? 'Internal server error' : (e.message ?? 'Request failed') });
  });

  /* ---------------------------------------------------------------- auth */

  if (deps.auth || deps.apiToken) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/api/health') return;
      const header = req.headers.authorization ?? '';
      if (deps.apiToken && header.startsWith('Bearer ') && safeEqual(header.slice(7), deps.apiToken)) return;
      if (deps.auth && header.startsWith('Basic ')) {
        const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
        if (safeEqual(user, deps.auth.user) && safeEqual(rest.join(':'), deps.auth.password)) return;
      }
      reply.header('www-authenticate', 'Basic realm="Load Test Studio", charset="UTF-8"');
      return reply.status(401).send({ error: 'Authentication required' });
    });
  }

  /* ---------------------------------------------------------------- helpers */

  const requireTest = (id: string) => {
    const t = store.getTest(id);
    if (!t) throw new HttpError(404, 'Test not found');
    return t;
  };
  type IdParams = FastifyRequest<{ Params: { id: string } }>;

  const testDetails = (id: string) => {
    const test = requireTest(id);
    const rec = store.getRecording(id);
    const dataset = store.getDatasetMeta(id);
    return {
      ...test,
      recording: rec
        ? {
            source: rec.source,
            createdAt: rec.createdAt,
            exchangeCount: rec.recording.exchanges.length,
            apiCount: rec.recording.exchanges.filter((e) => API_TYPES.includes(e.resourceType)).length,
          }
        : null,
      recordingActive: recordings.isActive(id),
      dataset,
      activeRuns: store.listRuns({ testId: id, statuses: ACTIVE_STATUSES, limit: 10 }).map((r) => r.id),
    };
  };

  /* ---------------------------------------------------------------- system */

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/system', async () => {
    const [stateOk, queue, workers] = await Promise.all([
      backend.state.ping().catch(() => false),
      backend.queue.info().catch((e) => ({ error: String(e?.message ?? e) })),
      backend.state.listWorkers().catch(() => []),
    ]);
    return {
      mode: backend.mode,
      redis: { ok: stateOk },
      rabbitmq: 'error' in queue ? { ok: false, error: queue.error } : { ok: true, ...queue },
      workers,
      capacity: workers.reduce((s, w) => s + w.concurrency, 0),
      embeddedWorker: deps.worker?.status ?? null,
      recorderHeadless: deps.recorderHeadless,
      recorderEnabled: deps.recorderEnabled,
    };
  });

  /* ---------------------------------------------------------------- tests */

  app.get('/api/tests', async () => store.listTests());

  app.post('/api/tests', async (req, reply) => {
    const body = parse(createTestSchema, req.body);
    const test = store.createTest({ id: randomBytes(6).toString('hex'), ...body, settings: DEFAULT_SETTINGS });
    return reply.status(201).send(test);
  });

  app.get('/api/tests/:id', async (req: IdParams) => testDetails(req.params.id));

  app.patch('/api/tests/:id', async (req: IdParams) => {
    requireTest(req.params.id);
    store.updateTest(req.params.id, parse(updateTestSchema, req.body));
    return testDetails(req.params.id);
  });

  app.delete('/api/tests/:id', async (req: IdParams, reply) => {
    if (store.listRuns({ testId: req.params.id, statuses: ACTIVE_STATUSES }).length) throw new HttpError(409, 'Stop the active run first');
    if (recordings.isActive(req.params.id)) throw new HttpError(409, 'Stop the active recording first');
    if (!store.deleteTest(req.params.id)) throw new HttpError(404, 'Test not found');
    return reply.status(204).send();
  });

  app.post('/api/tests/:id/duplicate', async (req: IdParams, reply) => {
    const src = requireTest(req.params.id);
    const copy = store.createTest({ id: randomBytes(6).toString('hex'), name: `${src.name} (copy)`, description: src.description, startUrl: src.startUrl, settings: src.settings });
    store.updateTest(copy.id, { workflow: src.workflow, buildOptions: src.buildOptions, buildReport: src.buildReport });
    const rec = store.getRecording(src.id);
    if (rec) store.saveRecording(copy.id, rec.recording, rec.recording.exchanges.filter((e) => API_TYPES.includes(e.resourceType)).length, rec.source as 'browser' | 'har' | 'import');
    const ds = store.getDatasetMeta(src.id);
    if (ds) store.saveDataset(copy.id, ds.filename, ds.columns, store.getDatasetRows(src.id));
    return reply.status(201).send(store.getTest(copy.id));
  });

  /* ---------------------------------------------------------------- recording */

  app.post('/api/tests/:id/recording/start', async (req: IdParams, reply) => {
    const test = requireTest(req.params.id);
    if (!deps.recorderEnabled) {
      throw new HttpError(503, 'Live recording is disabled on this server (LT_RECORDER_ENABLED=false). Import a HAR file instead.');
    }
    const body = parse(startRecordingSchema, req.body);
    const url = body.url ?? test.startUrl;
    if (body.url && body.url !== test.startUrl) store.updateTest(test.id, { startUrl: body.url });
    recordings.start(test.id, url, body.timeoutSec);
    return reply.status(202).send({ ok: true });
  });

  app.post('/api/tests/:id/recording/stop', async (req: IdParams) => {
    recordings.stop(req.params.id);
    return { ok: true };
  });

  app.get('/api/tests/:id/recording/events', async (req: IdParams, reply) => {
    requireTest(req.params.id);
    streamEvents(req, reply, hub, recordingTopic(req.params.id), recordings.backlog(req.params.id));
  });

  app.get('/api/tests/:id/recording', async (req: IdParams) => {
    requireTest(req.params.id);
    const rec = store.getRecording(req.params.id);
    if (!rec) return { recording: null };
    const exchanges = rec.recording.exchanges.map((e) => ({
      id: e.id,
      at: e.startedAt,
      method: e.request.method,
      url: e.request.url,
      status: e.response?.status,
      resourceType: e.resourceType,
      durationMs: e.durationMs,
      failure: e.failure,
    }));
    return { recording: { source: rec.source, createdAt: rec.createdAt, startUrl: rec.recording.startUrl, exchanges } };
  });

  /** Import a browser HAR export or a recording made with `lt record`. */
  app.post('/api/tests/:id/recording/import', async (req: IdParams) => {
    requireTest(req.params.id);
    const { content } = parse(harUploadSchema, req.body);
    let data: { log?: { entries?: unknown[] }; version?: number; exchanges?: unknown[] };
    try {
      data = JSON.parse(content);
    } catch {
      throw new HttpError(400, 'Invalid file: not JSON');
    }
    let rec: Recording;
    if (Array.isArray(data?.log?.entries)) rec = harToRecording(data as never);
    else if (data?.version === 1 && Array.isArray(data.exchanges)) rec = data as unknown as Recording;
    else throw new HttpError(400, 'Unsupported file: expected a HAR export or an lt recording');
    if (!rec.exchanges.length) throw new HttpError(400, 'The file contains no requests');
    const apiCount = rec.exchanges.filter((e) => API_TYPES.includes(e.resourceType)).length;
    store.saveRecording(req.params.id, rec, apiCount, Array.isArray(data?.log?.entries) ? 'har' : 'import');
    return { exchangeCount: rec.exchanges.length, apiCount };
  });

  /* ---------------------------------------------------------------- users */

  app.post('/api/tests/:id/users', async (req: IdParams) => {
    requireTest(req.params.id);
    const { filename, content } = parse(usersUploadSchema, req.body);
    const { columns, rows } = parseUsersFile(filename, content);
    store.saveDataset(req.params.id, filename, columns, rows);
    return { filename, columns, rowCount: rows.length };
  });

  app.get('/api/tests/:id/users', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: string } }>) => {
    requireTest(req.params.id);
    const meta = store.getDatasetMeta(req.params.id);
    if (!meta) return { dataset: null };
    const limit = Math.min(Number(req.query.limit ?? 25) || 25, 500);
    return { dataset: { ...meta, preview: maskRows(store.getDatasetRows(req.params.id).slice(0, limit), meta.columns) } };
  });

  app.delete('/api/tests/:id/users', async (req: IdParams, reply) => {
    requireTest(req.params.id);
    store.deleteDataset(req.params.id);
    return reply.status(204).send();
  });

  /* ---------------------------------------------------------------- workflow */

  app.get('/api/tests/:id/workflow/suggest-user-fields', async (req: IdParams) => {
    requireTest(req.params.id);
    const rec = store.getRecording(req.params.id);
    const rows = store.getDatasetRows(req.params.id);
    if (!rec || !rows.length) return { userFields: {} };
    return { userFields: suggestUserFields(rec.recording, rows) };
  });

  /** The recorded response of an exchange: values a later request can bind to (JSON paths, headers, cookies, hidden fields). */
  app.get('/api/tests/:id/workflow/response-sample/:exchangeId', async (req: FastifyRequest<{ Params: { id: string; exchangeId: string } }>) => {
    requireTest(req.params.id);
    const rec = store.getRecording(req.params.id);
    if (!rec) throw new HttpError(404, 'No recording for this test');
    const ex = rec.recording.exchanges.find((e) => e.id === Number(req.params.exchangeId));
    if (!ex) throw new HttpError(404, 'That request is not in the recording');
    return sampleExchange(ex);
  });

  app.post('/api/tests/:id/workflow/build', async (req: IdParams) => {
    const test = requireTest(req.params.id);
    const rec = store.getRecording(test.id);
    if (!rec) throw new HttpError(400, 'Record the flow (or upload a HAR) first');
    const opts = parse(buildOptionsSchema, req.body);
    const { workflow, report } = buildWorkflow(rec.recording, { ...opts, name: test.name });
    if (!workflow.setup.length && !workflow.steps.length) {
      throw new HttpError(400, 'No API requests matched the filters. Check the domains / exclude options or re-record the flow.');
    }
    store.updateTest(test.id, { workflow, buildOptions: opts, buildReport: report });
    return { workflow, report };
  });

  app.put('/api/tests/:id/workflow', async (req: IdParams) => {
    requireTest(req.params.id);
    const workflow = parse(workflowSchema, req.body) as Workflow;
    store.updateTest(req.params.id, { workflow });
    return { workflow };
  });

  app.post('/api/tests/:id/workflow/validate', async (req: IdParams) => {
    const test = requireTest(req.params.id);
    if (!test.workflow) throw new HttpError(400, 'Build the workflow first');
    const { userIndex, iterations } = parse(validateSchema, req.body);
    const rows = store.getDatasetRows(test.id);
    const user = rows.length ? rows[userIndex % rows.length] : {};
    const result = await validateWorkflow(applySettings(test.workflow, test.settings), user, {
      iterations,
      requestTimeoutMs: test.settings.requestTimeoutMs,
      capture: test.settings.capture,
    });
    const masked = rows.length ? maskRows([user], Object.keys(user))[0] : null;
    return { ...result, user: masked, userIndex: rows.length ? userIndex % rows.length : null };
  });

  /* ---------------------------------------------------------------- settings */

  app.put('/api/tests/:id/settings', async (req: IdParams) => {
    requireTest(req.params.id);
    const settings = parse(settingsSchema, req.body);
    if (settings.baseUrl === '') delete settings.baseUrl;
    store.updateTest(req.params.id, { settings });
    return { settings };
  });

  /* ---------------------------------------------------------------- runs */

  app.post('/api/tests/:id/runs', async (req: IdParams, reply) => {
    const body = parse(startRunSchema, req.body);
    const run = await runs.start(req.params.id, body.triggeredBy, body.settings);
    return reply.status(201).send(run);
  });

  app.get('/api/tests/:id/runs', async (req: IdParams) => {
    requireTest(req.params.id);
    return store.listRuns({ testId: req.params.id, limit: 200 });
  });

  app.get('/api/runs', async (req: FastifyRequest<{ Querystring: { limit?: string } }>) =>
    store.listRuns({ limit: Math.min(Number(req.query.limit ?? 50) || 50, 500) }),
  );

  const requireRun = (id: string) => {
    const r = store.getRun(id);
    if (!r) throw new HttpError(404, 'Run not found');
    return r;
  };

  app.get('/api/runs/:id', async (req: IdParams) => {
    const run = requireRun(req.params.id);
    const details = store.getRunDetails(run.id)!;
    return { ...run, stats: details.stats, progress: runs.latestProgress(run.id) ?? null };
  });

  /** Full request/response details of the calls kept during the run (live while it runs). */
  app.get('/api/runs/:id/samples', async (req: IdParams) => {
    const run = requireRun(req.params.id);
    const wf = store.getRunDetails(run.id)?.workflow;
    // the request as configured (variables not yet filled in), so each call can be compared with its definition
    const steps = [...(wf?.setup ?? []), ...(wf?.steps ?? [])].map((s) => ({ name: s.name, request: s.request }));
    return { capture: run.config?.capture ?? null, steps, samples: await runs.samples(run.id) };
  });

  app.get('/api/runs/:id/events', async (req: IdParams, reply) => {
    const run = requireRun(req.params.id);
    const initial: object[] = [{ type: 'status', status: run.status }];
    const p = runs.latestProgress(run.id);
    if (p) initial.push({ type: 'progress', progress: p });
    if (!ACTIVE_STATUSES.includes(run.status)) initial.push({ type: 'finished', run });
    streamEvents(req, reply, hub, runTopic(run.id), initial);
  });

  app.post('/api/runs/:id/stop', async (req: IdParams) => {
    await runs.stop(req.params.id);
    return { ok: true };
  });

  app.delete('/api/runs/:id', async (req: IdParams, reply) => {
    const run = requireRun(req.params.id);
    if (ACTIVE_STATUSES.includes(run.status)) throw new HttpError(409, 'Stop the run before deleting it');
    store.deleteRun(run.id);
    return reply.status(204).send();
  });

  const finishedRun = (id: string) => {
    const run = requireRun(id);
    const details = store.getRunDetails(id)!;
    if (!details.stats) throw new HttpError(409, 'The run has no results yet');
    return { run, stats: details.stats, workflow: details.workflow };
  };

  app.get('/api/runs/:id/report.html', async (req: IdParams, reply) => {
    const { run, stats, workflow } = finishedRun(req.params.id);
    return reply
      .type('text/html; charset=utf-8')
      .header('content-disposition', `inline; filename="${run.id}.html"`)
      .send(renderHtml(stats, { ...workflow, name: run.testName ?? workflow.name }, { verdict: run.verdict ?? undefined, thresholds: run.thresholds ?? [], samples: store.getRunSamples(run.id), capture: run.config?.capture }));
  });

  app.get('/api/runs/:id/report.json', async (req: IdParams, reply) => {
    const { run, stats } = finishedRun(req.params.id);
    return reply.header('content-disposition', `attachment; filename="${run.id}.json"`).send({ run, stats, samples: store.getRunSamples(run.id) });
  });

  app.get('/api/runs/:id/junit.xml', async (req: IdParams, reply) => {
    const { run, stats } = finishedRun(req.params.id);
    return reply
      .type('application/xml; charset=utf-8')
      .header('content-disposition', `attachment; filename="${run.id}-junit.xml"`)
      .send(toJUnit(run.testName ?? run.testId, stats, run.thresholds ?? []));
  });

  /* ---------------------------------------------------------------- web UI */

  const webDir = resolve(deps.webDir ?? 'dist/web');
  const indexFile = join(webDir, 'index.html');
  if (existsSync(indexFile)) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false, index: false });
    const indexHtml = readFileSync(indexFile, 'utf8');
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.type('text/html').send(indexHtml);
    });
  } else {
    app.log.warn(`web UI not found at ${webDir} — run "npm run build:web" (API still available)`);
    app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: 'Not found' }));
  }

  return { app, runs, recordings };
}
