import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { resolveTrustProxy, resolveClientIpHeader, resolveClientIp } from '../server/clientIp.js';
import { createRateLimiter } from '../server/rateLimit.js';

// These go over a real socket to a real express app rather than mocking `req`,
// because the thing under test is largely express's own X-Forwarded-For walk —
// a hand-built fake request would only prove that the mock matches the belief
// being tested.
function startApp({ trustProxy, clientIpHeader = null, max = 2 }) {
  const limiter = createRateLimiter({ windowMs: 60_000, max });
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/probe', (req, res) => {
    const key = resolveClientIp(req, { trustProxy, clientIpHeader });
    const limit = limiter.hit(key);
    res.json({ key, allowed: limit.allowed, remaining: limit.remaining });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const get = async (base, headers) => (await fetch(`${base}/probe`, { headers })).json();

// What Fly.io's proxy actually hands the app: it appends the real client and
// then the app's own anycast address, so the header ends "<client>, <fly-ip>",
// and anything the client sent itself is left sitting in front of that.
const FLY_APP_IP = '66.241.124.9';
const REAL_CLIENT = '203.0.113.77';
const SPOOFED = '198.51.100.1';
const flyXff = (clientSent) => [clientSent, REAL_CLIENT, FLY_APP_IP].filter(Boolean).join(', ');

describe('resolveTrustProxy', () => {
  const quiet = () => {};

  it('trusts nothing when unset or explicitly disabled', () => {
    for (const v of [undefined, null, '', '   ', 'false', 'FALSE', 'off', 'no']) {
      expect(resolveTrustProxy(v, quiet)).toBe(false);
    }
  });

  it('reads a hop count as a number, not a string', () => {
    expect(resolveTrustProxy('1', quiet)).toBe(1);
    expect(resolveTrustProxy('2', quiet)).toBe(2);
    expect(resolveTrustProxy('0', quiet)).toBe(0);
  });

  it('passes named presets and address lists through', () => {
    expect(resolveTrustProxy('loopback', quiet)).toBe('loopback');
    expect(resolveTrustProxy('10.0.0.0/8, 127.0.0.1', quiet)).toBe('10.0.0.0/8, 127.0.0.1');
  });

  it('warns when told to trust everything', () => {
    const warnings = [];
    expect(resolveTrustProxy('true', (m) => warnings.push(m))).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/spoof/i);
  });
});

describe('resolveClientIpHeader', () => {
  it('normalises to a lowercased header name', () => {
    expect(resolveClientIpHeader('Fly-Client-IP')).toBe('fly-client-ip');
  });

  it('treats unset and disabled values as absent', () => {
    for (const v of [undefined, null, '', ' ', 'false', 'off', 'no', '0']) {
      expect(resolveClientIpHeader(v)).toBeNull();
    }
  });
});

