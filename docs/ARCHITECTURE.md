# YanaFreeLLM — Technical Architecture

This document describes what the code in this repository actually does, as of
the current commit. Where a capability does not exist, it says so explicitly
rather than describing an idealised version of the system. Everything below is
traceable to `server/index.js`, `server/council.js`, `server/scoring.js`,
`server/freellmapiClient.js`, `server/config/agents.json`, `public/app.js`,
`Dockerfile`, and `deploy/fly/*.toml`.

The whole engine is roughly 300 lines of JavaScript with two runtime
dependencies (`express`, `dotenv`). There is no database, no cache, no queue,
no auth layer, no persistence of any kind. Every request is stateless and
starts from nothing.

---

## 1. System diagram and request flow

```
                            ┌──────────────────────────────────┐
  browser (public/app.js)   │  POST /api/chat  { message }     │
  ────────────────────────► │  Express, server/index.js        │
        SSE stream back     │  express.json() + static /public │
  ◄──────────────────────── └───────────────┬──────────────────┘
                                            │
                        validate message (400 if empty/non-string)
                        validate env       (503 not_configured)
                        loadAgentModels()  (503 no_agents_configured)
                        read server/config/agents.json → .slice(0, 28)
                                            │
                        set SSE headers, flushHeaders()
                                            │
                                            ▼
                            ┌──────────────────────────────────┐
                            │  runCouncil({ question, config,  │
                            │    systemPrompt, extraContext,   │
                            │    onEvent })   council.js       │
                            └───────────────┬──────────────────┘
                                            │
        messages = [ system(systemPrompt || DEFAULT_SYSTEM_PROMPT),
                     system(extraContext)  ← only if provided,
                     user(question) ]
                                            │
                       Promise.allSettled over models.map(...)
                                            │
        ┌──────────┬──────────┬──────────┬──┴───────┬──────────────┐
        ▼          ▼          ▼          ▼          ▼              ▼
     Agent 1    Agent 2    Agent 3    Agent 4   …   Agent N     (N ≤ 28)
        │          │          │          │          │
        └──────────┴──────────┴──────────┴──────────┘
                   each = callAgentModel()  freellmapiClient.js
                   POST {baseUrl}/v1/chat/completions
                   Authorization: Bearer <unified key>
                   body: { model, messages, temperature: 0.6 }
                   AbortController, TIMEOUT_MS = AGENT_TIMEOUT_SECONDS||25 s
                                            │
                                            ▼
                            ┌──────────────────────────────────┐
                            │   FreeLLMAPI router (self-hosted)│
                            │   OpenAI-compatible façade over  │
                            │   ~29 providers' free tiers,     │
                            │   key rotation + cooldowns       │
                            └───────────────┬──────────────────┘
                                            │
                    ┌───────────────┬───────┴───────┬────────────────┐
                    ▼               ▼               ▼                ▼
              Google AI Studio    Groq          Mistral          Cohere  …
                                            │
                                            ▼
        each resolves to { ok:true, model, content, routedVia, latencyMs }
                       or { ok:false, model, error, latencyMs }
                                            │
                    emit('agent', { agentNumber, ok, message })  → SSE chip
                                            │
                       successes = answers.filter(a => a.ok)
                       if successes.length === 0 → return { ok:false }
                                            │
                                            ▼
                            ┌──────────────────────────────────┐
                            │ scoreAndRank(question, [{agent   │
                            │   Number, content}])  scoring.js │
                            │ 6 weighted heuristic criteria,   │
                            │ pure functions on the text       │
                            └───────────────┬──────────────────┘
                                            │
                    sort by totalScore desc, assign rank 1..n
                                            │
                    winner = matrix[0]; emit('result', result)
                                            ▼
                    res.end()  → browser renders winner.content
                                 + collapsible scoring matrix table
```

### Event sequence on the wire

The response is `text/event-stream`, `Cache-Control: no-cache`,
`Connection: keep-alive`. `server/index.js` writes raw
`data: <json>\n\n` frames — there are no `event:` names, no `id:`, no retry
directives, and no heartbeat/keepalive comment frames. The client
(`public/app.js`) splits the stream on `\n\n`, strips the `data:` prefix and
`JSON.parse`s each frame.

Frames, in order:

1. `{ type: 'status', message: 'Thinking…' }`
2. `{ type: 'status', message: 'Consulting our N agents…' }`
3. `{ type: 'agent', agentNumber, ok, message }` — one per model, emitted in
   *completion* order, not index order. Fast providers land first.
4. `{ type: 'status', message: 'Ranking responses anonymously…' }`
5. `{ type: 'status', message: 'Here we go.' }`
6. `{ type: 'result', result }` — the full object from `runCouncil`.
7. Stream closes (`res.end()` in the `finally` block).

If `runCouncil` throws, the handler emits `{ type: 'error', message }` instead
of `result` and still closes the stream.

### Latency characteristics

`Promise.allSettled` waits for *every* model. There is no first-past-the-post
short circuit, no partial-quorum early return, no per-agent streaming of token
deltas. End-to-end wall time is therefore
`max(latency of the slowest agent)`, hard-bounded by `TIMEOUT_MS`
(25 s default). A single wedged provider costs the full 25 s for the whole
request even if 27 other agents answered in 900 ms. This is a deliberate
simplicity trade-off, not an oversight — but it is the single largest latency
lever in the system, and the obvious future change is to race the fan-out
against a quorum count plus a soft deadline.

