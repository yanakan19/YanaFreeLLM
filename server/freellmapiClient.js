const TIMEOUT_MS = (Number(process.env.AGENT_TIMEOUT_SECONDS) || 25) * 1000;

/**
 * Stable machine-readable failure codes. `error` stays a human string for
 * backward compatibility; `errorCode` is what callers should branch on.
 *
 * - TIMEOUT            the agent didn't answer inside AGENT_TIMEOUT_SECONDS
 * - AUTH_FAILURE       401/403 — unified key missing, wrong, or lacking access
 * - RATE_LIMITED       429 (or a 402/quota response) — free-tier quota hit
 * - UPSTREAM_ERROR     5xx from the router or the provider behind it
 * - BAD_REQUEST        4xx we caused (unknown model id, malformed payload)
 * - NETWORK_ERROR      the router was unreachable / connection dropped
 * - MALFORMED_RESPONSE 2xx whose body wasn't usable JSON with a completion
 * - EMPTY_COMPLETION   valid response, but the model returned no text
 * - UNKNOWN            anything unclassified
 */
export const ErrorCodes = Object.freeze({
  TIMEOUT: 'timeout',
  AUTH_FAILURE: 'auth_failure',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM_ERROR: 'upstream_error',
  BAD_REQUEST: 'bad_request',
  NETWORK_ERROR: 'network_error',
  MALFORMED_RESPONSE: 'malformed_response',
  EMPTY_COMPLETION: 'empty_completion',
  UNKNOWN: 'unknown',
});

/** Codes where re-asking the same model later has a real chance of working. */
const RETRYABLE = new Set([
  ErrorCodes.TIMEOUT,
  ErrorCodes.RATE_LIMITED,
  ErrorCodes.UPSTREAM_ERROR,
  ErrorCodes.NETWORK_ERROR,
]);

export function isRetryable(errorCode) {
  return RETRYABLE.has(errorCode);
}

/** Maps an HTTP status from the router onto an ErrorCode. */
export function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return ErrorCodes.AUTH_FAILURE;
  if (status === 402 || status === 429) return ErrorCodes.RATE_LIMITED;
  if (status >= 500) return ErrorCodes.UPSTREAM_ERROR;
  if (status >= 400) return ErrorCodes.BAD_REQUEST;
  return ErrorCodes.UNKNOWN;
}

/** Maps a thrown fetch/parse error onto an ErrorCode. */
export function classifyThrownError(err) {
  if (err?.code) return err.code; // already classified by us below
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return ErrorCodes.TIMEOUT;
  if (err?.name === 'TypeError' || err?.name === 'FetchError') return ErrorCodes.NETWORK_ERROR;
  // undici surfaces connection problems as a cause with an errno-ish code
  const causeCode = err?.cause?.code;
  if (typeof causeCode === 'string' && /^(ECONN|ENOTFOUND|EAI_|EHOSTUNREACH|ETIMEDOUT|UND_ERR)/.test(causeCode)) {
    return ErrorCodes.NETWORK_ERROR;
  }
  if (err instanceof SyntaxError) return ErrorCodes.MALFORMED_RESPONSE;
  return ErrorCodes.UNKNOWN;
}

function tagged(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Calls one pinned model on a self-hosted FreeLLMAPI router
// (https://github.com/tashfeenahmed/freellmapi). FreeLLMAPI exposes an
// OpenAI-compatible /v1/chat/completions; pinning `model` to a catalog id
// (rather than "auto"/"fusion") makes THIS call hit that specific model,
// which is what lets the council run a genuine per-model panel instead of
// relying on FreeLLMAPI's own capped internal fusion panel.
//
// Never throws. On failure it returns { ok: false, model, error, errorCode,
// retryable, httpStatus?, latencyMs } — `error` is the human string the
// original contract promised, `errorCode` is the stable code to branch on.
export async function callAgentModel({ baseUrl, apiKey, model, messages }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  let httpStatus;

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0.6 }),
      signal: controller.signal,
    });
    httpStatus = res.status;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw tagged(classifyHttpStatus(res.status), `HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw tagged(ErrorCodes.MALFORMED_RESPONSE, 'response body was not valid JSON');
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw tagged(ErrorCodes.MALFORMED_RESPONSE, 'response had no choices[0].message.content string');
    }
    if (!content.trim()) throw tagged(ErrorCodes.EMPTY_COMPLETION, 'empty completion');

    return {
      ok: true,
      model,
      content,
      routedVia: res.headers.get('x-routed-via') ?? model,
      httpStatus,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    const errorCode = classifyThrownError(err);
    const error =
      errorCode === ErrorCodes.TIMEOUT && err?.name === 'AbortError'
        ? `timed out after ${TIMEOUT_MS}ms`
        : String(err?.message ?? err);
    return {
      ok: false,
      model,
      error,
      errorCode,
      retryable: isRetryable(errorCode),
      ...(httpStatus === undefined ? {} : { httpStatus }),
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
