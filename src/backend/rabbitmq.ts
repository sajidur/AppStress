import amqp, { type Channel, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { config } from '../config.js';
import type { VuJob } from '../types.js';
import { errorMessage, log, sleep } from '../util.js';
import type { JobDelivery, JobQueue } from './types.js';

/**
 * RabbitMQ job queue.
 *  - publish: persistent messages with publisher confirms (a job counts as sent only once the broker stored it)
 *  - consume: prefetch-limited consumer that reconnects with backoff; when a connection dies,
 *    its in-flight deliveries report lost() and the broker redelivers them to other workers
 */
export class RabbitQueue implements JobQueue {
  readonly kind = 'rabbitmq' as const;
  private pubConnection?: ChannelModel;
  private pubChannel?: ConfirmChannel;
  private pubConnecting?: Promise<ConfirmChannel>;
  private consumers = new Set<{ close(): Promise<void> }>();

  constructor(private readonly url = config.amqpUrl) {}

  /* ---------------------------------------------------------------- publishing */

  private async publisher(): Promise<ConfirmChannel> {
    if (this.pubChannel) return this.pubChannel;
    this.pubConnecting ??= (async () => {
      try {
        // Retry briefly: a broker that was just (re)started may refuse connections for a few seconds.
        let connection: ChannelModel | undefined;
        for (let attempt = 1; !connection; attempt++) {
          try {
            connection = await amqp.connect(this.url, { clientProperties: { connection_name: 'lt-controller' } });
          } catch (e) {
            if (attempt >= 5) throw e;
            await sleep(500 * 2 ** attempt);
          }
        }
        const channel = await connection.createConfirmChannel();
        await channel.assertQueue(config.jobQueue, { durable: true });
        const reset = () => {
          this.pubChannel = undefined;
          this.pubConnection = undefined;
        };
        connection.on('error', (e) => log('amqp', `connection error: ${errorMessage(e)}`));
        connection.on('close', reset);
        channel.on('error', (e) => log('amqp', `channel error: ${errorMessage(e)}`));
        channel.on('close', reset);
        this.pubConnection = connection;
        this.pubChannel = channel;
        return channel;
      } finally {
        this.pubConnecting = undefined;
      }
    })();
    return this.pubConnecting;
  }

  async publish(jobs: VuJob[]) {
    const channel = await this.publisher();
    for (let i = 0; i < jobs.length; i++) {
      const ok = channel.sendToQueue(config.jobQueue, Buffer.from(JSON.stringify(jobs[i])), { persistent: true, contentType: 'application/json' });
      if (!ok) await new Promise((r) => channel.once('drain', r));
      if (i % 1000 === 999) await channel.waitForConfirms();
    }
    await channel.waitForConfirms();
  }

  async info() {
    const channel = await this.publisher();
    const q = await channel.checkQueue(config.jobQueue);
    return { messages: q.messageCount, consumers: q.consumerCount };
  }

  /* ---------------------------------------------------------------- consuming */

  async consume(prefetch: number, onJob: (d: JobDelivery) => void, opts: { name?: string; onStatus?: (connected: boolean) => void } = {}) {
    const name = opts.name ?? 'lt-worker';
    let cancelled = false;
    let generation = 0;
    let connection: ChannelModel | undefined;
    let channel: Channel | undefined;
    let consumerTag: string | undefined;

    const connectOnce = async () => {
      const conn = await amqp.connect(this.url, { clientProperties: { connection_name: name } });
      const ch = await conn.createChannel();
      await ch.assertQueue(config.jobQueue, { durable: true });
      await ch.prefetch(prefetch);
      const gen = ++generation;
      const onLost = (why: string) => {
        if (gen !== generation || cancelled) return;
        generation++; // in-flight deliveries of this connection are now lost; the broker requeues them
        opts.onStatus?.(false);
        log('amqp', `${name}: broker connection lost (${why}); reconnecting`);
        void connectLoop();
      };
      conn.on('error', (e) => log('amqp', `${name}: connection error: ${errorMessage(e)}`));
      conn.on('close', () => onLost('connection closed'));
      ch.on('error', (e) => log('amqp', `${name}: channel error: ${errorMessage(e)}`));
      ch.on('close', () => onLost('channel closed'));
      connection = conn;
      channel = ch;
      const res = await ch.consume(
        config.jobQueue,
        (msg) => {
          if (!msg) return;
          let job: VuJob;
          try {
            job = JSON.parse(msg.content.toString());
          } catch {
            ch.ack(msg); // poison message
            return;
          }
          const lost = () => gen !== generation;
          const safe = (fn: () => void) => {
            if (lost()) return;
            try {
              fn();
            } catch (e) {
              log('amqp', `${name}: ack failed: ${errorMessage(e)}`);
            }
          };
          onJob({ job, ack: () => safe(() => ch.ack(msg)), requeue: () => safe(() => ch.nack(msg, false, true)), lost });
        },
        { noAck: false },
      );
      consumerTag = res.consumerTag;
      opts.onStatus?.(true);
    };

    const connectLoop = async () => {
      let delay = 1000;
      while (!cancelled) {
        try {
          await connectOnce();
          return;
        } catch (e) {
          log('amqp', `${name}: RabbitMQ connect failed (${errorMessage(e)}), retrying in ${delay / 1000}s`);
          await sleep(delay);
          delay = Math.min(delay * 2, 30_000);
        }
      }
    };

    const handle = {
      close: async () => {
        await channel?.close().catch(() => undefined);
        await connection?.close().catch(() => undefined);
      },
    };
    this.consumers.add(handle);
    await connectLoop();

    return {
      /** Stop receiving new jobs; in-flight deliveries can still be acked/requeued until close(). */
      cancel: async () => {
        cancelled = true;
        if (channel && consumerTag) await channel.cancel(consumerTag).catch(() => undefined);
      },
    };
  }

  async close() {
    for (const c of this.consumers) await c.close();
    this.consumers.clear();
    await this.pubChannel?.close().catch(() => undefined);
    await this.pubConnection?.close().catch(() => undefined);
  }
}