describe('client IP resolution over a real connection', () => {
  describe('local dev (trust proxy off)', () => {
    let app;
    beforeAll(async () => {
      app = await startApp({ trustProxy: false });
    });
    afterAll(() => app.close());

    it('ignores a spoofed X-Forwarded-For and uses the real connection IP', async () => {
      const spoofed = await get(app.base, { 'X-Forwarded-For': SPOOFED });
      const plain = await get(app.base, {});
      expect(spoofed.key).toMatch(/127\.0\.0\.1$/);
      expect(spoofed.key).not.toContain(SPOOFED);
      expect(plain.key).toBe(spoofed.key);
    });

    it('ignores a spoofed platform client-IP header too', async () => {
      const r = await get(app.base, { 'Fly-Client-IP': SPOOFED });
      expect(r.key).not.toContain(SPOOFED);
    });

    it('so a client rotating X-Forwarded-For cannot escape the rate limit', async () => {
      const fresh = await startApp({ trustProxy: false, max: 2 });
      const results = [];
      for (const fake of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
        results.push(await get(fresh.base, { 'X-Forwarded-For': fake }));
      }
      expect(results.map((r) => r.allowed)).toEqual([true, true, false]);
      expect(new Set(results.map((r) => r.key)).size).toBe(1);
      await fresh.close();
    });
  });

  describe('production on Fly (trust proxy = 2 hops)', () => {
    let app;
    beforeAll(async () => {
      app = await startApp({ trustProxy: 2 });
    });
    afterAll(() => app.close());

    it('walks in exactly two hops to the real client', async () => {
      const r = await get(app.base, { 'X-Forwarded-For': flyXff(null) });
      expect(r.key).toBe(REAL_CLIENT);
    });

    it('is not fooled by an entry the client prepended', async () => {
      const r = await get(app.base, { 'X-Forwarded-For': flyXff(SPOOFED) });
      expect(r.key).toBe(REAL_CLIENT);
      expect(r.key).not.toBe(SPOOFED);
    });

    it('is not fooled by a long prepended chain either', async () => {
      const chain = ['9.9.9.9', '8.8.8.8', '7.7.7.7'].join(', ');
      const r = await get(app.base, { 'X-Forwarded-For': `${chain}, ${REAL_CLIENT}, ${FLY_APP_IP}` });
      expect(r.key).toBe(REAL_CLIENT);
    });

    it('gives two different clients two different buckets', async () => {
      const fresh = await startApp({ trustProxy: 2, max: 1 });
      const a = await get(fresh.base, { 'X-Forwarded-For': `1.2.3.4, ${FLY_APP_IP}` });
      const b = await get(fresh.base, { 'X-Forwarded-For': `5.6.7.8, ${FLY_APP_IP}` });
      const aAgain = await get(fresh.base, { 'X-Forwarded-For': `1.2.3.4, ${FLY_APP_IP}` });
      expect([a.allowed, b.allowed, aAgain.allowed]).toEqual([true, true, false]);
      await fresh.close();
    });

    it('regression: one hop would key on Fly\'s own address, collapsing everyone into one bucket', async () => {
      const oneHop = await startApp({ trustProxy: 1, max: 5 });
      const a = await get(oneHop.base, { 'X-Forwarded-For': `1.2.3.4, ${FLY_APP_IP}` });
      const b = await get(oneHop.base, { 'X-Forwarded-For': `5.6.7.8, ${FLY_APP_IP}` });
      expect(a.key).toBe(FLY_APP_IP);
      expect(a.key).toBe(b.key);
      await oneHop.close();
    });

    it('regression: trusting everything would hand the client its own spoofed value', async () => {
      const all = await startApp({ trustProxy: true, max: 5 });
      const r = await get(all.base, { 'X-Forwarded-For': flyXff(SPOOFED) });
      expect(r.key).toBe(SPOOFED);
      await all.close();
    });
  });

  describe('production with CLIENT_IP_HEADER=fly-client-ip', () => {
    let app;
    beforeAll(async () => {
      app = await startApp({ trustProxy: 2, clientIpHeader: 'fly-client-ip' });
    });
    afterAll(() => app.close());

    it('prefers the header the platform overwrites', async () => {
      const r = await get(app.base, {
        'Fly-Client-IP': REAL_CLIENT,
        'X-Forwarded-For': flyXff(SPOOFED),
      });
      expect(r.key).toBe(REAL_CLIENT);
    });

    it('makes the hop count non-load-bearing', async () => {
      // Even with a hop count that would otherwise land on the wrong entry.
      const misconfigured = await startApp({ trustProxy: 1, clientIpHeader: 'fly-client-ip' });
      const r = await get(misconfigured.base, {
        'Fly-Client-IP': REAL_CLIENT,
        'X-Forwarded-For': flyXff(SPOOFED),
      });
      expect(r.key).toBe(REAL_CLIENT);
      await misconfigured.close();
    });

    it('falls back to the X-Forwarded-For walk when the header is absent', async () => {
      const r = await get(app.base, { 'X-Forwarded-For': flyXff(SPOOFED) });
      expect(r.key).toBe(REAL_CLIENT);
    });
  });
});

describe('resolveClientIp fallbacks', () => {
  it('never returns an empty key', () => {
    const bare = { headers: {}, socket: {} };
    expect(resolveClientIp(bare, { trustProxy: false })).toBe('unknown');
    expect(resolveClientIp(bare, { trustProxy: 2 })).toBe('unknown');
  });

  it('takes the first entry of a duplicated platform header', () => {
    const req = { headers: { 'fly-client-ip': [REAL_CLIENT, SPOOFED] }, socket: {} };
    expect(resolveClientIp(req, { trustProxy: 2, clientIpHeader: 'fly-client-ip' })).toBe(REAL_CLIENT);
  });

  it('treats trust proxy 0 the same as off', () => {
    const req = { headers: { 'fly-client-ip': SPOOFED }, ip: SPOOFED, socket: { remoteAddress: '10.0.0.1' } };
    expect(resolveClientIp(req, { trustProxy: 0, clientIpHeader: 'fly-client-ip' })).toBe('10.0.0.1');
  });
});
