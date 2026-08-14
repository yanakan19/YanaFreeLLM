# Provider coverage

What this router can talk to, what each provider actually gives away for free,
how much pain it is to sign up, and when to stop adding providers.

**Sourcing rules used here.** Every claim is tagged with where it came from:

- **[router]** — read directly out of FreeLLMAPI's own source, which carries
  dated live-probe notes:
  [`server/src/providers/index.ts`](https://github.com/tashfeenahmed/freellmapi/blob/main/server/src/providers/index.ts)
  and [`docs/architecture.md`](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/architecture.md).
  This is the most trustworthy source in this document — the maintainer probed
  these endpoints with real keys and wrote down the date.
- **[secondary]** — found via web search on third-party pricing/round-up sites.
  Directionally useful, **not authoritative**. Several official docs hosts
  (`ai.google.dev`, `console.groq.com`, `openrouter.ai`,
  `developers.cloudflare.com`, `freellmapi.co`) are blocked by the network
  egress proxy in the environment this document was researched from, so first-party
  confirmation was not possible for those. Treat every number tagged
  [secondary] as "probably right, verify on the provider's own pricing page
  before you rely on it".
- **unverified** — stated plainly where nothing credible was found. No number
  has been invented to fill a gap.

Free tiers move constantly. Anything here is a snapshot, not a contract.

---

## 1. The ten you have or are adding

| # | Provider | Free tier (what you actually get) | Card needed? | Source |
|---|---|---|---|---|
| 1 | **Google AI Studio (Gemini)** ✅ added | Per-model RPM/TPM/RPD caps; ~10 RPM / 250K TPM / ~500 RPD on `gemini-2.5-flash`-class models. Google cut free quotas 50–80% in Dec 2025, so older blog numbers overstate it. | No | [secondary] |
| 2 | **Groq** ✅ added | ~30 RPM, 6K–30K TPM, 1,000–14,400 RPD depending on model. Limits are **per organization, not per key** — extra keys do not multiply quota. Fastest latency in the pool. | No | [secondary] |
| 3 | **Mistral (La Plateforme)** ✅ added | Free "Experiment" plan, all models, roughly 1B tokens/month ceiling reported; Mistral stopped publishing exact per-model free numbers — read Admin Console → Limits on your own account. | No | [secondary] |
| 4 | **Cohere** ✅ added | Trial key: ~1,000 calls/month, ~20 req/min chat, ~5 req/min embed. **See the ToS flag in §3b — this is the one provider FreeLLMAPI marks ❌ Avoid for personal use.** | No | [secondary] + [router] |
| 5 | **OpenRouter** 🔜 | `:free`-suffixed models. ~20 req/min, and **50 requests/day** on an unfunded account; a one-time $10 credit purchase raises that to ~1,000/day permanently. | No for the 50/day tier | [secondary] |
| 6 | **Cerebras** 🔜 | ~1M tokens/day recurring, ~30 RPM, free-tier context often capped around 8K. Extremely fast. Genuinely recurring, not a trial credit. | No | [secondary] |
| 7 | **NVIDIA NIM** (build.nvidia.com) 🔜 | The old credit system is **discontinued**. Access is now a per-account rate limit, ~40 RPM baseline, increases by forum request. | No | [router] + [secondary] |
| 8 | **Cloudflare Workers AI** 🔜 | 10,000 Neurons/day, resets 00:00 UTC (~1,300 LLM responses/day, order-of-magnitude). Key format in FreeLLMAPI is `account_id:token`. | No on the Workers Free plan | [secondary] + [router] |
| 9 | **Hugging Face (Inference Providers router)** 🔜 | Recurring **$0.10/month** of router credit on the free account. That is tiny — a few hundred small calls, not a workhorse. | No | [router] + [secondary] |
| 10 | **Reka** 🔜 | Recurring monthly credit grant, no card, key from `platform.reka.ai`. FreeLLMAPI live-probed it 2026-06-17 and saw billed calls succeed with no 402. Third-party sources say **$10/month recurring**, which if accurate is one of the best free grants on this list. Balance is dashboard-only (no credits API), so the router cannot see how much is left. | No | [router] + [secondary] |

Two corrections worth absorbing before you add them:

- **Hugging Face was removed and then re-added.** FreeLLMAPI's `architecture.md`
  still lists HF as dropped ("tool-call format issues"), but the provider source
  says that removal applied to the legacy serverless route and the new
  `router.huggingface.co` meta-router was **re-added in V13**. The provider file
  is newer and correct. HF works — it is just worth ~$0.10/month.
- **Cohere is already in your router and is the one with a real ToS problem.**
  See §3b.

---

## 2. Everything else FreeLLMAPI supports

Taken from the router's provider registry (the authoritative list — the README
only names 12 and says "…and 17 more"). Grouped by how much work signup is.

