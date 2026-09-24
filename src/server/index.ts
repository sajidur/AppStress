import { hostname } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { createBackend } from '../backend/index.js';
import { LoadWorker } from '../distributed/worker.js';
import { buildApp } from './app.js';
import { Store } from './db.js';
import { EventHub } from './events.js';

/**
 * Load Test Studio web server: UI + REST API. Optionally hosts an embedded
 * worker so a single machine works out of the box; add standalone workers
 * (`lt worker`) on other machines to scale out.
 */
async function main() {
  const store = new Store(join(config.dataDir, 'lt.db'));
  const backend = createBackend(config.mode);
  const hub = new EventHub();
  const worker = config.embeddedWorker
    ? new LoadWorker(backend, { concurrency: config.embeddedWorkerConcurrency, kind: 'embedded', id: `embedded-${hostname()}-${process.pid}` })
    : undefined;

  const { app, runs, recordings } = await buildApp({
    store,
    backend,
    hub,
    worker,
    auth: config.authUser && config.authPassword ? { user: config.authUser, password: config.authPassword } : undefined,
    apiToken: process.env.LT_API_TOKEN || undefined,
    webDir: process.env.LT_WEB_DIR,
    recorderHeadless: config.recorderHeadless,
    recorderBrowser: config.recorderBrowser,
    recorderEnabled: config.recorderEnabled,
    redisRunTtlSec: config.redisRunTtlSec,
    maxUploadMb: config.maxUploadMb,
  });

  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  if (!loopback && !config.authUser && !process.env.LT_API_TOKEN) {
    app.log.warn(`Listening on ${config.host} WITHOUT authentication. Set LT_AUTH_USER / LT_AUTH_PASSWORD (and/or LT_API_TOKEN).`);
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Load Test Studio ready on http://${loopback ? 'localhost' : config.host}:${config.port} (${backend.mode} mode)`);
  if (backend.mode === 'memory') {
    app.log.info(`In-memory mode: no Redis/RabbitMQ; this process generates up to ${config.embeddedWorkerConcurrency} VUs. Set LT_MODE=distributed to use a worker fleet.`);
  }

  if (worker) void worker.start().catch((e) => app.log.error({ err: e }, 'embedded worker failed'));
  await runs.resume().catch((e) => app.log.error({ err: e }, 'could not resume runs'));

  // A stray promise rejection (e.g. inside a browser-recording callback) must not take down
  // the server and every run it is monitoring: log it instead.
  process.on('unhandledRejection', (reason) => app.log.error({ err: reason }, 'unhandled promise rejection'));

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) process.exit(1);
    closing = true;
    app.log.info(`${signal}: shutting down (active runs keep going on the workers and are resumed on restart)`);
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    await app.close().catch(() => undefined);
    await recordings.stopAll();
    await worker?.stop();
    await backend.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
