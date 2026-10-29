// Hyde AI UI. Plain ES module, no build step; served by the `hyde-ai` binary.

const TOKEN = document.querySelector('meta[name="hyde-token"]').content;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  providers: [],
  ai: null,
  draftProvider: null,
  lastInputs: [],
  recallIndex: -1,
  busy: false,
};

// ---------------------------------------------------------------- helpers

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Hyde-Token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Small, safe markdown: input is escaped first, then a few inline/block forms are added.
function markdown(source) {
  const blocks = [];
  let text = escapeHtml(source || '').replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (/^\u0000\d+\u0000$/.test(line.trim())) { closeList(); out.push(line.trim()); }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^#{1,6}\s+(.*)/))) { closeList(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if (!line.trim()) { closeList(); }
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

function toast(message, kind = 'ok') {
  const node = el('div', { class: `toast ${kind}` }, icon(kind === 'err' ? 'alert' : 'check'), el('span', {}, message));
  $('#toasts').append(node);
  setTimeout(() => node.remove(), 4200);
}

async function withLoading(button, fn) {
  button.classList.add('loading');
  button.disabled = true;
  try { return await fn(); } finally { button.classList.remove('loading'); button.disabled = false; }
}

// ---------------------------------------------------------------- navigation

function showView(name) {
  for (const item of $$('.nav-item')) {
    const active = item.dataset.view === name;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
  }
  for (const view of $$('.view')) view.classList.toggle('active', view.id === `view-${name}`);
  if (name === 'tools') loadTools();
  if (name === 'code') loadCode();
  if (name === 'assistant') $('#input').focus();
  try { localStorage.setItem('hyde.view', name); } catch { /* storage unavailable */ }
}

for (const item of $$('[data-view]')) item.addEventListener('click', () => showView(item.dataset.view));

// ---------------------------------------------------------------- state

async function loadState() {
  const data = await api('GET', '/api/state');
  state.providers = data.providers;
  state.ai = data.ai;
  $('#version').textContent = `AI v${data.version}`;
  $('#apps-path').textContent = `${data.config_dir}/apps.toml`;
  renderEnginePill();
  renderExamples(data.examples);
  renderApps(data.apps);
  renderEngineForm();
  return data;
}

function renderEnginePill() {
  const ai = state.ai;
  const provider = state.providers.find((p) => p.id === ai.provider);
  const dot = $('#engine-dot');
  dot.className = 'dot' + (ai.ready ? ' on' : ai.enabled ? ' warn' : '');
  $('#engine-label').textContent = ai.ready ? (provider?.name || 'AI engine') : ai.enabled ? 'AI needs setup' : 'Rules only';
  $('#engine-model').textContent = ai.ready ? ai.model : 'Connect a free AI model';
}

function renderExamples(examples) {
  const box = $('#examples');
  box.replaceChildren(...examples.map((text) => el('button', { class: 'chip', type: 'button', onclick: () => submit(text) }, text)));
}

// ---------------------------------------------------------------- assistant feed

const feed = $('#feed');

function scrollFeed() {
  requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
}

function avatarFor(reply) {
  switch (reply.status) {
    case 'done': return ['ok', 'check'];
    case 'answer': return reply.source === 'ai' ? ['ai', 'spark'] : ['ok', 'check'];
    case 'confirm': return ['ask', 'shield'];
    case 'failed': return ['err', 'alert'];
    case 'partial': return ['ask', 'alert'];
    case 'cancelled': return ['idle', 'x'];
    default: return ['idle', 'chat'];
  }
}

function newTurn(input) {
  $('#welcome')?.remove();
  const turn = el('div', { class: 'turn' });
  if (input) turn.append(el('div', { class: 'you' }, el('span', {}, input)));
  const hyde = el('div', { class: 'hyde' },
    el('div', { class: 'avatar idle' }, icon('chat')),
    el('div', { class: 'body' }, el('div', { class: 'typing', 'aria-label': 'Hyde is thinking' }, el('i'), el('i'), el('i'))));
  turn.append(hyde);
  feed.append(turn);
  scrollFeed();
  return hyde;
}

function renderReply(hyde, reply) {
  const [tone, glyph] = avatarFor(reply);
  const avatar = el('div', { class: `avatar ${tone}` }, icon(glyph));
  const body = el('div', { class: 'body' });
  const showText = reply.text && !(reply.status === 'done' && reply.plan && reply.results.length);
  if (showText) body.append(el('div', { class: 'message', html: markdown(reply.text) }));

  if (reply.plan && reply.plan.tasks.length) body.append(renderPlan(reply));

  const meta = el('div', { class: 'meta' });
  if (reply.source === 'ai') meta.append(el('span', { class: 'tag ai' }, icon('spark'), 'AI'));
  else if (reply.plan) meta.append(el('span', { class: 'tag rules' }, 'Rules'));
  if (reply.rewritten) meta.append(el('span', {}, `understood as “${reply.rewritten}”`));
  if (reply.plan && reply.source !== 'ai' && reply.plan.tasks.length) meta.append(el('span', {}, `match ${Math.round(reply.plan.score * 100)}%`));
  if (reply.status === 'unknown' && !state.ai?.ready) {
    meta.append(el('button', { class: 'btn ghost small', type: 'button', onclick: () => showView('engine') }, icon('spark'), 'Connect AI engine'));
  }
  if (meta.childNodes.length) body.append(meta);

  for (const id of reply.job_ids || []) body.append(renderJob(id));
  hyde.replaceChildren(avatar, body);
  scrollFeed();
}

function renderPlan(reply) {
  const plan = el('div', { class: 'plan' });
  for (const task of reply.plan.tasks) {
    const result = reply.results.find((r) => r.task_id === task.id);
    const stateClass = result ? (result.success ? 'ok' : 'err') : '';
    const stateIcon = result ? icon(result.success ? 'check' : 'x') : icon('chevron');
    const after = task.depends_on.length ? 'after previous step' : '';
    const detail = result && !result.success ? el('small', { class: 'err' }, result.message) : after ? el('small', {}, after) : null;
    plan.append(el('div', { class: 'plan-row' },
      el('div', { class: `state ${stateClass}` }, stateIcon),
      el('div', { class: 'label' }, task.label, detail),
      el('span', { class: `risk ${task.risk}`, title: riskTitle(task.risk) }, task.risk)));
  }
  if (reply.status === 'confirm' && reply.pending_id) {
    const risky = reply.plan.tasks.some((t) => t.risk === 'L2' || t.risk === 'L3');
    const run = el('button', { class: 'btn primary small', type: 'button' }, icon('play'), risky ? 'Run' : 'Yes, run it');
    const cancel = el('button', { class: 'btn ghost small', type: 'button' }, 'Cancel');
    const decide = async (approve, button) => {
      run.disabled = cancel.disabled = true;
      button.classList.add('loading');
      try {
        const next = await api('POST', '/api/confirm', { pending_id: reply.pending_id, approve });
        renderReply(plan.closest('.hyde'), next);
      } catch (error) {
        toast(error.message, 'err');
        run.disabled = cancel.disabled = false;
        button.classList.remove('loading');
      }
    };
    run.addEventListener('click', () => decide(true, run));
    cancel.addEventListener('click', () => decide(false, cancel));
    plan.append(el('div', { class: 'plan-actions' },
      el('span', { class: 'note' }, icon('shield'), risky ? 'Changes your system' : 'Please confirm'),
      cancel, run));
    setTimeout(() => run.focus(), 50);
  }
  return plan;
}

function riskTitle(risk) {
  return {
    L0: 'Safe: runs instantly',
    L1: 'Low impact: easy to undo',
    L2: 'Changes your system: needs confirmation',
    L3: 'High impact: needs confirmation',
  }[risk] || risk;
}

function renderJob(id, onDone) {
  const head = el('div', { class: 'job-head' }, el('span', { class: 'spinner' }), el('span', {}, 'Starting…'));
  const log = el('pre', { class: 'log' });
  const box = el('div', {}, head, log);
  let shown = 0;
  const poll = async () => {
    let job;
    try { job = await api('GET', `/api/jobs/${id}`); } catch (error) { head.lastChild.textContent = error.message; return; }
    if (job.log.length > shown) {
      const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
      log.textContent += job.log.slice(shown).join('\n') + '\n';
      shown = job.log.length;
      if (stick) log.scrollTop = log.scrollHeight;
    }
    if (job.state === 'running') {
      head.lastChild.textContent = `${job.title}…`;
      setTimeout(poll, 600);
    } else {
      const ok = job.state === 'succeeded';
      head.replaceChildren(el('span', { class: `status ${ok ? 'ok' : ''}` }, icon(ok ? 'check' : 'alert'), ok ? `${job.title} finished` : `${job.title} failed`));
      toast(ok ? `${job.title} finished` : `${job.title} failed`, ok ? 'ok' : 'err');
      onDone?.(ok);
      if ($('#view-tools').classList.contains('active')) loadTools();
    }
  };
  poll();
  return box;
}

async function submit(text) {
  text = (text ?? $('#input').value).trim();
  if (!text || state.busy) return;
  state.busy = true;
  $('#send').disabled = true;
  $('#input').value = '';
  state.lastInputs.push(text);
  state.recallIndex = -1;
  showView('assistant');
  const hyde = newTurn(text);
  try {
    renderReply(hyde, await api('POST', '/api/command', { text }));
  } catch (error) {
    renderReply(hyde, { status: 'failed', text: error.message, results: [], job_ids: [] });
  } finally {
    state.busy = false;
    $('#send').disabled = false;
    $('#input').focus();
  }
}

$('#composer').addEventListener('submit', (event) => { event.preventDefault(); submit(); });

$('#input').addEventListener('keydown', (event) => {
  const input = event.currentTarget;
  if (event.key === 'ArrowUp' && state.lastInputs.length && (!input.value || state.recallIndex >= 0)) {
    event.preventDefault();
    state.recallIndex = state.recallIndex < 0 ? state.lastInputs.length - 1 : Math.max(0, state.recallIndex - 1);
    input.value = state.lastInputs[state.recallIndex];
  } else if (event.key === 'ArrowDown' && state.recallIndex >= 0) {
    event.preventDefault();
    state.recallIndex += 1;
    if (state.recallIndex >= state.lastInputs.length) { state.recallIndex = -1; input.value = ''; }
    else input.value = state.lastInputs[state.recallIndex];
  } else if (event.key === 'Escape') {
    input.value = '';
    state.recallIndex = -1;
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    showView('assistant');
    $('#input').select();
  }
});

$('#clear-history').addEventListener('click', async () => {
  await api('POST', '/api/history/clear');
  feed.replaceChildren(el('div', { class: 'welcome', id: 'welcome' },
    el('img', { src: '/icon.svg', alt: '', width: 48, height: 48 }),
    el('h2', {}, 'What should I do?'),
    el('p', {}, 'Ask in plain words. Hyde runs known commands instantly and asks before anything that changes your system.'),
    el('div', { class: 'chips', id: 'examples' })));
  loadState();
});

function replayHistory(history) {
  for (const reply of history) {
    if (!reply.input) continue;
    state.lastInputs.push(reply.input);
    const hyde = newTurn(reply.input);
    renderReply(hyde, { ...reply, job_ids: [] });
  }
}

// ---------------------------------------------------------------- voice input

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition) {
  const mic = $('#mic');
  mic.hidden = false;
  let recognizer = null;
  mic.addEventListener('click', () => {
    if (recognizer) { recognizer.stop(); return; }
    recognizer = new Recognition();
    recognizer.lang = navigator.language || 'en-US';
    recognizer.interimResults = true;
    recognizer.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      $('#input').value = result[0].transcript;
      if (result.isFinal) submit(result[0].transcript);
    };
    recognizer.onerror = (event) => { if (event.error !== 'aborted' && event.error !== 'no-speech') toast(`Voice input: ${event.error}`, 'err'); };
    recognizer.onend = () => { recognizer = null; mic.classList.remove('listening'); };
    mic.classList.add('listening');
    recognizer.start();
  });
}