### Tier A — keyless. Zero friction, add them today.

These need no account at all; FreeLLMAPI registers them `keyless: true` and
auto-configures them.

| Provider | Free tier | Notes | Source |
|---|---|---|---|
| **AI Horde** | Free forever, community/volunteer GPUs, anonymous key `0000000000` | Queue-based: tens of seconds per call, no tool calling, `max_tokens >= 16`. Non-profit (Haidra), no anti-proxy clause. Great as a last-resort fallback, useless for latency-sensitive paths. | [router] |
| **OVH AI Endpoints** | Anonymous: ~2 req/min per IP per model (authenticated is 400 req/min but needs a Public Cloud project **with a payment method**) | Keyless row is the no-card path. Live-probed 2026-06-10 with working structured tool calls on `gpt-oss-120b` and Llama-3.3-70B. OVH reserves the right to add token caps. | [router] |
| **Kilo Gateway** | Anonymous access to `:free` routes, ~200 req/hr per IP | **Free prompts and outputs are logged for training.** Most "free" routes there eventually go paid. | [router] |

### Tier B — instant no-card API key. High value per minute of setup.

| Provider | Free tier | Friction | Source |
|---|---|---|---|
| **Z.ai / Zhipu (`open.bigmodel.cn`)** | GLM-4.x-Flash family free, ~1,000 req/day reported | Email or phone verification. Note FreeLLMAPI treats **Zhipu CN and Z.ai Singapore as separate entities** with different ToS verdicts (see §3b). GLM Flash is genuinely capable — best value in Tier B. | [router] + [secondary] |
| **Ollama Cloud** | Free plan: 1 concurrent model, 5-hour session caps, GPU-time quota (not per-token) | Many models on `/v1/models` are subscription-only and 403 on Free; FreeLLMAPI filters the catalog to confirmed-free rows. Hosts frontier open models (GLM-4.7, Kimi K2 Thinking) but slowly — 30–90s is normal. | [router] |
| **SEA-LION (AI Singapore)** | Recurring free tier, ~10 RPM | Google sign-in, no card, no region wall. Southeast-Asian-language specialist; narrow but clean. | [router] |
| **SiliconFlow** | Free generative-media models (FLUX.1-schnell image, CosyVoice2 TTS) plus OpenAI-compatible chat | No card. Mainly worth it if you want free **image/TTS**, not for chat throughput. | [router] |
| **LLM7.io** | ~100 req/hr free; anonymous access works for basic models | Wraps GPT-OSS, Llama 3.1 Turbo, Codestral, Ministral, GLM-4.6V-Flash behind one token. | [router] |
| **AnyAPI** | $0, no card, recurring — but the binding cap is **100K tokens/day**, free/basic models only | AnyAPI publishes no RPM/RPD at all. The "20 RPM / 200 RPD" figure circulating for it is actually OpenRouter's, mis-attributed. Model IDs in FreeLLMAPI are unverified candidates. | [router], checked 2026-08-10 |
| **Aion Labs** | Free key, no card; recurring free availability catalog-managed | Thin public documentation. Quota numbers **unverified — check the provider's current pricing page.** | [router] |
| **Requesty** | Free key, no card; free model rows age into the public catalog | Quota numbers **unverified.** | [router] |
| **Routeway** | `:free`-suffixed models at $0 | Docs claim 20 rpm / 200 rpd; a live test on 2026-06-26 observed a much stricter **5 rpm**. Cloudflare in front rejects non-browser User-Agents (error 1010). Believe the observed number, not the docs. | [router] |
| **BazaarLink** | Only the `auto:free` route is free (direct model IDs are paid) | Supports agent self-registration, no card. Routed to `deepseek-v4-flash` in a 2026-06-26 test with `usage.cost` 0. | [router] |
| **AINative Studio** | Advertises ~10M tokens/month recurring, no card | **Its own pages disagree on the scale** — FreeLLMAPI explicitly says treat the quota as unverified until a real account confirms it. Do not plan around 10M. | [router] |
| **Agnes AI (Sapiens)** | Proprietary Agnes models served at $0/token — live-probed 2026-06-15, LiteLLM cost headers came back `0.0` with no credit drain, so genuinely free rather than a signup grant | ~30 concurrent before 429s; no documented RPM/RPD. The $0 is explicitly **promotional** ("during this period") with a paid tier underneath — expect reversion. | [router] |
| **OpenCode Zen** | A handful of promotional models free for a limited time | Free account key from `opencode.ai/auth`, no card. **Trial-only roster, and prompts/outputs may be used to improve the models.** | [router] |
| **Pollinations** | Recurring shared-capacity tier; free capacity accrues at one "pollen" per IP per hour | Needs a real publishable key for chat. Legacy `text.pollinations.ai` host was 502ing in the July 2026 audit; current host is `gen.pollinations.ai`. | [router] |

