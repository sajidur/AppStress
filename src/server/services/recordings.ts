import type { FastifyBaseLogger } from 'fastify';
import { API_TYPES, RecordingSession, type ExchangeSummary } from '../../recorder/recorder.js';
import type { Recording } from '../../types.js';
import { errorMessage } from '../../util.js';
import type { Store } from '../db.js';
import type { EventHub } from '../events.js';
import { HttpError } from './helpers.js';

export const recordingTopic = (testId: string) => `recording:${testId}`;

/** Manages live browser recording sessions (at most one per test). */
export class RecordingService {
  private sessions = new Map<string, RecordingSession>();

  constructor(
    private readonly store: Store,
    private readonly hub: EventHub,
    private readonly log: FastifyBaseLogger,
    private readonly headless: boolean,
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
    const session = RecordingSession.start({ url, headless: this.headless, timeoutSec });
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
        const hint = /Executable doesn't exist|browserType.launch|distribution .chrome. is not found/i.test(errorMessage(e))
          ? ' — install Google Chrome on the server (https://www.google.com/chrome) and try again'
          : '';
        this.hub.publish(topic, { type: 'failed', error: errorMessage(e) + hint });
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