// ---------------------------------------------------------------- tools

const TOOL_ICONS = { opencode: 'terminal', omniroute: 'route' };

async function loadTools() {
  const box = $('#tools');
  try {
    const { tools } = await api('GET', '/api/tools');
    box.replaceChildren(...tools.map(renderTool));
  } catch (error) {
    box.replaceChildren(el('p', { class: 'muted' }, error.message));
  }
}

function renderTool(tool) {
  const status = tool.installed
    ? el('span', { class: `status ${tool.running ? 'run' : 'ok'}` }, el('span', { class: `dot ${tool.running ? 'on' : ''}` }),
        tool.running ? 'Running' : `Installed${tool.version ? ` · ${tool.version}` : ''}`)
    : el('span', { class: 'status' }, el('span', { class: 'dot' }), 'Not installed');

  const actions = el('div', { class: 'tool-actions' });
  const logSlot = el('div');
  const card = el('div', { class: 'card tool' },
    el('div', { class: 'tool-head' },
      el('div', { class: 'tool-icon' }, icon(TOOL_ICONS[tool.id] || 'tools')),
      el('div', {},
        el('div', { class: 'tool-title' }, el('h3', {}, tool.name), status),
        el('p', {}, tool.tagline))),
    el('div', { class: 'cmd' }, tool.install_command));

  if (tool.missing_requirements.length && !tool.installed) {
    card.append(el('div', { class: 'warnline' }, `Needs ${tool.missing_requirements.join(', ')} first.`));
  }

  const install = el('button', { class: `btn ${tool.installed ? 'ghost' : 'primary'} small`, type: 'button' },
    icon('download'), tool.installed ? 'Reinstall / update' : 'Install');
  install.addEventListener('click', async () => {
    install.disabled = true;
    try {
      const { job_id } = await api('POST', '/api/tools/install', { tool: tool.id });
      logSlot.replaceChildren(renderJob(job_id, () => { install.disabled = false; }));
    } catch (error) {
      toast(error.message, 'err');
      install.disabled = false;
    }
  });
  if (tool.missing_requirements.length) install.disabled = true;
  actions.append(install);

  if (tool.installed) {
    const launchLabel = tool.id === 'opencode' ? 'Open in terminal' : tool.running ? 'Open dashboard' : 'Start';
    const launch = el('button', { class: 'btn small', type: 'button' }, icon(tool.id === 'omniroute' && tool.running ? 'external' : 'play'), launchLabel);
    launch.addEventListener('click', () => withLoading(launch, async () => {
      try {
        const { message } = await api('POST', '/api/tools/launch', { tool: tool.id });
        toast(message);
        if (tool.id === 'omniroute') setTimeout(loadTools, 4000);
      } catch (error) { toast(error.message, 'err'); }
    }));
    actions.append(launch);
  }

  if (tool.id === 'omniroute' && tool.installed) {
    const use = el('button', { class: 'btn ghost small', type: 'button' }, icon('spark'), 'Use as AI engine');
    use.addEventListener('click', () => {
      selectProvider('omniroute', true);
      showView('engine');
      toast('OmniRoute selected. Add providers in its dashboard, then load models.');
    });
    actions.append(use);
  }
  actions.append(el('a', { class: 'btn ghost small', href: tool.homepage, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), 'Website'));
  card.append(actions, logSlot);
  return card;
}

