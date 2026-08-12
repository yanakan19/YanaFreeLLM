import { callAgentModel } from './freellmapiClient.js';
import { scoreAndRank } from './scoring.js';

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful, concise assistant. Answer directly and avoid padding.';

/**
 * Runs the full council: fans the prompt out to every configured agent model
 * (pinned, in parallel), scores+ranks the survivors, and returns the winner
 * plus the full anonymous scoring matrix. `onEvent` is called with splash /
 * progress events as they happen so the caller can stream them (SSE).
 *
 * To adapt this to your own domain: pass a custom `systemPrompt`, and/or
 * inject retrieved context by adding extra system messages before the user
 * turn (see the `extraContext` param) — this file itself stays generic.
 */
export async function runCouncil({ question, config, systemPrompt, extraContext, onEvent }) {
  const { baseUrl, apiKey, models } = config;
  const emit = (type, data) => onEvent?.({ type, ...data });

  emit('status', { message: 'Thinking…' });

  const messages = [
    { role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT },
    ...(extraContext ? [{ role: 'system', content: extraContext }] : []),
    { role: 'user', content: question },
  ];

  emit('status', { message: `Consulting our ${models.length} agents…` });

  const settled = await Promise.allSettled(
    models.map((model, i) => {
      const agentNumber = i + 1;
      return callAgentModel({ baseUrl, apiKey, model, messages }).then((result) => {
        emit('agent', {
          agentNumber,
          ok: result.ok,
          message: result.ok ? `Agent ${agentNumber} has responded.` : `Agent ${agentNumber} could not respond.`,
        });
        return { agentNumber, ...result };
      });
    }),
  );

  const answers = settled.map((s) => (s.status === 'fulfilled' ? s.value : { ok: false, error: String(s.reason) }));
  const successes = answers.filter((a) => a.ok);

  if (successes.length === 0) {
    emit('status', { message: 'Every agent failed to respond — check your FreeLLMAPI router and keys.' });
    return { ok: false, error: 'no_agents_responded', answers };
  }

  emit('status', { message: 'Ranking responses anonymously…' });

  const { criteria, matrix } = scoreAndRank(question, successes.map((a) => ({ agentNumber: a.agentNumber, content: a.content })));

  emit('status', { message: 'Here we go.' });

  return {
    ok: true,
    winner: matrix[0],
    criteria,
    matrix,
    agentCount: models.length,
    respondedCount: successes.length,
    failedCount: answers.length - successes.length,
  };
}
