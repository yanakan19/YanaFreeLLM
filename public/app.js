const thread = document.getElementById('thread');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const sendButton = composer.querySelector('button[type="submit"]');

// A council run is one fan-out to every agent, so let only one be in flight
// at a time — otherwise an impatient double-click burns free-tier quota and
// trips the server's rate limit.
let busy = false;

function setBusy(next) {
  busy = next;
  input.disabled = next;
  sendButton.disabled = next;
  if (!next) input.focus();
}

function addMessage(text, who) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.textContent = text;
  thread.appendChild(el);
  thread.scrollTop = thread.scrollHeight;
  return el;
}

function addSplash(text) {
  const el = document.createElement('div');
  el.className = 'splash';
  el.innerHTML = `<span class="spinner"></span><span class="txt"></span>`;
  el.querySelector('.txt').textContent = text;
  thread.appendChild(el);
  thread.scrollTop = thread.scrollHeight;
  return el;
}

function addAgentLog() {
  const el = document.createElement('div');
  el.className = 'agent-log';
  thread.appendChild(el);
  thread.scrollTop = thread.scrollHeight;
  return el;
}

function addRanking(result) {
  const details = document.createElement('details');
  details.className = 'ranking';
  const summary = document.createElement('summary');
  summary.textContent = `Scoring matrix — ${result.respondedCount}/${result.agentCount} agents responded, ranked anonymously`;
  details.appendChild(summary);

  const table = document.createElement('table');
  const critKeys = result.criteria.map((c) => c.key);
  table.innerHTML = `
    <thead>
      <tr>
        <th>Rank</th><th>Agent</th>
        ${critKeys.map((k) => `<th title="${escapeAttr(result.criteria.find((c) => c.key === k).describe)}">${k}</th>`).join('')}
        <th>Total</th>
      </tr>
    </thead>
    <tbody>
      ${result.matrix.map((m) => `
        <tr class="${m.rank === 1 ? 'winner' : ''}">
          <td>#${m.rank}</td>
          <td>Agent ${m.agentNumber}</td>
          ${critKeys.map((k) => `<td>${m.criteriaScores[k]}</td>`).join('')}
          <td><strong>${m.totalScore}</strong></td>
        </tr>
      `).join('')}
    </tbody>
  `;
  details.appendChild(table);
  thread.appendChild(details);
  thread.scrollTop = thread.scrollHeight;
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  addMessage(message, 'user');
  setBusy(true);
  try {
    await runChat(message);
  } catch (err) {
    addMessage(`Couldn't reach the council: ${err?.message ?? err}`, 'bot');
  } finally {
    setBusy(false);
  }
});

async function runChat(message) {
  const splash = addSplash('Thinking…');
  let agentLog = null;

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    const retryAfter = res.headers.get('Retry-After');
    const detail =
      res.status === 429 && retryAfter
        ? `Too many questions at once — try again in ${retryAfter}s.`
        : body.message;
    splash.querySelector('.txt').textContent = detail || `Something went wrong (HTTP ${res.status}).`;
    splash.querySelector('.spinner').style.display = 'none';
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split('\n\n');
    buffer = events.pop();

    for (const raw of events) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = JSON.parse(line.slice(5).trim());
      handleEvent(payload);
    }
  }

  function handleEvent(evt) {
    if (evt.type === 'status') {
      splash.querySelector('.txt').textContent = evt.message;
    } else if (evt.type === 'agent') {
      if (!agentLog) agentLog = addAgentLog();
      const chip = document.createElement('span');
      chip.className = `agent-chip ${evt.ok ? 'ok' : 'fail'}`;
      chip.textContent = `Agent ${evt.agentNumber} ${evt.ok ? '✓' : '✗'}`;
      agentLog.appendChild(chip);
      thread.scrollTop = thread.scrollHeight;
    } else if (evt.type === 'result') {
      splash.remove();
      if (!evt.result.ok) {
        addMessage(`Council failed: ${evt.result.error}`, 'bot');
        return;
      }
      addMessage(evt.result.winner.content, 'bot');
      addRanking(evt.result);
    } else if (evt.type === 'error') {
      splash.querySelector('.txt').textContent = `Error: ${evt.message}`;
      splash.querySelector('.spinner').style.display = 'none';
    }
  }
}

// Boot check
fetch('/api/config').then((r) => r.json()).then((cfg) => {
  if (!cfg.configured) {
    addMessage(
      'Heads up: FreeLLMAPI is not configured yet (FREELLMAPI_BASE_URL / FREELLMAPI_API_KEY). See the README setup steps.',
      'bot',
    );
  } else {
    addMessage(`Council of ${cfg.agentCount} agents is ready. Ask anything.`, 'bot');
  }
  if (cfg.maxMessageChars) input.maxLength = cfg.maxMessageChars;
}).catch(() => {});