$('#refresh-tools').addEventListener('click', loadTools);

// ---------------------------------------------------------------- apps

function renderApps(apps) {
  const sorted = [...apps].sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
  $('#apps').replaceChildren(...sorted.map((app) => {
    const say = app.aliases[0] || app.name.toLowerCase();
    const open = el('button', { class: 'btn small', type: 'button', onclick: () => submit(`open ${say}`) }, icon('play'), 'Open');
    if (!app.installed) open.disabled = true;
    return el('div', { class: `card app ${app.installed ? '' : 'missing'}` },
      el('div', { class: 'app-top' },
        el('span', { class: 'app-name' }, app.name),
        el('span', { class: `status ${app.installed ? 'ok' : ''}` }, app.installed ? 'Installed' : 'Not found')),
      el('div', { class: 'app-say' }, 'Say ', el('b', {}, `“open ${say}”`)),
      open);
  }));
}

$('#reload-pack').addEventListener('click', (event) => withLoading(event.currentTarget, async () => {
  try {
    const { intents } = await api('POST', '/api/reload');
    await loadState();
    toast(`Reloaded ${intents} commands`);
  } catch (error) { toast(error.message, 'err'); }
}));

// ---------------------------------------------------------------- AI engine settings

function providerById(id) {
  return state.providers.find((p) => p.id === id) || state.providers[state.providers.length - 1];
}

