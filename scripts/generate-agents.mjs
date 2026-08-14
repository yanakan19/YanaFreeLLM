#!/usr/bin/env node
/**
 * Generates server/config/agents.json from the live catalog of a self-hosted
 * FreeLLMAPI router (GET {FREELLMAPI_BASE_URL}/v1/models).
 *
 * The goal is a maximally DIVERSE council panel: as many distinct providers
 * (`owned_by`) as possible before any provider is used twice, and within a
 * provider a spread of context-window sizes rather than N near-identical
 * small models.
 *
 * Usage:
 *   npm run generate-agents                 # writes server/config/agents.json
 *   npm run generate-agents -- --dry-run    # prints the plan, writes nothing
 *   npm run generate-agents -- --max=12     # cap the panel at 12 models
 *   npm run generate-agents -- --self-test  # run the built-in fixture check
 *
 * Env: FREELLMAPI_BASE_URL, FREELLMAPI_API_KEY (from .env, never committed),
 *      MAX_AGENTS (default 28, overridden by --max).
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AGENTS_PATH = path.join(__dirname, '..', 'server', 'config', 'agents.json');

export const DEFAULT_MAX_AGENTS = 28;
/** Virtual/meta models the router exposes that aren't a single real model. */
export const PSEUDO_MODELS = new Set(['auto', 'fusion']);

const FETCH_TIMEOUT_MS = (Number(process.env.CATALOG_TIMEOUT_SECONDS) || 20) * 1000;

/* ------------------------------------------------------------------ parsing */

/**
 * Accepts either an OpenAI-style `{ object: "list", data: [...] }` envelope or
 * a bare array (FreeLLMAPI has shipped both), and normalises each entry.
 * Entries that aren't objects or have no usable id are dropped.
 */
export function parseCatalog(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : null;

  if (!rows) {
    throw new Error(
      'Unexpected /v1/models response shape: expected an array, or an object with a "data" (or "models") array.',
    );
  }

  return rows
    .filter((row) => row && typeof row === 'object')
    .map((row) => {
      const id = typeof row.id === 'string' ? row.id.trim() : '';
      const ctx = Number(row.context_window ?? row.context_length ?? 0);
      return {
        id,
        name: typeof row.name === 'string' ? row.name : id,
        // Missing owned_by must not collapse every such model into one bucket
        // for diversity purposes, so fall back to the id's namespace prefix.
        provider: String(row.owned_by || row.provider || id.split('/')[0] || 'unknown').toLowerCase(),
        contextWindow: Number.isFinite(ctx) && ctx > 0 ? ctx : 0,
        // `available` may legitimately be absent on a plain OpenAI-shaped
        // catalog; treat "absent" as available, only an explicit false excludes.
        available: row.available !== false,
        supportedParameters: Array.isArray(row.supported_parameters) ? row.supported_parameters : [],
      };
    })
    .filter((m) => m.id.length > 0);
}

