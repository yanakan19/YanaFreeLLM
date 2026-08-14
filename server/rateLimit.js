// Deliberately tiny in-memory fixed-window rate limiter.
//
// This app is meant to be self-hosted as a single process, so a shared
// store (Redis etc.) would be more moving parts than the problem deserves.
// The point here is only to stop one client from fanning a question out to
// 28 upstream models in a loop and burning the free-tier quota.
//
// Consequence of being in-memory: limits reset on restart and are per
// process, not per cluster. If you ever run more than one instance, put a
// real limiter in front of it instead of scaling this one.

/**
 * @param {object} opts
 * @param {number} opts.windowMs   length of the fixed window
 * @param {number} opts.max        allowed requests per key per window
 * @param {() => number} [opts.now] injectable clock (tests)
 */
export function createRateLimiter({ windowMs, max, now = Date.now }) {
  if (!(windowMs > 0)) throw new Error('windowMs must be > 0');
  if (!(max > 0)) throw new Error('max must be > 0');

  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();

  function sweep(t) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= t) buckets.delete(key);
    }
  }

  /**
   * Records a hit for `key`.
   * @returns {{ allowed: boolean, remaining: number, retryAfterSeconds: number, resetAt: number }}
   */
  function hit(key) {
    const t = now();
    // Cheap amortised cleanup: buckets are only ever created on a request,
    // so sweeping occasionally is enough to keep the map bounded.
    if (buckets.size > 1000) sweep(t);

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const allowed = bucket.count <= max;
    return {
      allowed,
      remaining: Math.max(0, max - bucket.count),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - t) / 1000)),
      resetAt: bucket.resetAt,
    };
  }

  return {
    hit,
    max,
    windowMs,
    reset: () => buckets.clear(),
    get size() {
      return buckets.size;
    },
  };
}