function renderEngineForm() {
  const ai = state.ai;
  $('#ai-enabled').checked = ai.enabled;
  $('#providers').replaceChildren(...state.providers.map((p) => {
    const badges = el('span', { class: 'badges' });
    if (p.local) badges.append(el('span', { class: 'badge local' }, 'Local'));
    if (p.id !== 'custom') badges.append(el('span', { class: 'badge free' }, p.needs_key ? 'Free key' : 'Free'));
    return el('button', {
      class: 'provider', type: 'button', role: 'radio', 'data-id': p.id, 'aria-checked': 'false',
      onclick: () => selectProvider(p.id, true),
    }, el('strong', {}, p.name), badges);
  }));
  selectProvider(ai.provider, false);
  $('#ai-base').value = ai.base_url;
  $('#ai-model').value = ai.model;
}

function selectProvider(id, applyDefaults) {
  const p = providerById(id);
  const changed = state.draftProvider !== p.id;
  state.draftProvider = p.id;
  for (const node of $$('.provider')) node.setAttribute('aria-checked', String(node.dataset.id === p.id));
  $('#provider-note').textContent = p.note;
  const link = $('#key-link');
  link.hidden = !p.key_url;
  link.href = p.key_url || '#';
  link.firstChild.textContent = p.id === 'omniroute' ? 'Open dashboard ' : p.id === 'ollama' ? 'Download Ollama ' : 'Get a free key ';
  if (applyDefaults && changed) {
    $('#ai-base').value = p.base_url;
    $('#ai-model').value = p.default_model;
    $('#ai-key').value = '';
    $('#model-list').replaceChildren();
    $('#models-status').textContent = '';
    if (!$('#ai-enabled').checked) $('#ai-enabled').checked = true;
  }
  const saved = state.ai && state.ai.provider === p.id && state.ai.has_key;
  $('#key-hint').textContent = saved ? `A key is saved (${state.ai.key_hint}). Leave blank to keep it.` : p.needs_key ? 'Required for this provider. Stored only in your local config file.' : 'Optional for this provider.';
  $('#free-only').parentElement.hidden = p.id !== 'openrouter';
  $('#test-result').textContent = '';
  $('#test-result').className = 'test-result';
}