### Anonymity boundary

`runCouncil` passes only `{ agentNumber, content }` into `scoreAndRank`. The
real model id, the `routedVia` header, and `latencyMs` are dropped at that
boundary. The scorer is structurally incapable of preferring a model by name,
and the UI only ever renders "Agent N". Note this is anonymity toward the
scorer and the UI — the server process obviously still knows the mapping; it
just never forwards it.

---

## 2. Quota economics

### What the router is doing

FreeLLMAPI is an OpenAI-compatible proxy that aggregates the free tiers of
roughly 29 providers behind one endpoint. You give it your own provider API
keys (Google AI Studio, Groq, Mistral, Cohere, …); it stores them in an
encrypted local database, exposes a single unified `freellmapi-…` key, rotates
across the keys it holds for a given provider, and applies cooldowns when a
provider signals rate limiting.

This repository holds **no** provider keys. It holds exactly two secrets:
`FREELLMAPI_BASE_URL` and `FREELLMAPI_API_KEY` (the unified key). All quota
lives one layer down, in the router.

### What "shared quota across apps" concretely means

The unified key is a pointer to a *pool*, not an allocation. Every client
pointed at the same router instance draws from the same underlying provider
keys:

```
                 ┌────────────────────────┐
  YanaFreeLLM ──►│                        │
                 │  one FreeLLMAPI        │   Google AI Studio key(s)
  Virtual Yanny ►│  router instance       ├─► Groq key(s)
  (perfume       │  (one Fly app, one     │   Mistral key(s)
   price bot)    │   encrypted key DB,    │   Cohere key(s)  …
                 │   one unified key)     │
  ScholApply ───►│                        │
  (job tailoring)└────────────────────────┘
```

Consequences that follow directly from that shape:

- **Quota is consumed globally, not per app.** If Virtual Yanny burns the
  day's Google AI Studio free-tier requests at 11:00, this engine's
  `gemini-2.5-flash` agent starts failing at 11:01, for every app, until the
  provider's window resets. There is no reservation, no per-app budget, no
  priority ordering. First caller wins.
- **The fan-out is quota-expensive by design.** One user question here is N
  provider calls, N ≤ 28. A single chat turn can consume 28 units of free-tier
  budget spread across providers. Two apps doing this concurrently is 56.
  `/api/chat` is throttled per client IP (`RATE_LIMIT_MAX`, default 10 per
  `RATE_LIMIT_WINDOW_MS`, default 60 s), which caps one client at ~280 upstream
  calls a minute rather than an unbounded loop. There is still no dedupe and no
  request coalescing, and the limiter is in-memory and per process, so it
  resets on restart and does not hold across multiple instances.

  "Per client IP" depends on the app knowing the client's address. Behind a
  proxy that terminates the connection — Fly's, in the shipped topology —
  `req.ip` is the *proxy's* address unless `TRUST_PROXY` is set, so every user
  collapses into one bucket and ten requests a minute becomes a global cap that
  one visitor can exhaust for everyone. `TRUST_PROXY` is unset by default
  because the opposite error is worse: trusting `X-Forwarded-For` from anyone
  lets a client rotate a fake header and evade the limiter entirely.
  `server/clientIp.js` resolves this, and on Fly the correct value is
  `TRUST_PROXY=2` — Fly appends both the real client and the app's own anycast
  address, and express counts hops from the right. Both failure modes are
  silent, which is why the resolver is its own tested module.
- **The blast radius of a revoked key is shared.** Revoking or exhausting one
  provider key degrades every app at once.
- **Adding an app is free in code and not free in quota.** Pointing a fourth
  app at the router costs nothing to set up and immediately dilutes everyone's
  headroom.

The mitigating factor is that the council is *designed* to tolerate this: the
system's correctness does not depend on any specific model being available,
only on at least one of N answering. Quota exhaustion degrades panel breadth
(and therefore ranking quality) rather than causing an outage — until it
exhausts all of them.

### What a 429 actually looks like to a caller

An upstream 429 is *classified* but never *acted on*. (`/api/chat` also returns
its own 429 when the per-IP limiter trips, but that is the app shedding load at
the front door, not a reaction to a provider throttling us.) Trace it through
`freellmapiClient.js`: a non-2xx response is thrown with a code attached by
`classifyHttpStatus`, which maps 429 — and 402, the other way a free tier says
"you are done" — to `RATE_LIMITED`.

That throw is caught by the same function's own `catch`, which converts it
into a value, never a rejection:

```js
return { ok: false, model, error, errorCode, retryable: isRetryable(errorCode), … };
```

So a provider cap hit mid-request produces, for that one agent:

- `ok: false`
- `errorCode: 'rate_limited'`, `retryable: true`, `httpStatus: 429`
- `error: "HTTP 429: <first 300 chars of the router's body>"`
- a real `latencyMs` (the failure is measured like a success)