### Tier C — extra verification, an existing account, or a region wall.

| Provider | Free tier | Friction | Source |
|---|---|---|---|
| **GitHub Models** | ~50 req/day on high-tier models (~10 RPM), ~150 req/day on mini models; 8K in / 4K out cap, concurrency 2 | Needs a GitHub account; limits scale with your Copilot subscription tier. Hosts GPT-4o-class models — **highest quality per request in the free pool**, but the daily cap is brutal. | [secondary] + [router] |
| **NaraRouter** | Free plan, no card | Requires **Telegram channel/link verification**. Live-probed 2026-07-09: only `mistral-large`, `mistral-medium-3-5`, `tencent-hy3` answered on a zero-balance account; everything else was credit-gated. | [router] |
| **NavyAI** | Free plan: **150K tokens/day, 20 RPM** | Key comes from a **Discord-backed dashboard**. Requires an explicit User-Agent header. | [router] |
| **ModelScope (Alibaba)** | 2,000 requests/day account-wide — a large number | **Hard blocker for most people outside China:** tokens only work after binding the ModelScope account to an Alibaba Cloud **China-site** account with Chinese real-name verification. Unbound tokens 401 on every call. Also: requests for retired model IDs return `429 insufficient balance`, which the router misreads as out-of-credits and benches the key ~24h. | [router] |

### Recommended add order

Add in this order — easiest and highest value first:

