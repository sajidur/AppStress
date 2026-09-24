import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type BrowserContext, type Page, type Request } from 'playwright';
import type { RecordedExchange, Recording, TypedInput } from '../types.js';
import { addTyped, TYPED_INPUT_SCRIPT } from './typed-inputs.js';
import { errorMessage, log, sleep } from '../util.js';

export interface RecordOptions {
  url: string;
  userFields?: Record<string, string>;
  headless?: boolean;
  /** chrome (installed Google Chrome, default), msedge, or chromium (Playwright's bundled browser) */
  browser?: string;
  /** stop automatically after N seconds (otherwise: close the browser or call stop()) */
  timeoutSec?: number;
  /** optional: automate the flow instead of clicking manually (module exporting default async (page, userFields) => {}) */
  script?: string;
}

/** Light-weight view of a captured exchange, streamed to the UI while recording. */
export interface ExchangeSummary {
  id: number;
  at: number;
  method: string;
  url: string;
  status?: number;
  resourceType: string;
  durationMs: number;
  failure?: string;
}

/**
 * Wrap a Playwright event handler: an exception thrown inside an EventEmitter listener is
 * uncaught and would crash the whole server, so log it instead.
 */
function safe<A extends unknown[]>(what: string, fn: (...args: A) => void): (...args: A) => void {
  return (...args: A) => {
    try {
      fn(...args);
    } catch (e) {
      log('record', `${what} handler error: ${errorMessage(e)}`);
    }
  };
}

/** URL of the page that issued the request ('' for service-worker or detached requests). */
function pageUrlOf(req: Request): string {
  try {
    return req.serviceWorker() ? '' : (req.frame().page()?.url() ?? '');
  } catch {
    return ''; // Playwright throws for requests without a frame
  }
}

const TEXT_MIME = /json|text|xml|html|x-www-form-urlencoded|graphql/i;
const MAX_BODY = 1024 * 1024;
export const API_TYPES = ['xhr', 'fetch', 'document'];

/**
 * A live recording: opens a real browser, captures every network exchange
 * (request, headers, body, response, timing) and page navigation until the
 * browser is closed, stop() is called, or the timeout elapses.
 *
 * Events: 'exchange' (ExchangeSummary), 'finished' (Recording), 'failed' (Error)
 */
export class RecordingSession extends EventEmitter {
  readonly summaries: ExchangeSummary[] = [];
  readonly done: Promise<Recording>;
  private finish!: () => void;
  private stopped = false;

  private constructor(private readonly opts: RecordOptions) {
    super();
    const finished = new Promise<void>((r) => (this.finish = r));
    this.done = this.run(finished);
    // Avoid unhandled rejections when nobody awaits `done`; errors are also emitted.
    this.done.catch(() => undefined);
  }

  static start(opts: RecordOptions): RecordingSession {
    return new RecordingSession(opts);
  }

