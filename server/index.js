import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { runCouncil } from './council.js';
import { createRateLimiter } from './rateLimit.js';
import { resolveTrustProxy, resolveClientIpHeader, resolveClientIp } from './clientIp.js';
import { probeRouter } from './freellmapiClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4000;

// A council question fans out to every configured model, so an oversized
// prompt is multiplied by ~28 upstream calls. Cap it well before that.
const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS) || 4000;
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '64kb';
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 10;

const chatLimiter = createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX });

// Behind a proxy (the Fly configs in deploy/fly put one in front), req.ip is
// the proxy's address unless express is told to trust it — which would collapse
// the per-IP rate limit into a single global bucket shared by every user. Off
// by default, because trusting X-Forwarded-For when nothing in front of us
// rewrites it lets a client spoof its IP straight past the limiter.
//
// On Fly.io set TRUST_PROXY=2. Fly's proxy appends *two* entries — the real
// client and the app's own anycast address — so X-Forwarded-For ends
// "..., <client>, <fly-app-ip>", and only a two-hop walk in from the right
// lands on the client. Whatever a client prepended stays out of reach.
// See resolveTrustProxy for the full set of accepted values.
const TRUST_PROXY = resolveTrustProxy(process.env.TRUST_PROXY);

// Belt and braces on top of the hop count: a header the platform overwrites on
// every request (Fly.io's is Fly-Client-IP) cannot be seeded by the client at
// all, so with it set the hop count stops being load-bearing. Only consulted
// when TRUST_PROXY is set — see resolveClientIp.
const CLIENT_IP_HEADER = resolveClientIpHeader(process.env.CLIENT_IP_HEADER);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
app.use(express.json({ limit: JSON_BODY_LIMIT }));

// express.json() throws on malformed/oversized bodies; without this handler
// those surface as an opaque 500 or an HTML error page.
app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'body_too_large', message: `Request body exceeds ${JSON_BODY_LIMIT}.` });
  }
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'invalid_json', message: 'Request body must be valid JSON.' });
  }
  return next(err);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

let agentModelsCache = null;

export async function loadAgentModels() {
  if (agentModelsCache) return agentModelsCache;
  const raw = await readFile(path.join(__dirname, 'config', 'agents.json'), 'utf8');
  const parsed = JSON.parse(raw);
  const models = (Array.isArray(parsed?.models) ? parsed.models : [])
    .filter((m) => typeof m === 'string' && m.trim())
    .slice(0, 28);
  agentModelsCache = models;
  return models;
}

function isConfigured() {
  return Boolean(process.env.FREELLMAPI_BASE_URL && process.env.FREELLMAPI_API_KEY);
}

// How long a real router probe is reused before we spend another one.
// The router is a SHARED resource — every app pointed at it draws on the same
// provider quota and rate-limit budget — and uptime monitors poll /api/health
// every 30s–5min, per monitor. Without this cache, monitoring alone would be a
// steady background load on the router. Tune here, not inline.
export const ROUTER_HEALTH_TTL_MS = Number(process.env.ROUTER_HEALTH_TTL_MS) || 45_000;

let routerHealthCache = null; // { key, checkedAt, reachable, error?, errorCode?, latencyMs? }
let routerProbeInFlight = null;

/** Test seam: drop the memoised probe result. */
export function resetRouterHealthCache() {
  routerHealthCache = null;
  routerProbeInFlight = null;
}

/**
 * Real router reachability, memoised for ROUTER_HEALTH_TTL_MS. Concurrent
 * callers share one in-flight probe, so a burst of health checks is still at
 * most one request to the router.
 */
async function checkRouterCached(now = Date.now()) {
  const baseUrl = process.env.FREELLMAPI_BASE_URL;
  const apiKey = process.env.FREELLMAPI_API_KEY;
  // Key on the target so a reconfigured router isn't judged by a stale probe.
  const key = `${baseUrl ?? ''}|${apiKey ? 'set' : 'unset'}`;

  if (!baseUrl || !apiKey) {
    return {
      reachable: false,
      checkedAt: now,
      error: 'FREELLMAPI_BASE_URL / FREELLMAPI_API_KEY are not set, so the router was not contacted.',
      errorCode: 'not_configured',
    };
  }

  if (routerHealthCache && routerHealthCache.key === key && now - routerHealthCache.checkedAt < ROUTER_HEALTH_TTL_MS) {
    return routerHealthCache;
  }
  if (routerProbeInFlight) return routerProbeInFlight;

  routerProbeInFlight = probeRouter({ baseUrl, apiKey })
    .then((result) => {
      routerHealthCache = { ...result, key, checkedAt: Date.now() };
      return routerHealthCache;
    })
    .finally(() => {
      routerProbeInFlight = null;
    });

  return routerProbeInFlight;
}