1. **AI Horde, OVH, Kilo** — keyless. No account, no key to expire, no
   maintenance. Do these before anything else; they are pure upside as tail
   fallbacks. (Accept Kilo's training-on-prompts term first.)
2. **Z.ai / Zhipu** — best capability-per-signup-minute left on the board. GLM
   Flash is a real model with a real ~1,000 req/day allowance.
3. **GitHub Models** — you almost certainly already have the account. Small
   daily cap but the best models in the free pool; put it at the *top* of the
   fallback chain, not the middle.
4. **Ollama Cloud** — frontier open-weight models, no card. Slow. Good for the
   "quality over latency" slot.
5. **NavyAI (150K tok/day), LLM7 (100 req/hr), SEA-LION (10 RPM)** — documented,
   concrete, no-card quotas. Real incremental capacity.
6. **SiliconFlow** — only if you want free image/TTS.
7. **AnyAPI, Routeway, BazaarLink, Aion, Requesty, AINative, Agnes, OpenCode Zen,
   Pollinations** — the long tail of aggregators. Individually small, mostly
   undocumented, most likely to silently break. This is where diminishing
   returns bite (§4).
8. **NaraRouter** — Telegram verification for three working models. Poor trade.
9. **ModelScope** — skip unless you have Alibaba Cloud CN with real-name
   verification. The 2,000 req/day is attractive and unreachable.

---

## 3. Flags

### (a) Credit card / payment method — hold vs. actual charge

The distinction that matters: an **authorization hold** is a temporary
pending amount your bank releases in a few days and never settles. An
**actual charge** settles. A third case — a **card on file with metered
overage** — is neither until you exceed the free allocation, and that is where
real money accidents happen.

| Provider | Card at signup? | What kind of risk |
|---|---|---|
| **Google AI Studio, Groq, Mistral, Cohere, Cerebras, OpenRouter (50/day tier), Hugging Face, Reka, Z.ai, Ollama Cloud, SEA-LION, SiliconFlow, LLM7, AnyAPI, Routeway, BazaarLink, Aion, Requesty, AINative, Agnes, OpenCode Zen, Pollinations, NavyAI, NaraRouter** | **No card at all.** | No hold, no charge, nothing to reverse. Nothing can be billed because no instrument exists on the account. |
| **AI Horde, Kilo, OVH (anonymous mode)** | No account at all. | Zero. |
| **Cloudflare Workers AI** | No card required on the **Workers Free** plan. | The 10,000 Neurons/day cap is enforced by refusal, not overage billing, while you stay on Free. **The risk is later:** if you ever upgrade to Workers Paid for an unrelated reason, Workers AI silently starts metering at $0.011/1,000 Neurons above the free allocation — a real charge, not a hold. Keep the account on Free. |
| **OVH (authenticated mode, 400 req/min)** | **Yes — requires a Public Cloud project with a payment method on file.** | This is the classic trap: a cloud account with billing enabled, where the free tier is an allocation inside a metered product. OVH may place a small verification authorization (a hold) at project creation. Overage past documented limits would be a real charge. **Use OVH's keyless anonymous mode instead** — that is exactly why FreeLLMAPI ships the keyless row. |
| **NVIDIA NIM** | No card. | Not a billing risk. The credits model was retired entirely; access is now rate-limited, so exceeding it produces 429s, not invoices. |
| **OpenRouter, if you take the $10 credit upgrade** | Yes, for that purchase. | That is a **real, intentional $10 charge** — not a hold. Prepaid credit that does not expire. Only do it deliberately; the 50/day free tier needs no card. |
| **Chutes** (evaluated, **not** integrated) | Effectively yes. | FreeLLMAPI probed it and every model returned 402: *"Quota exceeded and account balance is $0.0, please pay with fiat or send tao."* Its "free" tier requires a non-zero balance. Dropped for exactly this reason. Do not chase it. |

**Bottom line for you:** of everything in this document, only two things can
produce a real charge — deliberately buying OpenRouter credits, and running
Cloudflare Workers AI on a *Paid* Workers plan. Nothing on this list places a
verification hold on a card during normal free signup, because nothing on this
list takes a card during normal free signup except OVH's authenticated path,
which you should not use.

### (b) ToS restrictions worth knowing for a personal multi-app router

FreeLLMAPI re-reviewed every provider's ToS against a self-hosted, single-user
setup in May 2026. Its verdicts [router]:

- **Cohere — ❌ Avoid.** Terms §14 forbids use for *"personal, family or
  household purposes."* This is the sharpest conflict on your list and Cohere
  is **already in your live router**. A personal council chatbot is arguably
  exactly what §14 excludes. Their trial keys are also explicitly non-production.
  Consider dropping it or being deliberate about the risk.
- **Google Gemini — ⚠️ Caution.** March 2026 ToS narrows scope to *"professional
  or business purposes, not for consumer use."* A self-hosted developer proxy is
  defensible, but the clause is new. Separately: **free-tier prompts may be used
  to train Google's models** [secondary]. Do not send anything sensitive.
- **NVIDIA NIM — ⚠️ Caution.** Trial ToS §1.2/§1.4: *"evaluation only, not
  production."*
- **GitHub Models — ⚠️ Caution.** Free tier explicitly scoped to
  "experimentation" and "prototyping."
- **Z.ai (api.z.ai, Singapore) — ⚠️ Caution.** §III.3(l) anti-traffic-redirect
  clause could plausibly be read against a proxy; no personal-use carve-out.
  **Zhipu (open.bigmodel.cn, CN) — ✅ likely OK**, it still has a
  personal/non-commercial research carve-out. Same models, different entity,
  different answer — prefer the CN endpoint if you can sign up for it.
- **Cloudflare Workers AI — ⚠️ Ambiguous.** No anti-proxy clause, just the
  general Self-Serve Subscription Agreement.
- **Kilo Gateway — free prompts and outputs are logged for training.**
- **OpenCode Zen — prompts/outputs may be used to improve their models.**
- **✅ Likely OK:** Groq, Cerebras, Mistral, OpenRouter (its April 2026 ToS
  sharpened no-resale/no-competing-service, but a private single-user proxy is
  still fine), Ollama Cloud, OVH, AI Horde.

Four rules keep essentially every provider happy: **one account per provider**,
**no reselling**, **never share your endpoint with another human**, **don't use
a free tier as a production backend**. The last one matters most for a router
like this — it makes it very easy to accidentally behave like a production load.

Not legal advice. Read the terms you accepted.

### (c) No longer free / deprecated since last documented

Evidence found, all [router]:

- **SambaNova — permanently gone.** Dropped in FreeLLMAPI V23 (June 2026). The
  always-free tier was retired in early 2025 for a one-time $5 trial credit that
  expires in 3 months; once it lapses every chat call 402s "payment method
  required" with no recurring no-card path back. Ignore any 2024-era guide that
  still recommends it.
- **Moonshot (Kimi) direct — moved to paid only.** Direct integration dropped.
  Kimi models are still reachable via OpenRouter.
- **MiniMax direct — dropped**, superseded by the OpenRouter
  `minimax/minimax-m2.5:free` route.
- **NVIDIA's API credit system — discontinued.** Replaced by per-account rate
  limits (~40 RPM baseline). Any guide promising "1,000 free NVIDIA credits" is
  describing a system that no longer works the way it says.
- **Chutes — never was free** in the sense that matters (see §3a).
- **Hugging Face — the *opposite* of deprecated:** removed in V4, re-added in
  V13 via the new `router.huggingface.co` meta-router. FreeLLMAPI's
  `architecture.md` still carries the stale removal note; the provider source is
  newer. Trust the source file.
- **Agnes AI and OpenCode Zen are the most likely next deprecations** — both are
  explicitly promotional/trial pricing with a paid tier underneath, per their own
  descriptions.

---

## 4. Diminishing returns

Honest read, not a sales pitch.

**Quota is not the constraint you think it is.** With Groq, Gemini, Cerebras,
Mistral, and OpenRouter alone you have on the order of a million-plus tokens a
day. A council-style app that fans one question out to N models is
request-heavy, not token-heavy — so the binding limit is almost always **RPD and
RPM**, not tokens. Cerebras giving you 1M tokens/day does not help if you can
only make 30 requests a minute. Adding a provider that grants tokens without
granting requests adds close to nothing.

**Where the real curve sits.** Roughly:

- **Providers 1–5** (roughly the ones you have plus OpenRouter/Cerebras): this
  is where nearly all the value is. You go from "runs out constantly" to
  "comfortably serves personal use all day."
- **Providers 6–12** (adding NVIDIA, Cloudflare, GitHub Models, Z.ai, Ollama,
  the keyless three): meaningful, but the gain is now mostly **diversity, not
  volume** — different model families, different failure modes, coverage when a
  provider has an outage or degrades late in the UTC day. That diversity is
  genuinely worth having for a council app specifically, because scoring
  answers from five near-identical Llama variants is worth less than scoring
  answers from five different labs.
- **Providers 13+** (the aggregator long tail — Routeway at an observed 5 rpm,
  BazaarLink's single `auto:free` route, AINative's disputed quota, NaraRouter's
  three working models): each adds a few percent of capacity and a full unit of
  operational burden. Several of these aggregators are themselves reselling
  the same upstream free tiers you already hold keys for, so the "extra" quota
  is partly the same quota counted twice.

**The costs nobody prices in.** Each additional provider is: one more key to
rotate, one more account that can be suspended, one more silent expiry
(promotional $0 reverting to paid — Agnes and OpenCode Zen have said outright
this will happen), one more wire-format quirk, and one more entry in a fallback
chain whose ordering you now have to reason about. FreeLLMAPI's health checks
mitigate this well — a dead key gets marked and skipped rather than breaking
requests — which is the main reason the tail is *tolerable* at all. But
tolerable is not free.

**Concrete recommendation.** Land at **12–14 providers**: your ten, plus the
three keyless ones (which cost nothing to maintain because there is no key), plus
Z.ai. Stop there. Revisit only when you hit an actual, observed rate limit in
your own logs — the router's analytics page shows per-provider 429s, so let that
tell you what to add rather than adding preemptively. Adding provider #20 on
speculation is strictly worse than adding provider #13 in response to a
measured 429.

**One structural caveat.** More providers make the *median* response cheaper but
not the *worst* response better. The free-tier ceiling is a real ceiling —
per FreeLLMAPI's own limitations doc, the catalog tops out around Llama 3.3 70B
/ GLM-4.5 / Qwen 3 Coder / Gemini 2.5 Pro, and effective intelligence *degrades
through the day* as the best models hit their daily caps and the chain falls
through to weaker ones, resetting at UTC midnight. No number of aggregators
fixes that. If a specific task needs frontier reasoning, pay for one real API
key for that path and keep the free council for everything else.

---

*Researched August 2026. Provider free tiers change weekly — re-check anything
here before depending on it.*
