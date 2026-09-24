/**
 * Log-scale latency buckets (~2.5% relative error). Bucket counts are additive,
 * so every worker can HINCRBY them in Redis and percentiles are computed from
 * the merged histogram.
 */
const GROWTH = 1.05;
const LOG_GROWTH = Math.log(GROWTH);

export function bucketOf(ms: number): number {
  return ms <= 1 ? 0 : Math.ceil(Math.log(ms) / LOG_GROWTH);
}

/** Representative value (geometric midpoint) of a bucket. */
export function bucketValue(bucket: number): number {
  return bucket === 0 ? 1 : Math.pow(GROWTH, bucket - 0.5);
}

export function percentiles(buckets: Map<number, number>, ps: number[], maxMs?: number): number[] {
  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, [, c]) => s + c, 0);
  if (!total) return ps.map(() => 0);
  return ps.map((p) => {
    const rank = Math.max(1, Math.ceil((p / 100) * total));
    let seen = 0;
    for (const [bucket, count] of sorted) {
      seen += count;
      if (seen >= rank) {
        const v = bucketValue(bucket);
        return maxMs !== undefined ? Math.min(v, maxMs) : v;
      }
    }
    return maxMs ?? 0;
  });
}