function draft() {
  const body = {
    enabled: $('#ai-enabled').checked,
    provider: state.draftProvider,
    base_url: $('#ai-base').value.trim(),
    model: $('#ai-model').value.trim(),
  };
  const key = $('#ai-key').value.trim();
  if (key) body.api_key = key;
  return body;
}

$('#toggle-key').addEventListener('click', () => {
  const input = $('#ai-key');
  input.type = input.type === 'password' ? 'text' : 'password';
});

$('#load-models').addEventListener('click', (event) => withLoading(event.currentTarget, async () => {
  const status = $('#models-status');
  status.textContent = 'Loading models…';
  try {
    const res = await api('POST', '/api/ai/models', draft());
    if (!res.ok) { status.textContent = res.error; return; }
    let models = res.models;
    if (state.draftProvider === 'openrouter' && $('#free-only').checked) models = models.filter((m) => m.endsWith(':free'));
    $('#model-list').replaceChildren(...models.map((m) => el('option', { value: m })));
    status.textContent = models.length ? `${models.length} models available. Click the model field to pick one.` : 'No models found. Check the endpoint and key.';
    if (models.length && !$('#ai-model').value) $('#ai-model').value = models[0];
  } catch (error) { status.textContent = error.message; }
}));

$('#test-ai').addEventListener('click', (event) => withLoading(event.currentTarget, async () => {
  const out = $('#test-result');
  out.className = 'test-result';
  out.replaceChildren(el('span', { class: 'spinner' }), 'Testing…');
  try {
    const res = await api('POST', '/api/ai/test', draft());
    out.className = `test-result ${res.ok ? 'ok' : 'err'}`;
    out.replaceChildren(icon(res.ok ? 'check' : 'alert'), el('span', {}, res.ok ? `Connected in ${res.millis} ms` : res.message));
    out.title = res.message;
  } catch (error) {
    out.className = 'test-result err';
    out.replaceChildren(icon('alert'), el('span', {}, error.message));
  }
}));

$('#engine-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withLoading($('#save-ai'), async () => {
    try {
      const res = await api('POST', '/api/ai/config', draft());
      state.ai = res.ai;
      $('#ai-key').value = '';
      selectProvider(state.ai.provider, false);
      renderEnginePill();
      toast(res.ai.ready ? 'AI engine saved and active' : res.ai.enabled ? 'Saved. Pick a model to activate the AI engine.' : 'Saved. AI engine is off.');
    } catch (error) { toast(error.message, 'err'); }
  });
});


// ---------------------------------------------------------------- Hyde Code

const code = { data: null, timer: null, selectedProject: null };
const STATUS_LABEL = {
  backlog: 'Backlog', clarifying: 'Planning', ready: 'Queued', running: 'Working', verifying: 'Checking',
  reviewing: 'In review', blocked: 'Needs you', awaiting_merge: 'Ready to merge', done: 'Done', cancelled: 'Cancelled', failed: 'Failed',
};

