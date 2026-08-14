import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../server/rateLimit.js';

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('createRateLimiter', () => {
  it('rejects nonsensical options', () => {
    expect(() => createRateLimiter({ windowMs: 0, max: 1 })).toThrow();
    expect(() => createRateLimiter({ windowMs: 100, max: 0 })).toThrow();
  });

  it('allows up to max requests in a window and blocks the next', () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ windowMs: 1000, max: 3, now: clock.now });
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
  });

  it('reports remaining allowance', () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 2, now: fakeClock().now });
    expect(rl.hit('a').remaining).toBe(1);
    expect(rl.hit('a').remaining).toBe(0);
    expect(rl.hit('a').remaining).toBe(0);
  });

  it('tracks keys independently', () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 1, now: fakeClock().now });
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('b').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
  });

  it('resets once the window elapses', () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ windowMs: 1000, max: 1, now: clock.now });
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
    clock.advance(1001);
    expect(rl.hit('a').allowed).toBe(true);
  });

  it('returns a retryAfterSeconds of at least 1', () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ windowMs: 1000, max: 1, now: clock.now });
    rl.hit('a');
    clock.advance(999);
    const r = rl.hit('a');
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBe(1);
  });

  it('sweeps expired buckets so the map stays bounded', () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ windowMs: 1000, max: 5, now: clock.now });
    for (let i = 0; i < 1001; i++) rl.hit(`k${i}`);
    expect(rl.size).toBeGreaterThan(0);
    clock.advance(1001);
    for (let i = 0; i < 1001; i++) rl.hit(`n${i}`);
    expect(rl.size).toBeLessThanOrEqual(1002);
  });

  it('can be cleared', () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 1, now: fakeClock().now });
    rl.hit('a');
    rl.reset();
    expect(rl.size).toBe(0);
    expect(rl.hit('a').allowed).toBe(true);
  });
});
