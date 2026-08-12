import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { runCouncil } from './council.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

async function loadAgentModels() {
  const raw = await readFile(path.join(__dirname, 'config', 'agents.json'), 'utf8');
  const parsed = JSON.parse(raw);
  return (parsed.models ?? []).slice(0, 28);
}

app.get('/api/health', async (req, res) => {
  const models = await loadAgentModels();
  const configured = Boolean(process.env.FREELLMAPI_BASE_URL && process.env.FREELLMAPI_API_KEY);
  res.json({ ok: configured && models.length > 0, agentCount: models.length, configured });
});

app.get('/api/config', async (req, res) => {
  const models = await loadAgentModels();
  const configured = Boolean(process.env.FREELLMAPI_BASE_URL && process.env.FREELLMAPI_API_KEY);
  res.json({ agentCount: models.length, configured });
});

app.post('/api/chat', async (req, res) => {
  const { message } = req.body ?? {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const baseUrl = process.env.FREELLMAPI_BASE_URL;
  const apiKey = process.env.FREELLMAPI_API_KEY;
  if (!baseUrl || !apiKey) {
    return res.status(503).json({
      error: 'not_configured',
      message: 'Set FREELLMAPI_BASE_URL and FREELLMAPI_API_KEY in .env — see README setup.',
    });
  }

  const models = await loadAgentModels();
  if (models.length === 0) {
    return res.status(503).json({ error: 'no_agents_configured', message: 'server/config/agents.json has no models listed.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    const result = await runCouncil({
      question: message,
      config: { baseUrl, apiKey, models },
      onEvent: send,
    });
    send({ type: 'result', result });
  } catch (err) {
    send({ type: 'error', message: String(err?.message ?? err) });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`llm-council listening on http://localhost:${PORT}`);
});
