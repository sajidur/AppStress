import type { FastifyBaseLogger } from 'fastify';
import { API_TYPES, RecordingSession, type ExchangeSummary } from '../../recorder/recorder.js';
import type { Recording } from '../../types.js';
import { errorMessage } from '../../util.js';
import type { Store } from '../db.js';
import type { EventHub } from '../events.js';
import { HttpError } from './helpers.js';

/** What to do about a failed recording, from the browser's own error message. Empty when nothing specific applies. */
export function recordingHint(message: string, browser = 'chrome'): string {
  const name = browser === 'msedge' ? 'Microsoft Edge' : browser === 'chromium' ? "Playwright's Chromium" : 'Google Chrome';
  if (/Timeout \d+ms exceeded/i.test(message) && /launch/i.test(message)) {
    return ` — ${name} did not start in time. Close other ${name} windows, check that antivirus is not blocking it, and try again.`;
  }
  if (/distribution .* is not found|Executable doesn't exist|Unsupported chromium channel/i.test(message)) {
    return browser === 'chromium'
      ? ' — run "npx playwright install chromium" on the machine that runs the studio'
      : ` — ${name} was not found on the machine that runs the studio (the browser opens there). Install it, or set LT_RECORDER_BROWSER=chromium and run "npx playwright install chromium".`;
  }
  if (/has been closed|Target closed|Browser closed/i.test(message)) return ' — the browser window was closed before recording could start.';
  if (/EPERM|EACCES|ENOSPC/i.test(message)) return ' — the studio cannot write to the temporary folder it uses for the browser profile.';
  if (/Missing X server|\$DISPLAY|headed browser/i.test(message)) return ' — this machine has no display. Set LT_RECORDER_HEADLESS=true, or record elsewhere and import the file.';
  return '';
}

export const recordingTopic = (testId: string) => `recording:${testId}`;

/** Manages live browser recording sessions (at most one per test). */
export class RecordingService {
  private sessions = new Map<string, RecordingSession>();

  constructor(
    private readonly store: Store,
    private readonly hub: EventHub,
    private readonly log: FastifyBaseLogger,
    private readonly headless: boolean,
    private readonly browser: string = 'chrome',
  ) {}

  isActive(testId: string): boolean {
    return this.sessions.has(testId);
  }

  /** Events to replay to a client that connects mid-recording. */
  backlog(testId: string): object[] {
    const s = this.sessions.get(testId);
    if (!s) return [{ type: 'idle' }];
    return [{ type: 'started' }, ...s.summaries.map((e) => ({ type: 'exchange', exchange: e }))];
  }

  start(testId: string, url: string, timeoutSec?: number): void {
    if (this.sessions.has(testId)) throw new HttpError(409, 'A recording is already in progress for this test');
    const session = RecordingSession.start({ url, headless: this.headless, browser: this.browser, timeoutSec });
    this.sessions.set(testId, session);
    const topic = recordingTopic(testId);
    this.hub.publish(topic, { type: 'started' });
    session.on('exchange', (e: ExchangeSummary) => this.hub.publish(topic, { type: 'exchange', exchange: e }));

    session.done
      .then((rec: Recording) => {
        const apiCount = rec.exchanges.filter((e) => API_TYPES.includes(e.resourceType)).length;
        this.store.saveRecording(testId, rec, apiCount, 'browser');
        this.log.info({ testId, exchanges: rec.exchanges.length, apiCount }, 'recording saved');
        this.hub.publish(topic, { type: 'finished', exchangeCount: rec.exchanges.length, apiCount });
      })
      .catch((e) => {
        this.log.error({ testId, err: errorMessage(e) }, 'recording failed');
        this.hub.publish(topic, { type: 'failed', error: errorMessage(e) + recordingHint(errorMessage(e), this.browser) });
      })
      .finally(() => this.sessions.delete(testId));
  }

  stop(testId: string): void {
    const s = this.sessions.get(testId);
    if (!s) throw new HttpError(404, 'No recording in progress');
    s.stop();
  }

  async stopAll(): Promise<void> {
    const all = [...this.sessions.values()];
    all.forEach((s) => s.stop());
    await Promise.allSettled(all.map((s) => s.done));
  }
}
