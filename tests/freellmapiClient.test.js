import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  callAgentModel,
  classifyHttpStatus,
  classifyThrownError,
  isRetryable,
  ErrorCodes,
} from '../server/freellmapiClient.js';

const args = { baseUrl: 'http://router.test/', apiKey: 'key', model: 'm1', messages: [{ role: 'user', content: 'hi' }] };

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(text, status) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

const completion = (content) => ({ choices: [{ message: { content } }] });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifyHttpStatus', () => {
  it.each([
    [401, ErrorCodes.AUTH_FAILURE],
    [403, ErrorCodes.AUTH_FAILURE],
    [429, ErrorCodes.RATE_LIMITED],
    [402, ErrorCodes.RATE_LIMITED],
    [400, ErrorCodes.BAD_REQUEST],
    [404, ErrorCodes.BAD_REQUEST],
    [500, ErrorCodes.UPSTREAM_ERROR],
    [503, ErrorCodes.UPSTREAM_ERROR],
    [200, ErrorCodes.UNKNOWN],
  ])('maps %i to %s', (status, code) => {
    expect(classifyHttpStatus(status)).toBe(code);
  });
});

describe('classifyThrownError', () => {
  it('classifies aborts as timeouts', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    expect(classifyThrownError(e)).toBe(ErrorCodes.TIMEOUT);
  });

  it('classifies fetch TypeErrors as network errors', () => {
    expect(classifyThrownError(new TypeError('fetch failed'))).toBe(ErrorCodes.NETWORK_ERROR);
  });

  it('classifies undici connection causes as network errors', () => {
    const e = new Error('fetch failed');
    e.name = 'Error';
    e.cause = { code: 'ECONNREFUSED' };
    expect(classifyThrownError(e)).toBe(ErrorCodes.NETWORK_ERROR);
  });

  it('classifies JSON syntax errors as malformed responses', () => {
    expect(classifyThrownError(new SyntaxError('Unexpected token'))).toBe(ErrorCodes.MALFORMED_RESPONSE);
  });

  it('falls back to unknown', () => {
    expect(classifyThrownError(new Error('???'))).toBe(ErrorCodes.UNKNOWN);
  });

  it('honours an already-tagged code', () => {
    const e = new Error('x');
    e.code = ErrorCodes.RATE_LIMITED;
    expect(classifyThrownError(e)).toBe(ErrorCodes.RATE_LIMITED);
  });
});

describe('isRetryable', () => {
  it('marks transient codes retryable', () => {
    for (const c of [ErrorCodes.TIMEOUT, ErrorCodes.RATE_LIMITED, ErrorCodes.UPSTREAM_ERROR, ErrorCodes.NETWORK_ERROR]) {
      expect(isRetryable(c)).toBe(true);
    }
  });

  it('marks permanent codes non-retryable', () => {
    for (const c of [ErrorCodes.AUTH_FAILURE, ErrorCodes.BAD_REQUEST, ErrorCodes.MALFORMED_RESPONSE, ErrorCodes.EMPTY_COMPLETION]) {
      expect(isRetryable(c)).toBe(false);
    }
  });
});

describe('callAgentModel — success', () => {
  it('returns the completion with the original contract fields', async () => {
    fetch.mockResolvedValue(jsonResponse(completion('an answer')));
    const r = await callAgentModel(args);
    expect(r.ok).toBe(true);
    expect(r.model).toBe('m1');
    expect(r.content).toBe('an answer');
    expect(r.error).toBeUndefined();
    expect(typeof r.latencyMs).toBe('number');
  });

  it('normalises a trailing slash on baseUrl and posts to /v1/chat/completions', async () => {
    fetch.mockResolvedValue(jsonResponse(completion('a')));
    await callAgentModel(args);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://router.test/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer key');
    expect(JSON.parse(init.body)).toMatchObject({ model: 'm1', temperature: 0.6 });
  });

  it('reports the routing header when the router supplies one', async () => {
    fetch.mockResolvedValue(jsonResponse(completion('a'), { headers: { 'x-routed-via': 'groq/llama' } }));
    expect((await callAgentModel(args)).routedVia).toBe('groq/llama');
  });

  it('falls back to the model id when no routing header is present', async () => {
    fetch.mockResolvedValue(jsonResponse(completion('a')));
    expect((await callAgentModel(args)).routedVia).toBe('m1');
  });
});

describe('callAgentModel — classified failures', () => {
  it.each([
    [401, ErrorCodes.AUTH_FAILURE, false],
    [429, ErrorCodes.RATE_LIMITED, true],
    [500, ErrorCodes.UPSTREAM_ERROR, true],
    [404, ErrorCodes.BAD_REQUEST, false],
  ])('HTTP %i -> %s', async (status, code, retryable) => {
    fetch.mockResolvedValue(textResponse('{"error":"nope"}', status));
    const r = await callAgentModel(args);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(code);
    expect(r.retryable).toBe(retryable);
    expect(r.httpStatus).toBe(status);
    expect(r.error).toContain(`HTTP ${status}`);
  });

  it('classifies an abort as a timeout', async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    fetch.mockRejectedValue(e);
    const r = await callAgentModel(args);
    expect(r.errorCode).toBe(ErrorCodes.TIMEOUT);
    expect(r.error).toMatch(/timed out after \d+ms/);
    expect(r.retryable).toBe(true);
  });

  it('classifies an unreachable router as a network error', async () => {
    const e = new TypeError('fetch failed');
    e.cause = { code: 'ECONNREFUSED' };
    fetch.mockRejectedValue(e);
    const r = await callAgentModel(args);
    expect(r.errorCode).toBe(ErrorCodes.NETWORK_ERROR);
    expect(r.httpStatus).toBeUndefined();
  });

  it('classifies unparseable JSON as a malformed response', async () => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });
    const r = await callAgentModel(args);
    expect(r.errorCode).toBe(ErrorCodes.MALFORMED_RESPONSE);
    expect(r.retryable).toBe(false);
  });

  it('classifies a 200 with no completion as a malformed response', async () => {
    fetch.mockResolvedValue(jsonResponse({ choices: [] }));
    expect((await callAgentModel(args)).errorCode).toBe(ErrorCodes.MALFORMED_RESPONSE);
  });

  it('classifies a whitespace-only completion as empty', async () => {
    fetch.mockResolvedValue(jsonResponse(completion('   \n ')));
    const r = await callAgentModel(args);
    expect(r.errorCode).toBe(ErrorCodes.EMPTY_COMPLETION);
    expect(r.error).toBe('empty completion');
  });

  it('always returns rather than throwing, and always names the model', async () => {
    fetch.mockRejectedValue(new Error('total surprise'));
    const r = await callAgentModel(args);
    expect(r).toMatchObject({ ok: false, model: 'm1', errorCode: ErrorCodes.UNKNOWN });
    expect(typeof r.latencyMs).toBe('number');
  });
});
