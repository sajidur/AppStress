const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));
const num = (v: string | undefined, dflt: number) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? dflt : Number(v));

const mode = (process.env.LT_MODE ?? 'memory').toLowerCase() === 'distributed' ? 'distributed' : 'memory';

export const config = {
  /** memory: everything in this process (no Redis/RabbitMQ). distributed: RabbitMQ + Redis + worker fleet */
  mode: mode as 'memory' | 'distributed',
  amqpUrl: process.env.AMQP_URL ?? 'amqp://guest:guest@localhost:5672',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  jobQueue: process.env.LT_JOB_QUEUE ?? 'lt.vu.jobs',
  metricsFlushMs: num(process.env.LT_METRICS_FLUSH_MS, 1000),
  heartbeatMs: 2000,

  /* ---- web app ---- */
  host: process.env.HOST ?? '127.0.0.1',
  port: num(process.env.PORT, 4100),
  dataDir: process.env.LT_DATA_DIR ?? '.data',
  /** HTTP basic auth for the UI/API; disabled when unset */
  authUser: process.env.LT_AUTH_USER,
  authPassword: process.env.LT_AUTH_PASSWORD,
  /** run a worker inside the web server process (always on in memory mode) */
  embeddedWorker: mode === 'memory' || bool(process.env.LT_EMBEDDED_WORKER, true),
  embeddedWorkerConcurrency: num(process.env.LT_EMBEDDED_WORKER_CONCURRENCY, mode === 'memory' ? 1000 : 100),
  /** recording opens a visible browser on the server machine; set true on servers without a display */
  recorderHeadless: bool(process.env.LT_RECORDER_HEADLESS, false),
  /** browser used for recording: chrome (installed Google Chrome, default), msedge, or chromium (Playwright's bundled one) */
  recorderBrowser: (process.env.LT_RECORDER_BROWSER ?? 'chrome').trim().toLowerCase() || 'chrome',
  /** live browser recording needs a desktop session; disable it on display-less servers (HAR import still works) */
  recorderEnabled: bool(process.env.LT_RECORDER_ENABLED, true),
  /** how long run data stays in Redis after results are persisted */
  redisRunTtlSec: num(process.env.LT_REDIS_RUN_TTL_SEC, 24 * 3600),
  maxUploadMb: num(process.env.LT_MAX_UPLOAD_MB, 50),
};
