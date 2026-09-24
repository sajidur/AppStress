import type { FastifyReply, FastifyRequest } from 'fastify';

type Listener = (event: object) => void;

/** In-process pub/sub used to stream live recording and run progress to browsers. */
export class EventHub {
  private topics = new Map<string, Set<Listener>>();

  subscribe(topic: string, fn: Listener): () => void {
    let set = this.topics.get(topic);
    if (!set) this.topics.set(topic, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.topics.delete(topic);
    };
  }

  publish(topic: string, event: object): void {
    for (const fn of this.topics.get(topic) ?? []) {
      try {
        fn(event);
      } catch {
        /* a broken client must not affect others */
      }
    }
  }
}

/** Serve a Server-Sent Events stream for `topic`, starting with `initial` events. */
export function streamEvents(req: FastifyRequest, reply: FastifyReply, hub: EventHub, topic: string, initial: object[] = []): void {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (e: object) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  for (const e of initial) send(e);
  const unsubscribe = hub.subscribe(topic, send);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.raw.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}