/** Wraps an async handler so a rejection becomes a clean 500, never a hang. */
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// Liveness only: "this process is up and serving HTTP". It deliberately
// checks nothing else, which is what makes it safe for a supervisor that
// RESTARTS the container on failure (the Docker HEALTHCHECK) — restarting
// cannot fix a down router or an empty agents.json, so those must not fail
// this endpoint. Use /api/health for readiness/config instead.
app.get('/api/live', (req, res) => {
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

// Readiness: config is present AND the router actually answered. Unlike
// /api/live this can fail for reasons a restart cannot fix, which is exactly
// why the Docker HEALTHCHECK points at /api/live instead — see the note there.
app.get(
  '/api/health',
  asyncRoute(async (req, res) => {
    const models = await loadAgentModels();
    const configured = isConfigured();
    const router = await checkRouterCached();
    const ok = configured && models.length > 0 && router.reachable === true;

    res.status(ok ? 200 : 503).json({
      ok,
      configured,
      agentCount: models.length,
      routerReachable: router.reachable,
      routerCheckedAt: new Date(router.checkedAt).toISOString(),
      ...(router.latencyMs === undefined ? {} : { routerLatencyMs: router.latencyMs }),
      ...(router.error ? { routerError: router.error, routerErrorCode: router.errorCode } : {}),
    });
  }),
);

app.get(
  '/api/config',
  asyncRoute(async (req, res) => {
    const models = await loadAgentModels();
    res.json({ agentCount: models.length, configured: isConfigured(), maxMessageChars: MAX_MESSAGE_CHARS });
  }),
);

/**
 * Validates an /api/chat body. Returns either `{ message }` or
 * `{ error: { status, body } }` describing the 4xx to send — kept pure so
 * it is unit-testable without a live server.
 */
export function validateChatRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: { status: 400, body: { error: 'invalid_body', message: 'Request body must be a JSON object.' } } };
  }
  const { message } = body;
  if (typeof message !== 'string') {
    return {
      error: {
        status: 400,
        body: { error: 'invalid_message', message: 'message is required and must be a string.' },
      },
    };
  }
  const trimmed = message.trim();
  if (!trimmed) {
    return { error: { status: 400, body: { error: 'empty_message', message: 'message must not be empty.' } } };
  }
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    return {
      error: {
        status: 413,
        body: {
          error: 'message_too_long',
          message: `message must be ${MAX_MESSAGE_CHARS} characters or fewer (got ${trimmed.length}).`,
        },
      },
    };
  }
  return { message: trimmed };
}

app.post(
  '/api/chat',
  asyncRoute(async (req, res) => {
    const validated = validateChatRequest(req.body ?? null);
    if (validated.error) {
      return res.status(validated.error.status).json(validated.error.body);
    }

    const limit = chatLimiter.hit(resolveClientIp(req, { trustProxy: TRUST_PROXY, clientIpHeader: CLIENT_IP_HEADER }));
    res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
    res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: 'rate_limited',
        message: `Too many council runs. Try again in ${limit.retryAfterSeconds}s.`,
      });
    }

    const baseUrl = process.env.FREELLMAPI_BASE_URL;
    const apiKey = process.env.FREELLMAPI_API_KEY;
    if (!baseUrl || !apiKey) {
      return res.status(503).json({
        error: 'not_configured',
        message: 'Set FREELLMAPI_BASE_URL and FREELLMAPI_API_KEY in .env — see README setup.',
      });
    }

    const models = await loadAgentModels();
    if (models.length === 0) {
      return res
        .status(503)
        .json({ error: 'no_agents_configured', message: 'server/config/agents.json has no models listed.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
    });

    const send = (event) => {
      if (clientGone || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const result = await runCouncil({
        question: validated.message,
        config: { baseUrl, apiKey, models },
        onEvent: send,
      });
      send({ type: 'result', result });
    } catch (err) {
      console.error('[chat] council run failed:', err);
      send({ type: 'error', message: String(err?.message ?? err) });
    } finally {
      if (!res.writableEnded) res.end();
    }
  }),
);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not_found', message: `No such endpoint: ${req.method} ${req.path}` });
  }
  res.status(404).type('text/plain').send('Not found');
});

// Final safety net: any error escaping a route becomes a JSON 500 rather
// than an HTML stack trace or a hung request.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong handling that request.' });
});

// Skip listening when imported by tests.
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`llm-council listening on http://localhost:${PORT}`);
  });

  // Platforms like Fly send SIGTERM on deploy/scale-down. Stop accepting new
  // connections, let in-flight council runs finish, and only hard-exit if
  // something is still hanging well past that.
  const shutdown = (signal) => {
    console.log(`[server] ${signal} received — shutting down`);
    const force = setTimeout(() => {
      console.error('[server] forced exit after shutdown timeout');
      process.exit(1);
    }, 30_000);
    force.unref();
    // Idle keep-alive sockets would otherwise hold close() open.
    server.closeIdleConnections?.();
    server.close(() => {
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export { app };