and then, in `council.js`, an SSE frame
`{ type: 'agent', agentNumber: 7, ok: false, errorCode: 'rate_limited', message: 'Agent 7 could not respond.' }`,
which the browser renders as a red `Agent 7 ✗` chip. `runCouncil` also
aggregates a `failureCounts` map keyed by code, so a caller can tell "the
router is down" (28 × `network_error`) from "one flaky model" (1 ×
`rate_limited`). The human-readable `error` *string* is still only returned in
the total-failure path (`{ ok:false, error:'no_agents_responded', answers,
failureCounts }`); on a partial failure the per-agent message is computed and
discarded, so the user sees which agent failed and, via the code, roughly what
class of failure it was — but never the router's actual message.

Note `retryable` is *reported* and never consumed: nothing in this repo reads
it back.

There is **no retry, no backoff, no failover to a sibling model, and no
circuit breaker in this repo.** If `gemini-2.5-flash` 429s, that agent is
simply absent from this turn's panel; the next question tries it again
immediately with no memory that it just failed. Whatever cooldown behaviour
exists lives inside the FreeLLMAPI router, not here.

The other failure shapes handled identically (as `ok:false`):

| Condition | `error` value |
|---|---|
| Timeout / abort | `timed out after 25000ms` |
| Non-2xx (429, 401, 500, 502…) | `HTTP <status>: <body slice>` |
| Model returned whitespace only | `empty completion` |
| DNS/TCP/TLS failure reaching the router | the raw `fetch` error message |
| Malformed JSON body | the `res.json()` parse error message |

Note the `empty completion` guard: a provider that returns 200 with an empty
`choices[0].message.content` is treated as a failure, not as a zero-scoring
answer. That is the right call — it keeps degenerate output out of the ranking
matrix entirely.

---

## 3. The scoring matrix in depth

`server/scoring.js` exports `scoreAndRank(question, agentAnswers)`. It iterates
`CRITERIA`, calls each criterion's pure `score({ content, question })`
function, accumulates `total += s * c.weight`, rounds to one decimal
(`Math.round(total * 10) / 10`), sorts descending, and assigns `rank`.

Weights sum to exactly 1.00. Every criterion returns a 0–100 integer, so
`totalScore` is also on a 0–100 scale.

| Criterion | Weight | What it measures |
|---|---|---|
| `relevance` | 0.34 | Keyword overlap with the question |
| `structure` | 0.16 | Lists / paragraphs / line length |
| `actionability` | 0.16 | Advice markers + presence of digits |
| `concision` | 0.14 | Raw character-count bands |
| `calibratedConfidence` | 0.10 | Hedge-word count vs. overclaim words |
| `safety` | 0.10 | Penalties for unhedged figures and URLs |

### `relevance` — weight 0.34

```js
keywordOverlapScore(content, question)
```

Tokenises both strings with `/[a-z0-9]+/g` after lowercasing. From the
question it takes the unique tokens that are longer than 2 characters and not
in a 28-word `STOPWORDS` set (`the, a, an, is, are, was, were, to, of, in, on,
for, and, or, i, you, it, what, which, do, does, my, me, that, this, with, be,
can, will, about`). Score is `round(hits / qWords.length * 100)`, where a
"hit" is that token appearing anywhere in the answer's token set. If the
question has no scoreable tokens after filtering, it returns a neutral 50.

This is bag-of-words containment, not similarity: no stemming, no lemmas, no
synonyms, no embeddings, no position or frequency weighting. "priced" does not
match "price". It is by far the heaviest criterion, so in practice the ranking
is dominated by lexical echo of the prompt.

### `structure` — weight 0.16

Starts at 40 and adds:
- `+30` if `/(^|\n)\s*[-*\d]/` matches — a line beginning with `-`, `*`, or a
  digit (so a numbered list *or* a line that merely starts with a number)
- `+15` if the answer splits into more than one non-empty chunk on `\n{1,}`
- `+15` if mean characters-per-line is under 220

Capped at 100. Maximum achievable is exactly 100 (40+30+15+15). The floor is
40, so an unstructured wall of text is not scored near zero — the criterion is
a bonus ladder, not a penalty.

### `actionability` — weight 0.16

Substring search over a lowercased copy for seven markers: `try`, `recommend`,
`i'd suggest`, `consider`, `best option`, `the next step`, `you should`. Score
is `min(100, hits*22 + (hasDigit ? 20 : 0) + 20)`. Baseline 20, so any answer
scores at least 20; four markers plus a digit already saturates at 100.

`try` is matched as a raw substring, so "country" and "poultry" both count as
actionability markers. That is a real false-positive surface, not a
hypothetical one.

### `concision` — weight 0.14

Pure length banding on `content.length`:

```
0 chars          → 0
< 120            → 60   (too thin to be useful)
120 – 900        → 100
901 – 1600       → 70
> 1600           → 40
```

Step function, not a curve. A 900-character answer scores 100 and a
901-character answer scores 70 — a 30-point cliff for one character. Combined
with the 0.14 weight that is a 4.2-point swing in the total, which is enough
to reorder near-tied agents.

### `calibratedConfidence` — weight 0.10

Starts at 70.
- Counts hedge words: `may, might, approximately, around, roughly, typically,
  can vary, as of, check current` (word-bounded, global).
- `+20` if the hedge count is 1–3 (calibrated).
- `−15` if the hedge count is above 5 (wishy-washy).
- `−30` if any of `guaranteed, always, definitely, 100%` appear.

