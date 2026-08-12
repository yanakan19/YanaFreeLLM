const TIMEOUT_MS = (Number(process.env.AGENT_TIMEOUT_SECONDS) || 25) * 1000;

// Calls one pinned model on a self-hosted FreeLLMAPI router
// (https://github.com/tashfeenahmed/freellmapi). FreeLLMAPI exposes an
// OpenAI-compatible /v1/chat/completions; pinning `model` to a catalog id
// (rather than "auto"/"fusion") makes THIS call hit that specific model,
// which is what lets the council run a genuine per-model panel instead of
// relying on FreeLLMAPI's own capped internal fusion panel.
export async function callAgentModel({ baseUrl, apiKey, model, messages }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();

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

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) throw new Error('empty completion');

    return {
      ok: true,
      model,
      content,
      routedVia: res.headers.get('x-routed-via') ?? model,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      model,
      error: err?.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : String(err?.message ?? err),
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
