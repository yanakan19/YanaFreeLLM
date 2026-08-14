import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/freellmapiClient.js', () => ({
  callAgentModel: vi.fn(),
}));

import { callAgentModel } from '../server/freellmapiClient.js';
import { runCouncil } from '../server/council.js';

const config = { baseUrl: 'http://router.test', apiKey: 'k', models: ['m1', 'm2', 'm3'] };

/** Resolve per-model with the given map of model -> result. */
function respondWith(map) {
  callAgentModel.mockImplementation(({ model }) => Promise.resolve(map[model]));
}

const good = (content) => ({ ok: true, model: 'x', content });
const bad = (error) => ({ ok: false, model: 'x', error });

beforeEach(() => {
  callAgentModel.mockReset();
});

describe('runCouncil — happy path', () => {
  it('calls every configured model once, with the same messages', async () => {
    respondWith({ m1: good('alpha answer'), m2: good('beta answer'), m3: good('gamma answer') });
    await runCouncil({ question: 'hello there', config });

    expect(callAgentModel).toHaveBeenCalledTimes(3);
    const models = callAgentModel.mock.calls.map(([a]) => a.model);
    expect(models.sort()).toEqual(['m1', 'm2', 'm3']);
    const messageSets = callAgentModel.mock.calls.map(([a]) => JSON.stringify(a.messages));
    expect(new Set(messageSets).size).toBe(1);
  });

  it('passes baseUrl and apiKey through to the client', async () => {
    respondWith({ m1: good('a'), m2: good('b'), m3: good('c') });
    await runCouncil({ question: 'q', config });
    for (const [arg] of callAgentModel.mock.calls) {
      expect(arg.baseUrl).toBe('http://router.test');
      expect(arg.apiKey).toBe('k');
    }
  });

  it('uses the default system prompt when none is supplied', async () => {
    respondWith({ m1: good('a'), m2: good('b'), m3: good('c') });
    await runCouncil({ question: 'q', config });
    const { messages } = callAgentModel.mock.calls[0][0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toMatch(/helpful, concise assistant/);
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'q' });
  });

  it('uses a custom system prompt and injects extraContext as a second system turn', async () => {
    respondWith({ m1: good('a'), m2: good('b'), m3: good('c') });
    await runCouncil({ question: 'q', config, systemPrompt: 'BE A PIRATE', extraContext: 'CTX' });
    const { messages } = callAgentModel.mock.calls[0][0];
    expect(messages).toEqual([
      { role: 'system', content: 'BE A PIRATE' },
      { role: 'system', content: 'CTX' },
      { role: 'user', content: 'q' },
    ]);
  });

  it('returns the top-ranked answer as the winner with consistent counts', async () => {
    respondWith({
      m1: good('no.'),
      m2: good('- hello point one\n- hello point two\n\nI would recommend you try roughly this.'),
      m3: good('hello.'),
    });
    const result = await runCouncil({ question: 'hello there', config });

    expect(result.ok).toBe(true);
    expect(result.agentCount).toBe(3);
    expect(result.respondedCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(result.matrix).toHaveLength(3);
    expect(result.winner).toBe(result.matrix[0]);
    expect(result.winner.rank).toBe(1);
    expect(result.criteria.length).toBeGreaterThan(0);
  });
});

