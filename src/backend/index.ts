import { config } from '../config.js';
import { createMemoryBackend } from './memory.js';
import { RabbitQueue } from './rabbitmq.js';
import { RedisState } from './redis.js';
import type { Backend, BackendMode } from './types.js';

export type { Backend, BackendMode } from './types.js';

/**
 * memory:      queue + state in this process. No Redis/RabbitMQ needed; load is generated
 *              by this process only (the embedded worker).
 * distributed: RabbitMQ distributes virtual users to any number of worker processes,
 *              Redis holds shared state and metrics.
 */
export function createBackend(mode: BackendMode = config.mode): Backend {
  if (mode === 'memory') return createMemoryBackend();
  const state = new RedisState();
  const queue = new RabbitQueue();
  return {
    mode: 'distributed',
    state,
    queue,
    close: async () => {
      await queue.close();
      await state.close();
    },
  };
}