async function codeCommand(text, button) {
  const run = async () => {
    try {
      const res = await api('POST', '/api/code/command', { text });
      toast(res.message.split('\n')[0].slice(0, 160));
      await loadCode();
    } catch (error) { toast(error.message, 'err'); }
  };
  return button ? withLoading(button, run) : run();
}

async function loadCode() {
  clearTimeout(code.timer);
  let data;
  try { data = await api('GET', '/api/code'); } catch (error) { toast(error.message, 'err'); return; }
  code.data = data;
  renderCode(data);
  if ($('#view-code').classList.contains('active')) code.timer = setTimeout(loadCode, 4000);
}

function renderCode(data) {
  const status = $('#hub-status');
  status.className = `status ${data.running ? 'ok' : ''}`;
  status.replaceChildren(el('span', { class: `dot ${data.running ? 'on' : ''}` }), data.running ? 'Hub running' : 'Hub stopped');
  $('#hub-start').hidden = data.running || !data.has_cli;
  $('#notify-wrap').hidden = !data.can_notify || !data.running || !data.api_version;
  $('#notify-toggle').checked = Boolean(data.notify);
  $('#hub-open').disabled = !data.has_token;

  const waiting = (data.questions?.length || 0) + (data.approvals?.length || 0) + (data.merges?.length || 0);
  const badge = $('#code-badge');
  badge.hidden = !waiting;
  badge.textContent = waiting;

  if (!data.running) {
    const offline = el('div', { class: 'card offline' },
      el('h3', {}, data.installed ? 'The Hyde Code hub is stopped' : 'Hyde Code isn\'t set up on this computer'),
      el('p', {}, data.installed
        ? 'Start it to give tasks to Claude Code, Codex and OpenCode. Tasks resume where they left off.'
        : 'Install Hyde Code, then run `hyde` once inside a project folder.'),
      data.installed ? null : el('pre', { class: 'log' }, 'cd "HYDE CODE" && pnpm install && pnpm build && pnpm install-cli\ncd ~/your-project && hyde'));
    if (data.has_cli) {
      const start = el('button', { class: 'btn primary small', type: 'button' }, icon('play'), 'Start hub');
      start.addEventListener('click', () => startHub(start));
      offline.append(start);
    }
    $('#needs').replaceChildren(offline);
    $('#needs-title').hidden = true;
    $('#tasks').replaceChildren(el('div', { class: 'empty' }, 'Tasks appear here when the hub is running.'));
    $('#agents').replaceChildren(el('div', { class: 'empty' }, 'No hub connection.'));
    $('#assign-send').disabled = !data.has_cli;
    fillProjects([]);
    return;
  }
  $('#needs-title').hidden = false;
  $('#assign-send').disabled = false;
  if (data.error) toast(data.error, 'err');
  fillProjects(data.projects || []);
  fillAgents(data.agents || []);
  renderNeeds(data);
  renderTasks(data.tasks || []);
}

function fillProjects(projects) {
  const select = $('#assign-project');
  const current = code.selectedProject ?? select.value ?? '';
  const def = code.data?.default_project || '';
  const options = projects.map((p) => el('option', { value: p.id }, `${p.name}${p.id === def ? '  ★' : ''}`));
  if (!projects.length) options.push(el('option', { value: '' }, 'No projects yet'));
  select.replaceChildren(...options);
  const pick = projects.some((p) => p.id === current) ? current : projects.some((p) => p.id === def) ? def : projects[0]?.id || '';
  select.value = pick;
  updateStar();
}

function updateStar() {
  const on = Boolean(code.data?.default_project) && $('#assign-project').value === code.data.default_project;
  const star = $('#set-default');
  star.classList.toggle('on', on);
  star.title = on ? 'Default project for voice and chat' : 'Make this the default project for voice and chat';
}