Clamped to 0–100. Note the gap: exactly 4 or 5 hedges gets neither the bonus
nor the penalty, sitting at the 70 baseline. Note also that both branches can
fire — an answer with 6 hedges *and* "guaranteed" scores 70−15−30 = 25.

### `safety` — weight 0.10

Starts at 100 and subtracts:
- `−15` if the answer contains something matching `/\$?£?\d+(\.\d{2})?/`
  **and** contains none of `approx|around|roughly|as of|may vary|check|current`
- `−15` if it contains any `http(s)://` URL

Minimum 70 in practice. The intent is to punish fabricated-looking specifics —
exact prices and citations stated with false certainty, the classic
hallucination signature. Two honest caveats: the number regex is so permissive
that a bare `3` in "3 options" trips it, and the URL penalty punishes correct
sourcing as hard as invented sourcing. A model that cites a real, correct
source is penalised identically to one that invents a URL.

### Why heuristics instead of an LLM judge

The obvious alternative is a "judge" model that reads all N answers and picks a
winner. This engine deliberately does not do that, for four reasons that
follow from the system's actual constraints:

1. **Cost, measured in quota rather than dollars.** The scarce resource here
   is free-tier request budget, shared across every app pointed at the router
   (§2). A judge call is an *additional* provider request on every turn — and
   because it must read N answers, it is the largest-context request in the
   whole flow. Scoring locally makes ranking free in the only currency that
   matters.
2. **Latency.** The fan-out is already gated by the slowest of N models. A
   judge adds a strictly serial round trip after that, on the critical path,
   with the same tail-latency exposure as any other free-tier call. The
   heuristic scorer runs in sub-millisecond CPU time on strings already in
   memory.
3. **Determinism.** `scoreAndRank` is a pure function. The same question and
   the same answers produce byte-identical scores forever. That makes the
   scoring matrix rendered in the UI an auditable artefact — a user can read
   why agent 12 won — and makes the engine testable without network access or
   mocks.
