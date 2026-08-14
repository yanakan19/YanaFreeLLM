# YanaFreeLLM

A reusable "council of free LLMs" engine: fan a question out to up to 28
models pinned on a self-hosted [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi)
router, score every surviving answer anonymously with a weighted matrix
(`server/scoring.js`), and return the best one. No perfume/e-commerce/any
other domain code lives here — this is the generic engine, extracted from
a perfume-chatbot project (`YanaFragrancePriceChecker/YanaFreeAPIMerger`)
so it can be reused for any future chatbot idea.

## How it works

1. You self-host FreeLLMAPI (Docker) and add your own free provider keys
   (Google AI Studio, Groq, Mistral, Cohere, etc. — all free tiers).
2. This app pins up to 28 model ids (`server/config/agents.json`) and, per
   question, calls all of them in parallel through FreeLLMAPI's OpenAI-
   compatible `/v1/chat/completions` endpoint, labeling them `Agent 1`..
   `Agent N` — their real provider/model identity is never shown to the UI.
3. Every surviving answer is scored on the same deterministic, weighted
   criteria (relevance, structure, actionability, concision, calibrated
   confidence, safety) — no answer sees another's score, and the scorer
   never sees which model produced which answer.
4. The top-ranked answer is returned. The UI shows a live splash sequence
   while this happens ("Thinking…", "Consulting our N agents…", per-agent
   ✓/✗ chips, "Ranking responses anonymously…").

## Adapting this to a specific project

This repo is intentionally thin. To build a domain-specific chatbot on top
of it:

1. **Swap the system prompt.** `runCouncil()` in `server/council.js` takes
   a `systemPrompt` param — pass your own instead of the generic default.
2. **Inject retrieved context.** Pass `extraContext` to `runCouncil()` with
   whatever domain data is relevant to the current question (pulled from
   your own database/API/static data — fetch it before calling the council,
   not inside it).
3. **Add domain-specific scoring, if needed.** `server/scoring.js`'s
   `CRITERIA` array is a plain list of `{ key, weight, describe, score }`
   objects — add a new criterion (e.g. "groundedness": does every fact in
   the answer trace back to the injected context?) without touching the
   rest.
4. **Adjust `server/config/agents.json`** to the model ids your own
   FreeLLMAPI instance actually serves. Don't hand-copy them from a
   `curl /v1/models` any more — run the generator:
   ```bash
   npm run generate-agents              # writes server/config/agents.json
   npm run generate-agents -- --dry-run # print the plan, write nothing
   npm run generate-agents -- --max=12  # cap the panel (default 28)
   ```
   It reads `FREELLMAPI_BASE_URL`/`FREELLMAPI_API_KEY` from `.env`, calls
   `GET /v1/models` with your unified key, keeps only `available: true`
   models, drops the virtual `auto`/`fusion` pseudo-models, and then picks a
   **diverse** panel: it round-robins across `owned_by` providers so every
   provider is used once before any is used twice, and within a provider
   alternates between the largest and smallest context windows so the council
   isn't 28 near-identical models. The cap comes from `--max=N`, a bare
   numeric arg, or `MAX_AGENTS` in env.

   If the router is unreachable or returns nothing usable, it prints the
   error and exits non-zero **without touching the committed
   `agents.json`**. `npm test` runs the script's built-in fixture self-test
   (`node scripts/generate-agents.mjs --self-test`), which verifies the
   parsing, filtering and diversity logic with no live router.
5. Restyle `public/` to match whatever product this powers.

The perfume-specific version of all this (price lookups, notes-based
suggestions, pricesniffs.space branding) lives in a separate repo,
`YanaFragrancePriceChecker`, subfolder `YanaFreeAPIMerger` — that's the
worked example of steps 1-3 above, if you want to see it applied.

## Setup

1. Stand up FreeLLMAPI:
   ```bash
   curl -fsSL https://freellmapi.co/install.sh | bash
   ```
   Add your free provider keys on its Keys page, grab the unified
   `freellmapi-…` key.

2. Configure this app:
   ```bash
   cp .env.example .env
   # edit .env: FREELLMAPI_BASE_URL, FREELLMAPI_API_KEY
   npm install
   ```

3. Populate `server/config/agents.json` with the model ids your instance
   actually has enabled:
   ```bash
   npm run generate-agents
   ```
   See "Adjust `server/config/agents.json`" above for the flags and the
   selection rules; hand-editing the file still works.

4. Run it:
   ```bash
   npm start
   ```
   Open http://localhost:4000

## Remote deployment

See `deploy/fly/` for Fly.io configs (no VCN/networking setup required,
unlike some cloud providers) — one for FreeLLMAPI itself (uses the
official published image + a persistent volume for its encrypted key
database), one for this app. Comments in each `.toml` file walk through
the exact `flyctl` commands.

## Status / limitations

- Free-tier LLMs have no SLA — see FreeLLMAPI's own documented limitations
  (daily quota resets, variable latency, no frontier models). The scoring
  matrix exists specifically to surface that: a bad answer ranks low and
  loses, rather than being trusted just because it's first.
- This is a reusable engine/starting point, not a finished product on its
  own — it needs a domain layered on top (see "Adapting this to a specific
  project" above) to be useful for an end user.
