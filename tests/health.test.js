import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';

const { app, ROUTER_HEALTH_TTL_MS, resetRouterHealthCache } = await import('../server/index.js');

// Captured before any stubbing: the tests stub globalThis.fetch to intercept
// the app's OUTBOUND router probe, so the test's own inbound requests must go
// through the untouched implementation.
const realFetch = globalThis.fetch;

/** Boots the express app on an ephemeral port and returns GET helpers. */
async function withServer(fn) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(async (path) => {
      const res = await realFetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, body: await res.json() };
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function routerResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({ data: [] }),
    text: async () => '{"data":[]}',
  };
}

const originalEnv = { ...process.env };

beforeEach(() => {
  resetRouterHealthCache();
  vi.stubGlobal('fetch', vi.fn());
  process.env.FREELLMAPI_BASE_URL = 'http://router.test';
  process.env.FREELLMAPI_API_KEY = 'key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...originalEnv };
  resetRouterHealthCache();
});

describe('GET /api/health', () => {
  it('reports ok when the router answers', async () => {
    globalThis.fetch.mockResolvedValue(routerResponse(200));

    const { status, body } = await withServer((get) => get('/api/health'));

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.configured).toBe(true);
    expect(body.routerReachable).toBe(true);
    expect(body.agentCount).toBeGreaterThan(0);
    expect(Date.parse(body.routerCheckedAt)).not.toBeNaN();
    expect(body.routerError).toBeUndefined();
  });

  it('probes GET /v1/models with the Authorization header, not a chat completion', async () => {
    globalThis.fetch.mockResolvedValue(routerResponse(200));

    await withServer((get) => get('/api/health'));

    // The app's own request is made through the real server; the stub only
    // sees the outbound router call.
    const [url, init] = globalThis.fetch.mock.calls.at(-1);
    expect(url).toBe('http://router.test/v1/models');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer key');
    expect(init.body).toBeUndefined();
  });

  it('reports ok:false with a reason when the router is unreachable', async () => {
    const err = new TypeError('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    globalThis.fetch.mockRejectedValue(err);

    const { status, body } = await withServer((get) => get('/api/health'));

    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.routerReachable).toBe(false);
    expect(body.routerErrorCode).toBe('network_error');
    expect(body.routerError).toMatch(/fetch failed/);
    // Config was fine — callers can still tell the two failures apart.
    expect(body.configured).toBe(true);
  });

  it('reports ok:false when the router times out', async () => {
    globalThis.fetch.mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    );
    process.env.ROUTER_PROBE_TIMEOUT_MS = '20';
    // probeRouter reads the env-derived default at module load, so drive the
    // abort explicitly rather than relying on a re-read.
    const { probeRouter } = await import('../server/freellmapiClient.js');
    const result = await probeRouter({ baseUrl: 'http://router.test', apiKey: 'k', timeoutMs: 20 });

    expect(result.reachable).toBe(false);
    expect(result.errorCode).toBe('timeout');
    expect(result.error).toMatch(/did not respond within 20ms/);
  });

  it('reports ok:false when the router rejects the key', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => 'unauthorized',
    });

    const { body } = await withServer((get) => get('/api/health'));

    expect(body.ok).toBe(false);
    expect(body.routerErrorCode).toBe('auth_failure');
  });

  it('does not contact the router at all when env vars are missing', async () => {
    delete process.env.FREELLMAPI_BASE_URL;
    delete process.env.FREELLMAPI_API_KEY;

    const { status, body } = await withServer((get) => get('/api/health'));

    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.configured).toBe(false);
    expect(body.routerReachable).toBe(false);
    expect(body.routerErrorCode).toBe('not_configured');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('serves repeat checks from cache without re-calling the router', async () => {
    globalThis.fetch.mockResolvedValue(routerResponse(200));

    const bodies = await withServer(async (get) => [
      (await get('/api/health')).body,
      (await get('/api/health')).body,
      (await get('/api/health')).body,
    ]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(bodies.every((b) => b.ok)).toBe(true);
    // A cached answer keeps the original probe timestamp.
    expect(bodies[1].routerCheckedAt).toBe(bodies[0].routerCheckedAt);
  });

  it('collapses concurrent checks into a single router call', async () => {
    globalThis.fetch.mockResolvedValue(routerResponse(200));

    await withServer(async (get) => {
      await Promise.all([get('/api/health'), get('/api/health'), get('/api/health')]);
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('re-probes once the TTL expires', async () => {
    globalThis.fetch.mockResolvedValue(routerResponse(200));

    await withServer(async (get) => {
      await get('/api/health');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      const realNow = Date.now;
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ROUTER_HEALTH_TTL_MS + 1);
      await get('/api/health');
      Date.now = realNow;
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('re-probes when the router is pointed somewhere new, ignoring the old result', async () => {
    globalThis.fetch.mockResolvedValue(routerResponse(200));

    await withServer(async (get) => {
      await get('/api/health');
      process.env.FREELLMAPI_BASE_URL = 'http://other-router.test';
      await get('/api/health');
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch.mock.calls.at(-1)[0]).toBe('http://other-router.test/v1/models');
  });
});

describe('GET /api/live', () => {
  it('stays ok even when the router is down, since a restart cannot fix that', async () => {
    globalThis.fetch.mockRejectedValue(new TypeError('fetch failed'));

    const { status, body } = await withServer((get) => get('/api/live'));

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