4. **No recursive hallucination risk.** A judge model is itself a free-tier
   LLM with no SLA. It can hallucinate, be unavailable, be rate-limited, or
   develop preferences (verbosity bias, position bias, self-preference toward
   its own family's output style). Adding it would place an unreliable
   component in the one position that decides what the user sees. The
   heuristic scorer is dumb, but its failure modes are inspectable and
   constant.

There is also a robustness argument: because scoring is local, the availability
of the *ranking* stage is decoupled from provider availability entirely. As
long as one agent answers, ranking always completes.

### Known limitations of the scoring matrix

Stated plainly, because these are real:

- **It is gameable by keyword stuffing.** Relevance is 0.34 of the total and
  is pure containment. An answer that restates the question's nouns verbatim
  and then says nothing useful scores near 100 on the heaviest criterion. In
  a council of independent models this is mostly harmless — none of them is
  adversarial — but the property is real and would matter immediately if
  agent output were ever attacker-influenced (e.g. prompt injection through
  `extraContext`).
- **There is no semantic understanding whatsoever.** A confidently wrong
  answer that uses the right words outranks a correct answer that paraphrases.
  Nothing in this file can detect factual error. The matrix measures *shape*,
  not *truth*.
- **The weights were tuned informally, not statistically.** They are
  hand-chosen judgement calls. There is no labelled dataset, no held-out
  evaluation, no agreement study against human preference, no A/B history in
  this repo. `0.34/0.16/0.16/0.14/0.10/0.10` is a plausible prior, nothing
  stronger.
- **Several criteria have perverse gradients.** `safety` penalises citing
  sources. `concision` has a one-character cliff. `actionability` matches
  substrings and rewards any digit. `structure` rewards a leading digit even
  when it is not a list.
- **Absolute scores are not calibrated.** Floors (20 actionability, 40
  structure, 70 safety) mean totals cluster in a narrow band. `totalScore` is
  only meaningful as an *ordering* within one request, and should not be read
  as a quality percentage or compared across questions.
- **No tie-breaking policy.** `Array.prototype.sort` on equal `totalScore`
  values yields an implementation-defined order among ties. In practice V8's
  sort is stable, so ties resolve to the order the answers happened to
  complete in — which is arbitrary but not random.

---

## 4. Failure modes and partial-failure behaviour

### The key structural fact: agent calls never reject

`callAgentModel` has a `try/catch` around its entire body and returns an
object in both paths. It cannot throw. Consequently, in `council.js`:

```js
const settled = await Promise.allSettled(models.map(...));
const answers = settled.map((s) =>
  s.status === 'fulfilled' ? s.value : { ok: false, error: String(s.reason) });
```

the `rejected` branch is effectively **dead code** under current behaviour —
every entry is `fulfilled`, carrying either `{ ok:true, … }` or
`{ ok:false, … }`. `Promise.allSettled` is defensive belt-and-braces here (it
would catch a throw inside the `.then` callback, e.g. from `emit`), not the
primary error mechanism. The primary mechanism is errors-as-values.

One consequence worth noting: objects produced by the rejected branch have no
`agentNumber` field. If it ever did fire, that answer would appear in the
`answers` array of a total-failure response without an agent number.

### Walking through 20 of 28 agents failing

Assume 28 configured models, 20 fail (mixed timeouts, a provider outage, a
revoked key producing 401s, a couple of 429s), 8 succeed.

1. All 28 promises are created simultaneously. The 20 failures resolve at
   whatever point they fail — 401s in ~200 ms, the timeouts at exactly 25 s.
2. As each settles, `emit('agent', …)` fires. The browser paints 8 green
   chips and 20 red ones, interleaved in completion order.
3. **Total wall time is still ~25 s**, because the timeouts must expire before
   `allSettled` resolves. Partial failure does not make the request faster —
   in the common case it makes it *slower*, since a hung provider is the
   worst case for latency. This is worth internalising: the degraded path is
   the slow path.
4. `successes` = the 8 good answers. `successes.length !== 0`, so the council
   proceeds normally.
5. `scoreAndRank` receives 8 entries. The matrix has 8 rows, ranked 1–8.
   Agent numbers in the matrix are the original 1-based indices, so the
   surviving agents may be, say, 2, 5, 9, 13, 17, 21, 24, 28 — the UI shows
   those actual numbers, with gaps.
6. Response: `{ ok:true, winner: matrix[0], criteria, matrix, agentCount: 28,
   respondedCount: 8, failedCount: 20 }`.
7. The user sees the winning answer plus a collapsible
   `Scoring matrix — 8/28 agents responded, ranked anonymously`.

**There is no minimum-quorum check.** No `SYNTHESIS_QUORUM` constant, no
threshold, no warning, no refusal. The only branch on survivor count is
`successes.length === 0`. 8/28 and 28/28 are handled identically; the only
visible difference is the counts in the summary line and the number of rows.

### 1 survivor

Handled by the same path, with no special case. `scoreAndRank` scores the sole
answer, sorts a one-element array, assigns it rank 1, and it becomes the
winner. The user gets a single unreviewed model's output presented exactly like
a 28-way winner — the score is computed but competes against nothing. The UI's
`1/28 agents responded` is the only signal that the council collapsed to a
single opinion. **This is the most important silent degradation in the system**
and it is not flagged anywhere in the code. If you fork this for a
higher-stakes domain, a minimum-survivor threshold in `runCouncil` is the first
guard to add.

### 0 survivors

The only explicit failure branch:

```js
if (successes.length === 0) {
  emit('status', { message: 'Every agent failed to respond — check your FreeLLMAPI router and keys.' });
  return { ok: false, error: 'no_agents_responded', answers };
}
```

Note this is a *return*, not a throw — so `index.js` sends it as a normal
`{ type: 'result', result }` frame with HTTP 200 already committed (headers
were flushed before the fan-out began). The client checks `evt.result.ok` and
renders `Council failed: no_agents_responded`. The full `answers` array,
including every per-agent error string, is serialised into that response — the
one place raw provider errors reach the client.

### What explicitly does not exist in this repository

To be unambiguous about the boundaries:

- **No judge-based synthesis, fusion, or blending.** The council picks exactly
  one existing answer verbatim. It never merges answers, never asks a model to
  reconcile them, never generates new text. FreeLLMAPI's own internal fusion
  mode is deliberately bypassed — `freellmapiClient.js` pins a concrete catalog
  model id rather than `auto`/`fusion`, precisely so this engine runs its own
  uncapped panel instead of the router's capped internal one.
- **No retries or backoff.** One attempt per model per request.
- **No circuit breaking or health memory.** No state survives a request, so a
  model that has failed 50 consecutive times is called again on request 51.
- **No monitoring, metrics, alerting, or structured logging.** The only log
  line in the entire server is the `app.listen` startup message. `latencyMs`
  is measured per agent and then discarded — it is never emitted, aggregated,
  or persisted. There is no `/metrics`, no tracing, no error reporting sink.
- **No auth or per-user quotas on `/api/chat`.** It is an unauthenticated
  endpoint that spends shared free-tier quota. There is now a per-IP fixed
  window limiter (§2) and a `MAX_MESSAGE_CHARS` body cap, which blunt the
  trivial drain-it-in-a-loop case, but an attacker with many source addresses
  can still deplete the pool for every app on the router.
- **No SSE heartbeat.** During the fan-out the stream can be silent for the
  full 25 s. Intermediaries with short idle timeouts may cut it.
- **No cancellation of in-flight provider calls.** `req.on('close')` is now
  handled, so once the client goes away the server stops writing SSE frames.
  But the fan-out itself is not aborted — closing the browser tab does not
  cancel the ~28 upstream requests, and the quota is spent regardless.
  Cancelling would mean threading an `AbortSignal` through `runCouncil`.
- **No end-to-end coverage.** Unit tests exist (`tests/`, run by `vitest` via
  `npm test`, alongside the generator's `--self-test` fixtures) and
  `.github/workflows/ci.yml` runs them on Node 20 and 22. Nothing exercises
  the HTTP/SSE layer, the fan-out against a live router, or the browser client.

Health checking is split in two, and the distinction matters.

`/api/live` is liveness: `{ ok: true, uptimeSeconds }` whenever the process is
serving HTTP, checking nothing else. This is what the Docker `HEALTHCHECK`
probes, because Docker *restarts* an unhealthy container, and a restart cannot
fix a down router or an empty `agents.json`. Probing readiness from there would
restart-loop an otherwise healthy container that simply has no keys set yet.

`/api/health` is readiness: it returns `configured`, `agentCount`, and a real
`routerReachable` derived from a `GET /v1/models` probe of the router, with
`ok` requiring all three, and a **503** when any of them fails. The probe is
memoised for `ROUTER_HEALTH_TTL_MS` (default 45 s) and single-flighted, so a
burst of polls costs at most one router request per TTL — and it is a
`/v1/models` listing rather than a completion, so it does not spend model
quota. It is still the wrong thing to wire to a restarter, for the reason
above: it can fail for causes a restart will not cure.

---

## 5. Deployment topology

Two independent Fly.io apps, configured by the two files in `deploy/fly/`.
Both have an empty `app = ""` — the name is filled in by `flyctl launch`. Both
pin `primary_region = "lhr"` (London).

### App A — the FreeLLMAPI router (`deploy/fly/freellmapi.fly.toml`)

```toml
[build]
  image = "ghcr.io/tashfeenahmed/freellmapi:latest"
[env]
  PORT = "3001"
  NODE_ENV = "production"
[mounts]
  source = "freellmapi_data"
  destination = "/app/server/data"
[http_service]
  internal_port = 3001
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

Deployed from the upstream published image — no source clone, no build step,
so `flyctl deploy` is an image pull. `:latest` is unpinned, which means a
redeploy can silently move the router version; pinning a digest is the obvious
hardening step if reproducibility matters.

The `[mounts]` block is the load-bearing part. FreeLLMAPI keeps its
**encrypted provider-key database** on disk at `/app/server/data`; the
`freellmapi_data` volume (created separately, `--size 1`, i.e. 1 GB) makes
that survive machine restarts and redeploys. Without it, every deploy would
wipe every provider key and require re-entering them all through the Keys
page. The decryption secret is supplied out-of-band as the `ENCRYPTION_KEY`
Fly secret — a 32-byte random value, generated with the PowerShell
`RandomNumberGenerator` snippet in the file's header comment. Losing that
secret while keeping the volume means the key DB is unreadable.

Two operational implications of a volume-backed app on Fly:

- A Fly volume is attached to a single machine in a single region. This app is
  therefore **not horizontally scalable and not multi-region** as configured.
  Scaling it out would require either shared external storage or accepting
  divergent key databases per machine.
- Fly volumes are not backed up by default. The encrypted key DB is
  single-copy. No backup or snapshot policy exists in this repo.

### App B — this engine (`deploy/fly/app.fly.toml`)

```toml
[env]
  PORT = "4000"
[http_service]
  internal_port = 4000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

Built from the repo-root `Dockerfile`: `node:20-slim`, `NODE_ENV=production`,
`npm ci --omit=dev` against the committed lockfile, then `COPY server public
scripts` only — never `COPY . .` — with a `.dockerignore` excluding `.env*`
(bar the example), keys, and `node_modules`. A local env file therefore cannot
be baked into the image, and the build context cannot overwrite the installed
dependencies. The image runs as the unprivileged `node` user. `EXPOSE 4000`
matches `internal_port`, and `CMD ["node", "server/index.js"]`.

The image also declares a `HEALTHCHECK`, which probes `/api/live` — liveness
only, deliberately not `/api/health`. See the end of §4 for why: Docker
restarts what it judges unhealthy, so the probe must only fail for conditions a
restart can actually fix. Router reachability and configuration are reported by
`/api/health` instead, which is for a human or a readiness gate to read, not
for a supervisor to react to.

Neither file in `deploy/fly/` declares a health check, so on Fly nothing polls
either endpoint and `/api/health`'s 503 cannot restart-loop a deployed app. The
Docker `HEALTHCHECK` is currently the only automated consumer. That is safe as
it stands but load-bearing: if you later add an `[[http_service.checks]]` block,
point it at `/api/live`. Pointing a Fly check at `/api/health` would make an
unconfigured or router-down app restart forever, which is the exact failure
mode the split exists to prevent.

Wiring between the two apps is by public URL, not Fly private networking:
`FREELLMAPI_BASE_URL=https://<router-app>.fly.dev` plus the unified
`FREELLMAPI_API_KEY`, both set as Fly secrets. Traffic between the app and the
router therefore leaves and re-enters Fly's edge over HTTPS. Using
`.internal` 6PN addressing would keep it private and cut a hop; the configs as
written do not.

### Fly free-tier shape choices, and their operational reality

Both apps use the smallest practical shape: `shared-cpu-1x`, 512 MB, one
machine, one region.

- `auto_stop_machines = false` with `min_machines_running = 1` means **both
  machines stay up permanently.** This trades idle cost for the elimination of
  cold starts. It is the right call for the router in particular: a
  scale-to-zero router would add several seconds of machine boot to the
  *first* of 28 concurrent calls, and the fan-out would slam a cold machine
  with 28 simultaneous requests. `auto_start_machines = true` remains as a
  safety net if a machine is stopped by other means.
- **512 MB on the app is comfortable** — Node holding at most 28 in-flight
  `fetch`es and a few hundred KB of response text. Memory is not the
  constraint.
- **A shared vCPU is the right choice** because the workload is almost
  entirely I/O wait. The only CPU work is `JSON.parse` and the regex scoring
  pass, both trivial. Buying dedicated CPU would buy nothing.
- **Single region, single machine, no redundancy.** Either app going down
  takes the service down; the router going down takes *every* dependent app
  down (§7). There is no health-check-driven restart policy beyond Fly's
  defaults and no `[checks]` block in either file.
- Consumption on Fly's current pricing is usage-based rather than a fixed free
  allowance, so "free tier" here means "two of the smallest always-on
  machines plus a 1 GB volume" — small, but not literally zero, and it does
  not vary with request volume at this scale.

---

## 6. Extension points

The README's "Adapting this to a specific project" lists five steps. Here is
what each one actually touches in the code.

### 6.1 `systemPrompt`

```js
export async function runCouncil({ question, config, systemPrompt, extraContext, onEvent })
```

Falsy `systemPrompt` falls back to `DEFAULT_SYSTEM_PROMPT` ("You are a
helpful, concise assistant. Answer directly and avoid padding."). It becomes
`messages[0]` and is sent identically to every model — there is no per-model
prompt variation, so the panel's diversity comes purely from model diversity,
not from prompt diversity.

**Important:** `server/index.js` does **not** currently pass `systemPrompt` or
`extraContext` — the HTTP layer only forwards `question`, `config`, and
`onEvent`. These parameters are a library-level API for code that imports
`runCouncil` directly. To use them over HTTP you must edit the `/api/chat`
handler yourself. The README describes the function's contract accurately; it
is the Express route that is deliberately generic.

Note also that the system prompt materially interacts with scoring: a prompt
that asks for bullet points raises every agent's `structure` score, and one
that demands brevity pushes answers into the `concision` 100-band. Prompt and
scoring rubric should be designed together, not independently.

### 6.2 `extraContext`

```js
...(extraContext ? [{ role: 'system', content: extraContext }] : []),
```

A second system message, inserted between the system prompt and the user turn.
This is the RAG seam. The README is explicit that retrieval happens *before*
the call, not inside it — `council.js` performs no fetching, has no knowledge
of any data source, and stays domain-free.

Practical constraints, since nothing enforces them:

- The same context string is sent to all N models, N times. There is no
  truncation, no token counting, and no per-model context-window awareness. A
  large `extraContext` multiplied by 28 calls is both a quota and a
  latency amplifier, and will simply 400 on models whose window it exceeds
  (surfacing as `ok:false` for those agents).
- `extraContext` is untrusted input from the model's perspective. Since
  `relevance` is gameable (§3) and text injected here reaches every agent,
  injected instructions in retrieved data are a real threat surface. Nothing
  in this repo sanitises it.

### 6.3 Adding a criterion to `CRITERIA`

`scoring.js` reads `CRITERIA` generically — `scoreAndRank` iterates it, and
`scoreAndRank` returns `CRITERIA.map(({ key, weight, describe }) => …)` so the
UI's table columns are generated from the array. `public/app.js` builds its
`<th>` cells from `result.criteria`, using `describe` as the tooltip. **Adding
a criterion requires no changes to `council.js`, `index.js`, or `app.js` — the
new column appears automatically.**

The contract for a new entry:

- `key` — unique string, becomes the object key in `criteriaScores` and the
  column header.
- `weight` — number. Nothing validates that weights sum to 1.0; if you add
  0.15 without reducing the others, totals simply exceed 100 and remain
  internally comparable but no longer 0–100. Renormalise deliberately.
- `describe` — one line, shown as the column tooltip.
- `score({ content, question })` — must be **pure** and **synchronous**, and
  must return a number (0–100 by convention). There is no `await` anywhere in
  the scoring path, so an async criterion is not supported without changing
  `scoreAndRank`. It also receives only `content` and `question` — not the
  model id, not `extraContext`. A criterion needing extra data requires
  threading it through `scoreAndRank`'s signature and `runCouncil`'s call site.

### 6.4 What a `groundedness` criterion would concretely look like

This does **not** exist in the repository — the codebase is domain-agnostic by
design and ships no such criterion. The following is illustrative pseudocode
for a fork that injects `extraContext`.

The core idea: extract the checkable claims from the answer (numbers, proper
nouns, quoted spans), and verify each appears in the injected context.

```js
// In a fork of scoring.js. Requires threading `context` through
// scoreAndRank(question, agentAnswers, context) and runCouncil's call site,
// since score() currently only receives { content, question }.

{
  key: 'groundedness',
  weight: 0.20,          // and reduce relevance 0.34 → 0.20 to renormalise
  describe: 'Every checkable specific in the answer appears in the injected context',
  score: ({ content, context }) => {
    if (!context) return 50;             // neutral when nothing was injected

    // 1. pull out the claims worth checking
    const claims = [
      ...extractNumbers(content),        // prices, quantities, years
      ...extractProperNouns(content),    // capitalised multiword spans
      ...extractQuotedSpans(content),    // "..." — must be verbatim
    ];
    if (claims.length === 0) return 60;  // nothing specific asserted:
                                         // not grounded, but not fabricating

    // 2. check each against the context, normalised the same way
    const haystack = normalise(context);
    const supported = claims.filter((c) => haystack.includes(normalise(c)));

    // 3. ratio, with an extra penalty for confident unsupported numbers
    const ratio = supported.length / claims.length;
    const unsupportedNumbers = claims.filter(isNumeric)
      .filter((c) => !haystack.includes(normalise(c))).length;

    return clamp(Math.round(ratio * 100) - unsupportedNumbers * 10, 0, 100);
  },
}
```

Design notes for anyone implementing it for real:

- **Substring containment is the honest ceiling for a local heuristic.** It
  catches the failure that matters most — a model inventing a price, date, or
  name that is nowhere in the retrieved data. It cannot catch a correct
  paraphrase asserting something the context contradicts. Do not oversell it
  as fact-checking; it is fabrication detection.
- **Normalise both sides identically** (case, whitespace, currency symbols,
  thousands separators) or you will reject `£1,250` against `1250`.
- **Guard the empty-context case**, or every answer scores 0 on turns where
  retrieval found nothing, and the criterion silently inverts the ranking.
- **Reward abstention.** An answer that correctly says "the data doesn't cover
  that" asserts no claims; the `claims.length === 0` branch must not punish it
  more harshly than a confident fabrication.
- **Consider reworking `safety` alongside it.** Once groundedness exists, the
  blanket `−15` for URLs is counterproductive — a URL present in the injected
  context is exactly what you want cited.

### 6.5 `agents.json` and `public/`

`server/config/agents.json` is re-read from disk on **every** request
(`loadAgentModels()` in the health, config, and chat handlers) — there is no
caching, so editing the file takes effect on the next request with no restart,
at the cost of a file read and JSON parse per call. The array is hard-capped
by `.slice(0, 28)` in `index.js`; extra entries are silently ignored. The
shipped file lists only 3 placeholder ids and a `_comment` telling you to
replace them. Fewer than 28 is fine — nothing depends on
the count except the "Consulting our N agents…" message.

The file can be written by hand, but the supported path is
`npm run generate-agents` (`scripts/generate-agents.mjs`). It reads
`FREELLMAPI_BASE_URL` / `FREELLMAPI_API_KEY` from the environment, calls
`GET {baseUrl}/v1/models` on your own router with a 20 s timeout, and selects a
panel. Selection groups the catalog by provider (`owned_by`, falling back to the
id's namespace prefix when the router does not label it) and round-robins so
every provider contributes one model before any provider contributes a second;
within a provider it alternates largest/smallest context window so a partial
take still spans the range. Unavailable models and the `auto`/`fusion`
pseudo-models are excluded — the latter deliberately, for the same reason
`freellmapiClient.js` pins concrete catalog ids (§2). The cap is `--max=N`
(or `MAX_AGENTS`), default 28, matching `index.js`'s `.slice(0, 28)`.

The script is fail-closed: missing env, an unreachable or non-2xx router, an
unparseable payload, or zero usable models all print an error, leave
`agents.json` untouched, and exit 1. `--dry-run` prints the plan without
writing. Note that a generated file's `_comment` is replaced with a generation
timestamp and provider count, so it no longer carries the "check `/v1/models`
yourself" instruction the shipped file has.

`public/` is three unbundled static files served by `express.static`. There is
no build step, no framework, no npm frontend dependency.

---

## 7. Honest limitations

- **No SLA, at any layer.** Every model behind the router is a free tier.
  Providers can and do change model ids, deprecate models, tighten daily caps,
  add latency, or return errors without notice. This project has no contract
  with any of them. Availability is best-effort by construction.
- **The router is a single point of shared failure.** One Fly machine, one
  region, one volume, serving this engine plus Virtual Yanny plus ScholApply
  plus anything else pointed at it. If it goes down, every dependent app fails
  simultaneously and completely — the council does not degrade gracefully past
  the router, because there is no fallback path to any provider. There is no
  second router, no failover URL, and no direct-provider bypass in the code.
- **Quota is shared and unpartitioned.** One app's traffic spike degrades all
  the others (§2). Nothing in this repo meters, budgets, prioritises, or even
  observes consumption.
- **No training, fine-tuning, or learning happens here.** This is pure
  inference against third-party endpoints. No model weights exist in this
  project, no data is collected for training, and no user data is persisted at
  all — each request is stateless and forgotten. The scoring "matrix" is a
  weighted sum of regexes, not a learned ranker; nothing improves with usage.
- **Scoring is heuristic and unvalidated.** No semantic understanding, no
  ground truth, no evaluation set, informally tuned weights, several perverse
  gradients (§3). It reliably filters out empty, rambling, or off-topic
  answers. It cannot tell you which answer is *correct*.
- **Single-opinion collapse is silent.** With one survivor the user receives an
  unreviewed single-model answer presented identically to a 28-way consensus
  winner (§4). Only the small `1/N agents responded` line distinguishes them.
- **The user is never told why an agent failed.** Red ✗ chips only. Diagnosis
  requires server-side inspection, and there is nothing to inspect: no logs,
  no metrics, no traces, no alerting.
- **Request-level protection is partial.** A per-IP rate limit and a message
  size cap exist, but there is still no auth, and a disconnecting client stops
  the stream without cancelling the upstream fan-out it already paid for.
- **Testing stops at the unit boundary.** `scoring.js`, `council.js`, the rate
  limiter, and request validation have unit tests, run in CI on Node 20 and 22.
  Nothing covers the HTTP/SSE layer or a real fan-out, so a regression in
  streaming or in the router call itself would not be caught.
- **This is an engine, not a product.** It needs a domain layered on top —
  system prompt, retrieval, and usually a domain criterion — before it is
  useful to an end user. `Virtual Yanny` and `ScholApply` are the worked
  examples.