describe('runCouncil — partial failure', () => {
  it('scores only the survivors and reports the failed count', async () => {
    respondWith({ m1: good('first answer here'), m2: bad('timed out'), m3: good('third answer here') });
    const result = await runCouncil({ question: 'q', config });

    expect(result.ok).toBe(true);
    expect(result.respondedCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(result.matrix).toHaveLength(2);
    expect(result.matrix.map((m) => m.agentNumber).sort()).toEqual([1, 3]);
  });

  it('survives a rejected client promise as a failed agent', async () => {
    callAgentModel.mockImplementation(({ model }) =>
      model === 'm2' ? Promise.reject(new Error('boom')) : Promise.resolve(good('an answer')),
    );
    const result = await runCouncil({ question: 'q', config });
    expect(result.ok).toBe(true);
    expect(result.failedCount).toBe(1);
    expect(result.respondedCount).toBe(2);
  });

  it('keeps agent numbers tied to model order, not completion order', async () => {
    callAgentModel.mockImplementation(({ model }) => {
      const delay = model === 'm1' ? 20 : 0;
      return new Promise((r) => setTimeout(() => r(good(`answer from ${model}`)), delay));
    });
    const result = await runCouncil({ question: 'q', config });
    const numbers = result.matrix.map((m) => m.agentNumber).sort();
    expect(numbers).toEqual([1, 2, 3]);
  });
});

describe('runCouncil — total failure', () => {
  it('returns ok:false with the no_agents_responded code and the raw answers', async () => {
    respondWith({ m1: bad('a'), m2: bad('b'), m3: bad('c') });
    const result = await runCouncil({ question: 'q', config });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_agents_responded');
    expect(result.answers).toHaveLength(3);
    expect(result.matrix).toBeUndefined();
  });

  it('emits a diagnostic status message when everything fails', async () => {
    respondWith({ m1: bad('a'), m2: bad('b'), m3: bad('c') });
    const events = [];
    await runCouncil({ question: 'q', config, onEvent: (e) => events.push(e) });
    const statuses = events.filter((e) => e.type === 'status').map((e) => e.message);
    expect(statuses.at(-1)).toMatch(/Every agent failed/);
    expect(statuses).not.toContain('Ranking responses anonymously…');
  });
});

describe('runCouncil — failure classification', () => {
  it('tallies failures by errorCode', async () => {
    respondWith({
      m1: { ok: false, error: 'timed out', errorCode: 'timeout' },
      m2: { ok: false, error: 'HTTP 429', errorCode: 'rate_limited' },
      m3: good('a real answer here'),
    });
    const result = await runCouncil({ question: 'q', config });
    expect(result.failureCounts).toEqual({ timeout: 1, rate_limited: 1 });
  });

  it('reports failureCounts on a total failure too', async () => {
    respondWith({
      m1: { ok: false, error: 'x', errorCode: 'auth_failure' },
      m2: { ok: false, error: 'x', errorCode: 'auth_failure' },
      m3: { ok: false, error: 'x', errorCode: 'auth_failure' },
    });
    const result = await runCouncil({ question: 'q', config });
    expect(result.ok).toBe(false);
    expect(result.failureCounts).toEqual({ auth_failure: 3 });
  });

  it('buckets unclassified failures as unknown', async () => {
    respondWith({ m1: bad('legacy string only'), m2: good('a a a'), m3: good('b b b') });
    const result = await runCouncil({ question: 'q', config });
    expect(result.failureCounts).toEqual({ unknown: 1 });
  });

  it('forwards errorCode on the agent event', async () => {
    respondWith({
      m1: { ok: false, error: 'timed out', errorCode: 'timeout' },
      m2: good('a a a'),
      m3: good('b b b'),
    });
    const events = [];
    await runCouncil({ question: 'q', config, onEvent: (e) => events.push(e) });
    const failed = events.find((e) => e.type === 'agent' && !e.ok);
    expect(failed.errorCode).toBe('timeout');
    const okEvent = events.find((e) => e.type === 'agent' && e.ok);
    expect(okEvent).not.toHaveProperty('errorCode');
  });
});

describe('runCouncil — event emission', () => {
  it('emits status, then one agent event per model, then the ranking statuses in order', async () => {
    respondWith({ m1: good('a a a'), m2: good('b b b'), m3: good('c c c') });
    const events = [];
    await runCouncil({ question: 'q', config, onEvent: (e) => events.push(e) });

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('status');
    expect(types[1]).toBe('status');
    expect(events[1].message).toBe('Consulting our 3 agents…');

    const agentEvents = events.filter((e) => e.type === 'agent');
    expect(agentEvents).toHaveLength(3);
    expect(agentEvents.map((e) => e.agentNumber).sort()).toEqual([1, 2, 3]);
    expect(agentEvents.every((e) => e.ok)).toBe(true);

    // every agent event precedes the ranking status
    const rankingIdx = events.findIndex((e) => e.message === 'Ranking responses anonymously…');
    const lastAgentIdx = types.lastIndexOf('agent');
    expect(lastAgentIdx).toBeLessThan(rankingIdx);
    expect(events.at(-1).message).toBe('Here we go.');
  });

  it('marks failed agents in their agent event', async () => {
    respondWith({ m1: good('a a a'), m2: bad('nope'), m3: good('c c c') });
    const events = [];
    await runCouncil({ question: 'q', config, onEvent: (e) => events.push(e) });

    const failed = events.filter((e) => e.type === 'agent' && !e.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].message).toMatch(/could not respond/);
  });

  it('works without an onEvent callback', async () => {
    respondWith({ m1: good('a a a'), m2: good('b b b'), m3: good('c c c') });
    await expect(runCouncil({ question: 'q', config })).resolves.toMatchObject({ ok: true });
  });

  it('handles an empty model list as a total failure', async () => {
    const result = await runCouncil({ question: 'q', config: { ...config, models: [] } });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_agents_responded');
    expect(callAgentModel).not.toHaveBeenCalled();
  });
});