function fillAgents(agents) {
  const select = $('#assign-agent');
  const current = select.value;
  select.replaceChildren(el('option', { value: '' }, 'Best available'), ...agents.map((a) => el('option', { value: a.name }, `${a.name} · ${a.adapter}`)));
  select.value = agents.some((a) => a.name === current) ? current : '';
  $('#agents').replaceChildren(...(agents.length ? agents.map((a) => {
    const health = a.health || {};
    const ok = health.ok !== false && health.signedIn !== false;
    return el('div', { class: 'card agent-card' },
      el('div', { class: 'row' }, el('b', {}, a.name), el('span', { class: `status ${ok ? 'ok' : ''}` }, el('span', { class: `dot ${ok ? 'on' : 'warn'}` }), ok ? 'Ready' : 'Check sign-in')),
      el('small', {}, [a.adapter, a.model].filter(Boolean).join(' · ')),
      a.roles?.length ? el('small', {}, a.roles.join(', ')) : null,
      ...quotaBar(a));
  }) : [el('div', { class: 'empty' }, 'No agents configured. Run `hyde setup`.')]));
}

function quotaBar(a) {
  if (typeof a.percent !== 'number') return [];
  const level = a.blocked ? 'full' : a.nearCeiling ? 'high' : '';
  const reset = a.resetsAt ? ` · resets ${new Date(a.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  const label = a.blocked ? `Paused: ${a.blocked}` : `${a.percent}% of quota used${a.nearCeiling ? ', new runs wait' : ''}${reset}`;
  return [
    el('div', { class: 'quota', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': a.percent, 'aria-label': `${a.name} quota` },
      el('i', { class: level, style: `width:${Math.min(100, Math.max(2, a.percent))}%` })),
    el('small', {}, label),
  ];
}

function renderNeeds(data) {
  const items = [];
  for (const q of data.questions || []) {
    const input = el('input', { type: 'text', placeholder: 'Your answer', 'aria-label': `Answer ${q.id}` });
    const send = el('button', { class: 'btn primary small', type: 'button' }, 'Answer');
    const submitAnswer = (text) => text.trim() && codeCommand(`/answer ${q.id} ${text.trim()}`, send);
    send.addEventListener('click', () => submitAnswer(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAnswer(input.value); });
    const quick = (q.options || []).slice(0, 4).map((o) => el('button', { class: 'chip', type: 'button', onclick: () => submitAnswer(o) }, o));
    items.push(el('div', { class: 'card need' },
      el('div', { class: 'need-top' }, el('span', { class: 'id' }, q.id), 'question on', el('span', { class: 'id' }, q.taskId), q.taskTitle ? `· ${q.taskTitle}` : null, q.blocking ? el('span', { class: 'pill blocked' }, 'blocking') : null),
      el('div', { class: 'need-text', html: markdown(q.text) }),
      quick.length ? el('div', { class: 'need-actions' }, ...quick) : null,
      el('div', { class: 'need-actions' }, input, send)));
  }
  for (const a of data.approvals || []) {
    const approve = el('button', { class: 'btn primary small', type: 'button' }, icon('check'), 'Approve');
    const deny = el('button', { class: 'btn ghost small', type: 'button' }, 'Deny');
    approve.addEventListener('click', () => codeCommand(`/approve ${a.id}`, approve));
    deny.addEventListener('click', () => codeCommand(`/deny ${a.id}`, deny));
    items.push(el('div', { class: 'card need' },
      el('div', { class: 'need-top' }, el('span', { class: 'id' }, a.id), `${(a.kind || 'approval').replace(/[-_]/g, ' ')} for`, el('span', { class: 'id' }, a.taskId)),
      el('div', { class: 'need-text' }, a.summary),
      el('div', { class: 'need-actions' }, deny, approve)));
  }
  for (const m of data.merges || []) {
    const merge = el('button', { class: 'btn primary small', type: 'button' }, 'Merge');
    merge.addEventListener('click', () => codeCommand(`/merge ${m.taskId}`, merge));
    items.push(el('div', { class: 'card need' },
      el('div', { class: 'need-top' }, el('span', { class: 'id' }, m.taskId), 'ready to merge', m.projectId ? `· #${m.projectId}` : null),
      el('div', { class: 'need-text' }, m.taskTitle || ''),
      el('div', { class: 'need-actions' },
        m.prUrl ? el('a', { class: 'btn ghost small', href: m.prUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('pr'), 'Review PR') : null,
        merge)));
  }
  $('#needs').replaceChildren(...(items.length ? items : [el('div', { class: 'empty' }, 'Nothing is waiting for you.')]));
}