  stop(): void {
    this.stopped = true;
    this.finish();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private async run(finished: Promise<void>): Promise<Recording> {
    let context: BrowserContext | undefined;
    let profileDir: string | undefined;
    const cleanup = async () => {
      await context?.close().catch(() => undefined);
      if (profileDir) rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
    };
    try {
      // A persistent (on-disk) profile rather than browser.newContext(): the latter is an ephemeral,
      // incognito-like session that many apps detect (tiny storage quota) and then lock their login form.
      profileDir = mkdtempSync(join(tmpdir(), 'lt-record-'));
      context = await chromium.launchPersistentContext(profileDir, {
        // The installed Google Chrome by default (not Playwright's bundled Chromium): some apps only accept real Chrome.
        ...((this.opts.browser ?? 'chrome') === 'chromium' ? {} : { channel: this.opts.browser ?? 'chrome' }),
        // a first start with a fresh profile can be slow on a busy or virus-scanned PC
        timeout: 120_000,
        headless: this.opts.headless ?? false,
        // Service workers are blocked so every request is issued (and captured) by the page itself;
        // otherwise requests served by a worker are invisible or have no page attached.
        ignoreHTTPSErrors: true,
        viewport: null,
        serviceWorkers: 'block',
      });
      // remember what is typed into the page's fields, so each value can later be followed to the requests that carry it
      const typedInputs: TypedInput[] = [];
      await context.exposeBinding('__ltTyped', (_src, d: Omit<TypedInput, 'at'>) => addTyped(typedInputs, d));
      await context.addInitScript(TYPED_INPUT_SCRIPT);
      const page = context.pages()[0] ?? (await context.newPage());
      const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);

      const exchanges: RecordedExchange[] = [];
      const navigations: Recording['navigations'] = [];
      const pending = new Set<Promise<void>>();
      const startTimes = new WeakMap<Request, number>();
      const pageUrlAtStart = new WeakMap<Request, string>();
      let seq = 0;

      context.on(
        'request',
        safe('request', (req: Request) => {
          startTimes.set(req, Date.now());
          pageUrlAtStart.set(req, pageUrlOf(req));
        }),
      );

      const capture = (req: Request, failure?: string) => {
        const url = req.url();
        if (!/^https?:/i.test(url)) return;
        const task = (async () => {
          const startedAt = startTimes.get(req) ?? Date.now();
          const ex: RecordedExchange = {
            id: ++seq,
            startedAt,
            durationMs: Date.now() - startedAt,
            pageUrl: pageUrlAtStart.get(req) ?? '',
            resourceType: req.resourceType(),
            request: {
              method: req.method(),
              url,
              headers: await req.allHeaders().catch(() => req.headers()),
              postData: req.postData() ?? undefined,
            },
            failure,
          };
          const res = failure ? null : await req.response().catch(() => null);
          if (res) {
            const headers = await res.allHeaders().catch(() => res.headers());
            const mimeType = headers['content-type'] ?? '';
            let body: string | undefined;
            if (TEXT_MIME.test(mimeType) && req.resourceType() !== 'script' && req.resourceType() !== 'stylesheet') {
              const buf = await res.body().catch(() => null);
              if (buf && buf.length <= MAX_BODY) body = buf.toString('utf8');
            }
            ex.response = { status: res.status(), headers, body, mimeType };
          }
          exchanges.push(ex);
          const summary: ExchangeSummary = {
            id: ex.id,
            at: ex.startedAt,
            method: ex.request.method,
            url,
            status: ex.response?.status,
            resourceType: ex.resourceType,
            durationMs: ex.durationMs,
            failure,
          };
          this.summaries.push(summary);
          this.emit('exchange', summary);
        })().catch((e) => log('record', 'capture error', errorMessage(e)));
        pending.add(task);
        task.finally(() => pending.delete(task));
      };

      context.on('requestfinished', safe('requestfinished', (req: Request) => capture(req)));
      context.on('requestfailed', safe('requestfailed', (req: Request) => capture(req, req.failure()?.errorText ?? 'failed')));

      // Requests still in flight when recording ends would be lost (or recorded as aborted): wait for them to settle.
      let inflight = 0;
      let contextClosed = false;
      context.on('request', () => inflight++);
      context.on('requestfinished', () => inflight--);
      context.on('requestfailed', () => inflight--);
      const settle = async (maxMs: number) => {
        const until = Date.now() + maxMs;
        while (inflight > 0 && !contextClosed && Date.now() < until) await sleep(50);
        if (!contextClosed) await sleep(150); // let the finished/failed handlers start their captures
      };

      const trackPage = (p: Page) => {
        p.on(
          'framenavigated',
          safe('framenavigated', (frame) => {
            if (frame === p.mainFrame()) navigations.push({ url: frame.url(), at: Date.now() });
          }),
        );
        // Finish when the user closes the last tab/window.
        p.on('close', safe('close', () => setTimeout(() => context?.pages().length === 0 && this.finish(), 300)));
      };
      trackPage(page);
      context.on('page', safe('page', trackPage));
      context.on('close', () => {
        contextClosed = true;
        this.finish();
      });
      const timer = this.opts.timeoutSec ? setTimeout(() => this.finish(), this.opts.timeoutSec * 1000) : undefined;

      log('record', `Opening ${this.opts.url}`);
      await page.goto(this.opts.url, { waitUntil: 'domcontentloaded' }).catch((e) => {
        log('record', `navigation warning: ${errorMessage(e)}`);
      });

      if (this.opts.script) {
        const mod = await import(pathToFileURL(resolve(this.opts.script)).href);
        log('record', `Running flow script ${this.opts.script}`);
        await mod.default(page, this.opts.userFields ?? {});
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await settle(8000);
        this.finish();
      }

      await finished;
      if (timer) clearTimeout(timer);
      await settle(3000);
      await Promise.allSettled([...pending]);
      await cleanup();

      exchanges.sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
      const recording: Recording = {
        version: 1,
        startUrl: this.opts.url,
        recordedAt: new Date().toISOString(),
        userAgent,
        navigations,
        exchanges,
        userFields: this.opts.userFields,
        typedInputs,
      };
      this.emit('finished', recording);
      return recording;
    } catch (e) {
      await cleanup();
      const err = e instanceof Error ? e : new Error(String(e));
      this.emit('failed', err);
      throw err;
    }
  }
}

/** CLI helper: record until the browser closes / Ctrl+C, then write the file. */
export async function record(opts: RecordOptions & { out: string }): Promise<Recording> {
  const session = RecordingSession.start(opts);
  session.on('exchange', (s: ExchangeSummary) => {
    if (API_TYPES.includes(s.resourceType)) log('record', `${s.method} ${s.status ?? s.failure ?? '-'} ${s.url}`);
  });
  const onSigint = () => {
    log('record', 'Ctrl+C received, saving recording...');
    session.stop();
  };
  process.once('SIGINT', onSigint);
  if (!opts.script) log('record', 'Perform the business flow in the browser. Close the browser window (or press Ctrl+C) to finish.');
  const recording = await session.done;
  process.off('SIGINT', onSigint);
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(recording, null, 2));
  const api = recording.exchanges.filter((e) => API_TYPES.includes(e.resourceType)).length;
  log('record', `Saved ${recording.exchanges.length} exchanges (${api} document/xhr/fetch) to ${opts.out}`);
  return recording;
}
