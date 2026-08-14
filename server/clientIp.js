// Working out *who* a request came from, when something else terminated the
// connection for us.
//
// This matters for exactly one thing here: the /api/chat rate limiter. Get it
// wrong in one direction and every user shares a single bucket (the proxy's
// own address), so one noisy client locks everyone else out. Get it wrong in
// the other direction — trusting X-Forwarded-For unconditionally — and any
// client can rotate a fake header and never be limited at all. Both failures
// are silent, which is why this is its own module with its own tests.

/**
 * Normalises the TRUST_PROXY env var into a value express's `trust proxy`
 * setting understands.
 *
 * Accepted:
 *   unset / "" / "false" / "off" / "no" / "0"  -> false (trust nothing)
 *   "1", "2", ...                              -> that many proxy hops
 *   "loopback" / "linklocal" / "uniquelocal"   -> express's named presets
 *   anything else                              -> passed through verbatim,
 *                                                 e.g. an IP or CIDR list
 *
 * "true" is accepted but deliberately loud: it tells express to trust the
 * leftmost X-Forwarded-For entry from anyone, which is the spoofable case.
 *
 * @param {string|undefined|null} raw
 * @param {(msg: string) => void} [warn]
 * @returns {false | number | string}
 */
export function resolveTrustProxy(raw, warn = console.warn) {
  if (raw === undefined || raw === null) return false;
  const value = String(raw).trim();
  if (!value) return false;

  if (/^(false|off|no)$/i.test(value)) return false;
  if (/^\d+$/.test(value)) return Number(value); // 0 is "trust nothing" too
  if (/^(true|yes|on)$/i.test(value)) {
    warn(
      '[server] TRUST_PROXY=true trusts X-Forwarded-For from any source, so a client can spoof its IP past the ' +
        'rate limiter. Use a hop count instead (TRUST_PROXY=2 on Fly.io).',
    );
    return true;
  }
  return value;
}

/**
 * Header holding a client IP the platform itself wrote, and which it
 * overwrites rather than appends to — so unlike X-Forwarded-For it cannot be
 * seeded by the client. Fly.io's is `Fly-Client-IP`.
 *
 * Only consulted when the app is configured to trust its proxy at all; a
 * directly-exposed process must ignore it, since then nobody is overwriting
 * it and it is just another attacker-supplied string.
 *
 * @param {string|undefined|null} raw
 * @returns {string|null} lowercased header name, or null
 */
export function resolveClientIpHeader(raw) {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim().toLowerCase();
  return value && !/^(false|off|no|0)$/.test(value) ? value : null;
}

/**
 * The identity the rate limiter keys on.
 *
 * With no trusted proxy this is the peer that actually opened the socket, and
 * no header can change it. With a trusted proxy it is the platform's own
 * client-IP header if one is configured, else express's `req.ip` — which
 * express derives by walking X-Forwarded-For from the right by exactly the
 * configured number of hops, so entries a client prepended are never reached.
 *
 * @param {import('express').Request} req
 * @param {object} opts
 * @param {false|number|string} opts.trustProxy
 * @param {string|null} [opts.clientIpHeader]
 * @returns {string} never empty — falls back to a constant shared bucket
 */
export function resolveClientIp(req, { trustProxy, clientIpHeader = null }) {
  const trusted = trustProxy !== false && trustProxy !== 0;

  if (trusted && clientIpHeader) {
    const raw = req.headers?.[clientIpHeader];
    // A duplicated header arrives as an array; a comma-joined value is not
    // expected from a platform header, but split defensively either way and
    // take the first entry, which is what the platform wrote.
    const first = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim();
    if (first) return first;
  }

  if (trusted) {
    const ip = req.ip;
    if (ip) return ip;
  }

  return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}