/** available === true, no pseudo-models, no duplicate ids. */
export function filterUsable(models) {
  const seen = new Set();
  return models.filter((m) => {
    if (!m.available) return false;
    if (PSEUDO_MODELS.has(m.id.toLowerCase())) return false;
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

/**
 * Orders one provider's models so that successive picks alternate between the
 * largest and smallest remaining context windows — that way if we only take
 * 2-3 models from a provider we get a real spread, not three 8k models.
 */
export function spreadByContext(models) {
  const sorted = [...models].sort(
    (a, b) => b.contextWindow - a.contextWindow || a.id.localeCompare(b.id),
  );
  const out = [];
  let lo = 0;
  let hi = sorted.length - 1;
  let takeHigh = true;
  while (lo <= hi) {
    out.push(takeHigh ? sorted[lo++] : sorted[hi--]);
    takeHigh = !takeHigh;
  }
  return out;
}

/**
 * Round-robins across providers: every provider contributes its first model
 * before any provider contributes a second, and so on. Providers with more
 * models go first within a round so a deep catalog isn't starved at the tail.
 */
export function selectDiversePanel(models, maxAgents = DEFAULT_MAX_AGENTS) {
  const byProvider = new Map();
  for (const m of models) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }

  const queues = [...byProvider.entries()]
    .map(([provider, list]) => ({ provider, list: spreadByContext(list) }))
    .sort((a, b) => b.list.length - a.list.length || a.provider.localeCompare(b.provider));

  const picked = [];
  for (let round = 0; picked.length < maxAgents; round += 1) {
    const before = picked.length;
    for (const q of queues) {
      if (picked.length >= maxAgents) break;
      if (q.list.length > round) picked.push(q.list[round]);
    }
    if (picked.length === before) break; // every queue exhausted
  }
  return picked;
}

/* ------------------------------------------------------------------ fetching */

export async function fetchCatalog({ baseUrl, apiKey, fetchImpl = fetch }) {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GET ${url} returned HTTP ${res.status}. ${body.slice(0, 300)}`);
    }
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`GET ${url} timed out after ${FETCH_TIMEOUT_MS}ms — is the router running?`);
    }
    throw new Error(`Could not reach FreeLLMAPI at ${url}: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------- output */

export function buildAgentsFile(panel, { now = new Date() } = {}) {
  const providers = new Set(panel.map((m) => m.provider));
  return {
    _comment:
      `Generated by scripts/generate-agents.mjs on ${now.toISOString()} from GET /v1/models — ` +
      `${panel.length} model${panel.length === 1 ? '' : 's'} across ${providers.size} ` +
      `provider${providers.size === 1 ? '' : 's'}, selected for provider and context-window diversity. ` +
      'Re-run `npm run generate-agents` after changing keys/providers; hand edits are fine but will be overwritten.',
    models: panel.map((m) => m.id),
  };
}

function summarise(panel) {
  const byProvider = new Map();
  for (const m of panel) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
  const lines = [...byProvider.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([provider, list]) => `  ${provider} (${list.length}): ${list.map((m) => `${m.id}[${m.contextWindow || '?'}]`).join(', ')}`);
  return `${panel.length} models across ${byProvider.size} providers\n${lines.join('\n')}`;
}

/* --------------------------------------------------------------- self-test */

const FIXTURE = [
  { id: 'auto', name: 'Auto', owned_by: 'freellmapi', context_window: 0, available: true },
  { id: 'fusion', name: 'Fusion', owned_by: 'freellmapi', context_window: 0, available: true },
  { id: 'g-small', owned_by: 'google', context_window: 8000, available: true },
  { id: 'g-mid', owned_by: 'google', context_window: 128000, available: true },
  { id: 'g-big', owned_by: 'google', context_window: 1000000, available: true },
  { id: 'g-dead', owned_by: 'google', context_window: 32000, available: false },
  { id: 'm-a', owned_by: 'mistral', context_window: 32000, available: true },
  { id: 'm-b', owned_by: 'mistral', context_window: 64000, available: true },
  { id: 'c-a', owned_by: 'cohere', context_window: 128000, available: true },
  { id: 'groq/llama', name: 'Llama', context_window: 8192, available: true }, // no owned_by
  { id: '', owned_by: 'broken', available: true },
];

function assert(cond, msg) {
  if (!cond) throw new Error(`self-test failed: ${msg}`);
  console.log(`  ok — ${msg}`);
}

export function runSelfTest() {
  console.log('Running fixture self-test…');
  const parsed = parseCatalog(FIXTURE);
  assert(!parsed.some((m) => m.id === ''), 'entries without an id are dropped');
  assert(parsed.find((m) => m.id === 'groq/llama').provider === 'groq', 'provider falls back to id namespace');

  const usable = filterUsable(parsed);
  assert(!usable.some((m) => PSEUDO_MODELS.has(m.id)), 'auto/fusion pseudo-models are excluded');
  assert(!usable.some((m) => m.id === 'g-dead'), 'available:false models are excluded');
  assert(usable.length === 7, `7 usable models remain (got ${usable.length})`);

  assert(parseCatalog({ object: 'list', data: FIXTURE }).length === parsed.length, 'OpenAI {data:[…]} envelope parses the same');

  const three = selectDiversePanel(usable, 3);
  assert(new Set(three.map((m) => m.provider)).size === 3, 'a 3-model panel uses 3 distinct providers');

  const four = selectDiversePanel(usable, 4);
  assert(four.filter((m) => m.provider === 'google').length === 1, 'no provider doubles up before all providers are used');

  const all = selectDiversePanel(usable, 28);
  assert(all.length === usable.length, 'max above catalog size returns the whole catalog');
  assert(new Set(all.map((m) => m.id)).size === all.length, 'no duplicate ids in the panel');
  const google = all.filter((m) => m.provider === 'google').map((m) => m.id);
  assert(google[0] === 'g-big' && google[1] === 'g-small', 'within a provider, picks alternate big/small context windows');

  const file = buildAgentsFile(all, { now: new Date('2026-01-01T00:00:00Z') });
  assert(Array.isArray(file.models) && file.models.every((m) => typeof m === 'string'), 'output models is an array of string ids');
  assert(file._comment.includes('2026-01-01') && file._comment.includes('4 providers'), '_comment records timestamp and provider count');

  console.log('Self-test passed.');
  return true;
}

/* ------------------------------------------------------------------- main */

function parseArgs(argv) {
  const args = { dryRun: false, selfTest: false, max: Number(process.env.MAX_AGENTS) || DEFAULT_MAX_AGENTS };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--self-test') args.selfTest = true;
    else if (arg.startsWith('--max=')) args.max = Number(arg.slice('--max='.length));
    else if (/^\d+$/.test(arg)) args.max = Number(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.max) || args.max < 1) {
    throw new Error(`MAX_AGENTS must be a positive integer (got ${args.max}).`);
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const baseUrl = process.env.FREELLMAPI_BASE_URL;
  const apiKey = process.env.FREELLMAPI_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      'FREELLMAPI_BASE_URL and FREELLMAPI_API_KEY must be set (copy .env.example to .env and fill them in).',
    );
  }

  const payload = await fetchCatalog({ baseUrl, apiKey });
  const usable = filterUsable(parseCatalog(payload));
  if (usable.length === 0) {
    throw new Error('The router returned no available models — refusing to overwrite agents.json with an empty panel.');
  }

  const panel = selectDiversePanel(usable, args.max);
  console.log(summarise(panel));

  const file = buildAgentsFile(panel);
  if (args.dryRun) {
    console.log('\n--dry-run: not writing. Planned agents.json:\n');
    console.log(JSON.stringify(file, null, 2));
    return;
  }

  await writeFile(AGENTS_PATH, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  console.log(`\nWrote ${panel.length} models to ${AGENTS_PATH}`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`\nerror: ${err?.message ?? err}`);
    console.error('agents.json was NOT modified.');
    process.exit(1);
  });
}
