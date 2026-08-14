# Contributing

This is a small, deliberately thin engine. The bar for changes is
"does it stay generic?" — domain-specific logic belongs in the project
built on top of it, not here.

## Getting set up

```bash
npm install
cp .env.example .env   # fill in FREELLMAPI_BASE_URL / FREELLMAPI_API_KEY
npm start              # http://localhost:4000
npm run dev            # same, with --watch
```

You don't need a working FreeLLMAPI router to run the tests — every test
stubs the network. You do need one to exercise `/api/chat` for real.

## Tests

```bash
npm test          # generate-agents self-test + vitest unit tests
npm run test:unit # vitest only
npm run test:watch
```

CI runs `npm test` on Node 20 and 22 for every push and pull request
(`.github/workflows/ci.yml`). Please add tests with behaviour changes —
`tests/` mirrors `server/`, and the existing files show the patterns:
`vi.mock` for the FreeLLMAPI client, a stubbed global `fetch` for the
client's own tests, an injected clock for the rate limiter.

Anything touching `/api/chat` should also be exercised by hand at least
once (`curl -N -XPOST localhost:4000/api/chat -H 'content-type:
application/json' -d '{"message":"hi"}'`) — SSE bugs hide from unit
tests.

## What belongs where

| File | Responsibility |
| --- | --- |
| `server/index.js` | HTTP surface: validation, limits, SSE plumbing. No council logic. |
| `server/council.js` | Fan-out, event emission, orchestration. No HTTP, no scoring maths. |
| `server/scoring.js` | Pure, deterministic, domain-agnostic scoring. No I/O. |
| `server/freellmapiClient.js` | The only file that talks to the router. Never throws. |
| `server/rateLimit.js` | In-memory fixed-window limiter. |
| `scripts/generate-agents.mjs` | Builds `server/config/agents.json` from `GET /v1/models`. |

Keep `scoring.js` free of topic vocabulary and free of I/O — its whole
value is being deterministic and reusable. If you need domain scoring,
add a criterion in *your* fork/copy, as the README describes.

## Style

- ES modules, Node 20+, no build step, no transpiler.
- No new runtime dependencies without a clear reason — dev dependencies
  are cheaper, runtime ones are a maintenance and supply-chain cost.
- Comments should explain *why*, not restate the code.
- `callAgentModel()`'s return shape (`ok`, `model`, `content`, `error`)
  is a public contract — add optional fields, don't change existing ones.

## Pull requests

- One logical change per PR, with a message that says what and why.
- Green CI before review.
- Don't commit `.env`, keys, or a regenerated `agents.json` that only
  matches your own router.

## Security

Don't open a public issue for anything sensitive — report it privately
to the repository owner instead.