function renderTasks(tasks) {
  if (!tasks.length) {
    $('#tasks').replaceChildren(el('div', { class: 'empty' }, 'No tasks yet. Assign one above.'));
    return;
  }
  $('#tasks').replaceChildren(...tasks.map((t) => {
    const end = el('div', { class: 'task-end' }, el('span', { class: `pill ${t.status}` }, STATUS_LABEL[t.status] || t.status));
    if (t.prUrl) end.append(el('a', { class: 'icon-btn', href: t.prUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Open pull request', 'aria-label': `Pull request for ${t.id}` }, icon('pr')));
    if (t.status === 'awaiting_merge') {
      const merge = el('button', { class: 'btn small', type: 'button' }, 'Merge');
      merge.addEventListener('click', () => codeCommand(`/merge ${t.id}`, merge));
      end.append(merge);
    }
    if (['running', 'verifying', 'reviewing', 'ready', 'clarifying'].includes(t.status)) {
      const stop = el('button', { class: 'icon-btn', type: 'button', title: `Stop ${t.id}`, 'aria-label': `Stop ${t.id}` }, icon('x'));
      stop.addEventListener('click', () => codeCommand(`/stop ${t.id}`, stop));
      end.append(stop);
    }
    if (t.status === 'failed' || t.status === 'cancelled') {
      const retry = el('button', { class: 'icon-btn', type: 'button', title: `Retry ${t.id}`, 'aria-label': `Retry ${t.id}` }, icon('refresh'));
      retry.addEventListener('click', () => codeCommand(`/retry ${t.id}`, retry));
      end.append(retry);
    }
    const meta = [`#${t.projectId}`, t.agent || t.pinnedAgent, t.parentId ? `part of ${t.parentId}` : null].filter(Boolean).join(' · ');
    return el('div', { class: 'task-row' },
      el('span', { class: 'id' }, t.id),
      el('div', { class: 'task-title' }, el('div', { title: t.title }, t.title), el('small', {}, meta)),
      end);
  }));
}

async function startHub(button) {
  return withLoading(button, async () => {
    try { toast((await api('POST', '/api/code/start')).message); } catch (error) { toast(error.message, 'err'); }
    await loadCode();
  });
}

$('#hub-start').addEventListener('click', (e) => startHub(e.currentTarget));
$('#notify-toggle').addEventListener('change', async (e) => {
  try {
    await api('POST', '/api/code/notify', { enabled: e.currentTarget.checked });
    toast(e.currentTarget.checked ? 'Desktop notifications on' : 'Desktop notifications off');
  } catch (error) { toast(error.message, 'err'); }
});
$('#hub-open').addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
  try { toast((await api('POST', '/api/code/open', { project: $('#assign-project').value || null })).message); }
  catch (error) { toast(error.message, 'err'); }
}));
$('#assign-project').addEventListener('change', () => { code.selectedProject = $('#assign-project').value; updateStar(); });
$('#set-default').addEventListener('click', async () => {
  const project = $('#assign-project').value;
  if (!project) return;
  const next = code.data?.default_project === project ? '' : project;
  try {
    await api('POST', '/api/code/default', { project: next });
    if (code.data) code.data.default_project = next;
    fillProjects(code.data?.projects || []);
    toast(next ? `#${next} is now the default project` : 'Default project cleared');
  } catch (error) { toast(error.message, 'err'); }
});
$('#assign-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('#assign-text').value.trim();
  if (!text) { $('#assign-text').focus(); return; }
  withLoading($('#assign-send'), async () => {
    try {
      const res = await api('POST', '/api/code/task', { text, project: $('#assign-project').value || null, agent: $('#assign-agent').value || null });
      $('#assign-text').value = '';
      toast(res.message.split('\n')[0].slice(0, 160));
      await loadCode();
    } catch (error) { toast(error.message, 'err'); }
  });
});
$('#assign-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#assign-form').requestSubmit();
});

// ---------------------------------------------------------------- start

(async () => {
  try {
    const data = await loadState();
    replayHistory(data.history);
    api('GET', '/api/code').then((d) => { code.data = d; const n = (d.questions?.length || 0) + (d.approvals?.length || 0) + (d.merges?.length || 0); $('#code-badge').hidden = !n; $('#code-badge').textContent = n; }).catch(() => {});
  } catch (error) {
    toast(error.message, 'err');
  }
  let initial = location.hash.slice(1);
  if (!initial) {
    try { initial = localStorage.getItem('hyde.view') || 'assistant'; } catch { initial = 'assistant'; }
  }
  showView($(`#view-${initial}`) ? initial : 'assistant');
})();
