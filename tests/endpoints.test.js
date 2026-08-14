// Boots the real express app on an ephemeral port and hits it over HTTP —
// no supertest, no new dependency. Covers the liveness/readiness split that
// the Docker HEALTHCHECK depends on.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../server/index.js';

let base;
let server;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('GET /api/live', () => {
  it('reports the process as alive regardless of router configuration', async () => {
    const res = await fetch(`${base}/api/live`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('never reports the configuration state — a restart cannot fix that', async () => {
    const body = await (await fetch(`${base}/api/live`)).json();
    expect(body).not.toHaveProperty('configured');
    expect(body).not.toHaveProperty('agentCount');
  });
});

describe('GET /api/health', () => {
  // No router env vars are set in the test process, so readiness is expected
  // to be false here — the point is that it says so instead of claiming ok.
  it('reports readiness, including real router reachability', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.configured).toBe('boolean');
    expect(typeof body.agentCount).toBe('number');
    expect(body.routerReachable).toBe(false);
    expect(typeof body.routerCheckedAt).toBe('string');
    expect(body.routerErrorCode).toBe('not_configured');
  });
});

describe('GET /api/config', () => {
  it('exposes the message cap to the UI', async () => {
    const body = await (await fetch(`${base}/api/config`)).json();
    expect(body.maxMessageChars).toBeGreaterThan(0);
  });
});

describe('POST /api/chat — error surface', () => {
  const post = (body, raw = false) =>
    fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ? body : JSON.stringify(body),
    });

  it('rejects malformed JSON with 400 invalid_json', async () => {
    const res = await post('{not json', true);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_json');
  });

  it('rejects a missing message with 400', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_message');
  });

  it('rejects an over-long message with 413', async () => {
    const res = await post({ message: 'x'.repeat(50_000) });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('message_too_long');
  });

  it('returns JSON, not HTML, for unknown /api paths', async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
  });

  it('does not leak the express fingerprint', async () => {
    const res = await fetch(`${base}/api/live`);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});
