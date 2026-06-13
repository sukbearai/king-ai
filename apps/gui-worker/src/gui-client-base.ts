export const guiClientBaseScript = `const base = location.origin;
let pairCommand = '';
let pairCommandPrimary = '';
let pairCommandStart = '';
let computerStep = 'intro';
let lastConnection = { paired: false, online: false };
let promptedForComputer = false;
let visibleMessageCount = 20;
let lastMessageTotal = 0;
let loadingOlderMessages = false;
let sendingMessage = false;
let shouldStickToBottom = true;
// Optimistic outgoing messages: rendered instantly on send, before any network round trip,
// then dropped once the server's canonical copies arrive on the next refresh.
let optimisticMessages = [];
let activeConversationId = localStorage.getItem('king-ai:activeConversationId') || 'king-ai-convo';
let refreshPollCount = 0;
let conversationSwitchToken = 0;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, function(ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
  });
}
function formatTime(value) {
  if (!value) return '未收到';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function lifecycleLabel(value) {
  return ({ 'on-demand': '按需启动', '24/7': '持续在线', idle_cached: '空闲保活', disabled: '停用' })[value] || value || '按需启动';
}
function taskStatusLabel(value) {
  return ({ pending: '待分配', assigned: '已分配', in_progress: '进行中', review: '待评审', done: '已完成', failed: '失败', blocked: '被阻塞' })[value] || value || '未知';
}
function reasonLabel(reason) {
  return String(reason || '')
    .replace(/(\\\\\\\\d+) unread message\\\\\\\\(s\\\\\\\\) pending/g, '$1 条消息等待本地 AI 处理')
    .replace(/(\\\\\\\\d+) failed run\\\\\\\\(s\\\\\\\\)/g, '$1 次运行失败')
    .replace('no state changes detected', '等待下一条消息。');
}
async function request(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(await res.text());
  return res.headers.get('Content-Type') && res.headers.get('Content-Type').includes('application/json') ? res.json() : res.text();
}
function openSettings() {
  document.getElementById('settingsDialog').showModal();
}
function closeSettings() {
  document.getElementById('settingsDialog').close();
}
function closeComputerDialog() {
  document.getElementById('computerDialog').close();
}
async function openComputerFlow(step) {
  computerStep = step || 'intro';
  const settings = document.getElementById('settingsDialog');
  if (settings.open) settings.close();
  renderComputerFlow();
  const dialog = document.getElementById('computerDialog');
  if (!dialog.open) dialog.showModal();
  if (!pairCommand) await loadPairCommand();
}
async function loadPairCommand() {
  const summary = await request('/gui/summary?conversationId=' + encodeURIComponent(activeConversationId));
  if (!summary.pairingCode) return;
  pairCommandPrimary = 'king-ai agent computer --pair ' + summary.pairingCode + ' --server ' + base + (summary.pairCommandTenantArg || '');
  pairCommandStart = 'king-ai agent computer --server ' + base + (summary.pairCommandTenantArg || '');
  pairCommand = pairCommandPrimary + '\\n' + pairCommandStart;
  lastConnection = summary.connection || lastConnection;
  if (document.getElementById('computerDialog').open && computerStep === 'connect') renderComputerFlow();
}
function dismissComputerIntro() {
  const checkbox = document.getElementById('dontRemindComputer');
  if (checkbox && checkbox.checked) localStorage.setItem('king-ai:addComputerDismissed', '1');
  closeComputerDialog();
}
function renderComputerFlow() {
  const connected = Boolean(lastConnection.online);
  const paired = Boolean(lastConnection.paired);
  const connectionText = connected ? 'Computer connected.' : paired ? 'Computer paired. Waiting for it to come online...' : 'Waiting for computer to connect...';
  const flow = document.getElementById('computerFlow');
  if (computerStep === 'select') {
    flow.innerHTML =
      '<div class="computer-actions"><button class="icon button-shadow" onclick="closeComputerDialog()" aria-label="Close">×</button></div>' +
      '<h2 class="computer-title">Add Computer</h2>' +
      '<div class="choice-grid">' +
      '<button class="computer-choice active" onclick="openComputerFlow(&quot;connect&quot;)"><span class="computer-icon">▭</span><span><strong class="computer-choice-title">Your Computer</strong><span class="computer-muted">Run agents on your own computer</span></span></button>' +
      '<button class="computer-choice disabled" type="button"><span class="computer-icon">☁</span><span><strong class="computer-choice-title">Cloud Computer</strong><span class="computer-muted">Coming soon</span></span></button>' +
      '</div>' +
      '<div class="computer-actions"><button class="button-shadow" onclick="closeComputerDialog()">Cancel</button><button class="primary-pink button-shadow" onclick="openComputerFlow(&quot;connect&quot;)">Next</button></div>';
    return;
  }
  if (computerStep === 'connect') {
    flow.innerHTML =
      '<div class="computer-actions"><button class="icon button-shadow" onclick="closeComputerDialog()" aria-label="Close">×</button></div>' +
      '<h2 class="computer-title">Connect Computer</h2>' +
      '<p><strong>&gt;_ Run this command on your computer to connect:</strong></p>' +
      '<div class="connect-row"><div class="connect-stack">' +
      '<div class="connect-help">First-time pairing: run this once to attach this browser session.</div>' +
      '<pre class="connect-command">' + escapeHtml(pairCommandPrimary || 'Loading pairing code...') + '</pre>' +
      '<div class="connect-help">Already paired: use this later to start the local computer runtime.</div>' +
      '<pre class="connect-command">' + escapeHtml(pairCommandStart || 'Loading start command...') + '</pre></div><button class="icon button-shadow" onclick="copyPairCommand()" aria-label="Copy commands">□</button></div>' +
      '<div class="connect-status"><span class="status-dot' + (connected ? ' online' : '') + '"></span><span>' + connectionText + '</span></div>' +
      '<div class="computer-actions"><button class="button-shadow" onclick="closeComputerDialog()">Cancel</button><button class="' + (connected ? 'primary-pink' : 'disabled-action') + ' button-shadow" onclick="' + (connected ? 'closeComputerDialog()' : 'refresh()') + '">' + (connected ? 'Done' : 'Done') + '</button></div>';
    return;
  }
  flow.innerHTML =
    '<div><div class="computer-kicker">Meet King AI</div><h2 class="computer-title">Add a Computer</h2></div>' +
    '<div class="computer-lead"><span class="computer-icon">▭</span><div><p>Your agents need somewhere to run. Connect a computer and they will come online there.</p><p class="computer-muted">Need an agent runtime installed: Claude Code or Codex CLI.</p></div></div>' +
    '<div class="computer-rule"></div>' +
    '<div class="computer-actions between"><label class="check-row"><input id="dontRemindComputer" type="checkbox" />Do not remind me again</label><span class="computer-actions"><button class="button-shadow" onclick="dismissComputerIntro()">Skip</button><button class="primary-pink button-shadow" onclick="openComputerFlow(&quot;select&quot;)">▭ Add Computer</button></span></div>';
}
function showPanel(name) {
  ['chat', 'tasks', 'files'].forEach(function(panel) {
    document.getElementById('panel-' + panel).classList.toggle('active', panel === name);
    document.querySelector('[data-panel="' + panel + '"]').classList.toggle('active', panel === name);
  });
}
function scrollToBottom() {
  const workspace = document.querySelector('.workspace');
  workspace.scrollTop = workspace.scrollHeight;
  shouldStickToBottom = true;
  updateBackToBottom();
}
function updateBackToBottom() {
  const workspace = document.querySelector('.workspace');
  const jump = document.querySelector('.jump');
  const distance = workspace.scrollHeight - workspace.clientHeight - workspace.scrollTop;
  const away = distance > 180;
  shouldStickToBottom = !away;
  jump.classList.toggle('visible', away);
}
async function handleWorkspaceScroll() {
  updateBackToBottom();
  const workspace = document.querySelector('.workspace');
  if (loadingOlderMessages || workspace.scrollTop > 24 || visibleMessageCount >= lastMessageTotal) return;
  loadingOlderMessages = true;
  const beforeHeight = workspace.scrollHeight;
  const beforeTop = workspace.scrollTop;
  visibleMessageCount = Math.min(visibleMessageCount + 20, lastMessageTotal);
  await refresh({ preserveScroll: true });
  workspace.scrollTop = workspace.scrollHeight - beforeHeight + beforeTop;
  loadingOlderMessages = false;
}
async function copyPairCommand() {
  if (!pairCommand) return;
  await navigator.clipboard.writeText(pairCommand).catch(function() {});
}
async function sendMessage() {
  if (sendingMessage) return;
  const input = document.getElementById('body');
  const button = document.getElementById('sendButton');
  const body = input.value.trim();
  if (!body) return;
  sendingMessage = true;
  input.value = '';
  input.blur();
  button.disabled = true;
  button.textContent = 'Sending';
  try {
    await request('/gui/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, conversationId: activeConversationId })
    });
    visibleMessageCount = 20;
    shouldStickToBottom = true;
    await refresh();
  } catch (error) {
    input.value = body;
    throw error;
  } finally {
    sendingMessage = false;
    button.disabled = false;
    button.textContent = 'Send';
  }
}
async function clearMessages() {
  await request('/gui/clear-messages', { method: 'POST' });
  visibleMessageCount = 20;
  shouldStickToBottom = true;
  await refresh();
}
async function saveAgentConfig() {
  const engine = document.getElementById('engine').value;
  const savedEngine = ((window.__lastState && window.__lastState.agents) || []).find(function(agent) { return agent.id === 'king-ai-ceo'; });
  if (savedEngine && savedEngine.engine && engine && engine !== savedEngine.engine) {
    const ok = confirm('Switching engine restarts all local agents and may take up to a minute. Continue?');
    if (!ok) return;
  }
  await request('/gui/agent-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      engine: document.getElementById('engine').value,
      lifecycle: 'on-demand',
      model: document.getElementById('model').value,
      fastModel: document.getElementById('fastModel').value
    })
  });
  await refresh();
}
function renderMessages(state, options) {
  const allRows = (state.messages || []).filter(function(message) { return message.conversation_id === activeConversationId; });
  if (allRows.length > lastMessageTotal) visibleMessageCount = 20;
  lastMessageTotal = allRows.length;
  visibleMessageCount = Math.min(Math.max(visibleMessageCount, 20), Math.max(lastMessageTotal, 20));
  const rows = allRows.slice(-visibleMessageCount);
  const hasOlder = rows.length < allRows.length;
  const unread = rows.filter(function(message) { return !(message.readBy || []).includes('king-ai-ceo') && message.author_kind === 'human'; }).length;
  const olderLine = hasOlder ? 'Pull down or scroll to top to load older messages...' : 'No older messages';
  const html = rows.length ? rows.map(function(message) {
    if (message.author_kind === 'system') {
      return '<div class="system-line">' + escapeHtml(message.body) + '</div>';
    }
    const initial = message.author_kind === 'agent' ? 'A' : '人';
    const name = message.author_kind === 'agent' ? (message.author_name || 'AI') : (message.author_name || 'you');
    const unreadClass = message.author_kind === 'human' && !(message.readBy || []).includes('king-ai-ceo') ? ' highlight' : '';
    return '<article class="post' + unreadClass + '"><div class="avatar">' + initial + '</div><div><div class="post-top"><span class="author">' + escapeHtml(name) + '</span><span class="time">' + formatTime(message.created_at) + '</span></div><div class="post-body">' + escapeHtml(message.body) + '</div></div></article>';
  }).join('') : '';
  document.getElementById('chatWindow').innerHTML = '<div class="system-line">' + olderLine + '</div>' + html;
  if (options && options.preserveScroll) updateBackToBottom();
  else if (shouldStickToBottom) scrollToBottom();
  else updateBackToBottom();
}
function activePanelName() {
  const tab = document.querySelector('.tab.active');
  return tab ? tab.getAttribute('data-panel') || 'chat' : 'chat';
}
function needsFullStateRefresh(panel) {
  return panel === 'tasks' || panel === 'files' || panel === 'decisions';
}
function mergeConversationMessages(state, conversationId, messages) {
  const others = (state.messages || []).filter(function(row) { return row.conversation_id !== conversationId; });
  return Object.assign({}, state, { messages: others.concat(messages || []) });
}
function applyConversationSwitchOptimistic() {
  const summary = window.__lastSummary;
  const state = window.__lastState;
  if (summary) renderConversations(Object.assign({}, summary, { state: state || {} }));
  if (state) {
    renderMessages(state);
    renderTasks(state);
  }
}
async function loadGuiPayload(options) {
  options = options || {};
  const conversationId = activeConversationId;
  const panel = options.panel || activePanelName();
  const full = Boolean(
    options.full ||
    (!options.conversationSwitch && needsFullStateRefresh(panel)) ||
    (!options.conversationSwitch && refreshPollCount++ % 6 === 0)
  );
  const summary = await request('/gui/summary?conversationId=' + encodeURIComponent(conversationId));
  let state;
  if (full) {
    state = await request('/gui/state');
  } else {
    const messagesPayload = await request('/gui/messages?conversationId=' + encodeURIComponent(conversationId));
    const baseState = window.__lastState || { messages: [], tasks: [], artifacts: [], approvals: [], workflowCards: [] };
    state = mergeConversationMessages(baseState, conversationId, messagesPayload.messages || []);
  }
  if (options.switchToken && options.switchToken !== conversationSwitchToken) return null;
  window.__lastState = state;
  window.__lastSummary = summary;
  return { summary: summary, state: state, full: full };
}
function selectConversation(id) {
  activeConversationId = id || 'king-ai-convo';
  localStorage.setItem('king-ai:activeConversationId', activeConversationId);
  visibleMessageCount = 20;
  shouldStickToBottom = true;
  applyConversationSwitchOptimistic();
  const switchToken = ++conversationSwitchToken;
  void loadGuiPayload({ conversationSwitch: true, switchToken: switchToken }).then(function(payload) {
    if (!payload) return;
    renderSummary(payload.summary);
    renderMessages(payload.state);
    renderTasks(payload.state);
  }).catch(function() {});
}
function createConversation() {
  const input = document.getElementById('newWindowTitle');
  input.value = '';
  const dialog = document.getElementById('newWindowDialog');
  if (!dialog.open) dialog.showModal();
  setTimeout(function() { input.focus(); }, 0);
}
function closeNewWindowDialog() {
  document.getElementById('newWindowDialog').close();
}
async function submitConversation(event) {
  event.preventDefault();
  const input = document.getElementById('newWindowTitle');
  const title = input.value.trim();
  const submit = document.getElementById('newWindowSubmit');
  submit.disabled = true;
  submit.textContent = 'Creating';
  try {
    const result = await request('/gui/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    activeConversationId = result.conversation.id;
    localStorage.setItem('king-ai:activeConversationId', activeConversationId);
    visibleMessageCount = 20;
    shouldStickToBottom = true;
    closeNewWindowDialog();
    await refresh();
  } finally {
    submit.disabled = false;
    submit.textContent = 'Create';
  }
}
function activeConversationStatus(summary, active) {
  const state = summary.state || {};
  const typing = (state.typingLog || []).slice().reverse().find(function(row) { return row.conversationId === active.id && !row.done; });
  const thinking = (state.thinkingLog || []).slice().reverse().find(function(row) { return row.action === 'mark' && (row.conversationIds || []).includes(active.id); });
  if (typing) return 'agent 正在输入...';
  if (thinking) return 'agent 正在处理...';
  if ((active.unread || 0) > 0) return '等待本地 agent 回复';
  return '';
}
function renderConversations(summary) {
  const conversations = summary.conversations || [];
  if (conversations.length && !conversations.some(function(row) { return row.id === activeConversationId; })) activeConversationId = conversations[0].id;
  const active = conversations.find(function(row) { return row.id === activeConversationId; }) || conversations[0] || { id: 'king-ai-convo', title: 'all' };
  document.querySelector('.channel-name').textContent = active.title || active.id;
  document.querySelector('.composer textarea').placeholder = 'Message #' + (active.title || active.id);
  document.querySelector('.hash').textContent = active.id === 'king-ai-convo' ? '#' : '~';
  document.getElementById('routeSummary').textContent = activeConversationStatus(summary, active);
  document.getElementById('conversationList').innerHTML = conversations.map(function(row) {
    const deletable = row.id !== 'king-ai-convo';
    return '<div class="window-item' + (row.id === activeConversationId ? ' active' : '') + '"><button class="window-select" onclick="selectConversation(&quot;' + escapeHtml(row.id) + '&quot;)"><span class="window-name">' + escapeHtml(row.title || row.id) + '</span></button><span class="window-meta">' + escapeHtml(row.unread || 0) + '</span>' + (deletable ? '<button class="window-delete" onclick="deleteConversation(event, &quot;' + escapeHtml(row.id) + '&quot;)" aria-label="Delete window">×</button>' : '') + '</div>';
  }).join('');
}
async function deleteConversation(event, id) {
  event.stopPropagation();
  await request('/gui/conversations/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
  if (activeConversationId === id) {
    activeConversationId = 'king-ai-convo';
    localStorage.setItem('king-ai:activeConversationId', activeConversationId);
  }
  visibleMessageCount = 20;
  shouldStickToBottom = true;
  await refresh();
}
function renderTasks(state) {
  const tasks = state.tasks || [];
  document.getElementById('taskBadge').textContent = String(tasks.filter(function(task) { return task.status !== 'done'; }).length);
  document.getElementById('panel-tasks').innerHTML = tasks.length ? tasks.slice().reverse().map(function(task) {
    return '<div class="task-row"><div class="task-top"><h3>' + escapeHtml(task.title) + '</h3><span class="time">' + escapeHtml(taskStatusLabel(task.status)) + ' P' + escapeHtml(task.priority) + '</span></div><p>' + escapeHtml(task.description || ((task.scope && task.scope.paths || []).join(', ')) || 'No description') + '</p></div>';
  }).join('') : '<p class="muted">No tasks yet.</p>';
  const artifacts = state.artifacts || [];
  document.getElementById('panel-files').innerHTML = artifacts.length ? artifacts.slice().reverse().map(function(artifact) {
    return '<div class="task-row"><div class="task-top"><h3>' + escapeHtml(artifact.path || artifact.name || 'artifact') + '</h3><span class="time">' + escapeHtml(artifact.kind || 'file') + '</span></div><p>' + escapeHtml(artifact.source || artifact.confidence || '') + '</p></div>';
  }).join('') : '<p class="muted">No files yet.</p>';
}
function renderSummary(summary) {
  const connection = summary.connection || {};
  const observation = summary.observation || { counts: {}, reasons: [] };
  const counts = observation.counts || {};
  const agent = summary.agent || {};
  lastConnection = connection;
  const heartbeatStat = document.getElementById('heartbeatStat');
  if (heartbeatStat) heartbeatStat.textContent = '最近心跳：' + (connection.lastHeartbeatAt ? formatTime(connection.lastHeartbeatAt) : '未收到');
  document.getElementById('unreadStat').textContent = String(counts.unreadMessages || 0);
  document.getElementById('failedStat').textContent = String(counts.failedRuns || 0);
  document.getElementById('activityBadge').textContent = String((counts.unreadMessages || 0) + (counts.failedRuns || 0));
  renderConversations({ ...summary, state: window.__lastState || {} });
  const observationReasons = document.getElementById('observationReasons');
  if (observationReasons) observationReasons.textContent = (observation.reasons || []).map(reasonLabel).join('；') || '等待下一条消息。';
  if (summary.pairingCode) {
    pairCommandPrimary = 'king-ai agent computer --pair ' + summary.pairingCode + ' --server ' + base + (summary.pairCommandTenantArg || '');
  pairCommandStart = 'king-ai agent computer --server ' + base + (summary.pairCommandTenantArg || '');
  pairCommand = pairCommandPrimary + '\\n' + pairCommandStart;
    if (document.getElementById('computerDialog').open) renderComputerFlow();
  }
  if (!connection.paired && !promptedForComputer && !localStorage.getItem('king-ai:addComputerDismissed')) {
    promptedForComputer = true;
    setTimeout(function() {
      if (!document.getElementById('settingsDialog').open && !document.getElementById('computerDialog').open) openComputerFlow('intro');
    }, 250);
  }
  const engines = summary.availableEngines || [];
  const settingsOpen = document.getElementById('settingsDialog').open;
  const engineSelect = document.getElementById('engine');
  // While the settings dialog is open, keep the user's in-progress choice instead of
  // resetting it to the saved engine on every auto-refresh.
  const selectedEngine = settingsOpen && engineSelect.value ? engineSelect.value : agent.engine;
  engineSelect.innerHTML = engines.length ? engines.map(function(engine) {
    return '<option value="' + escapeHtml(engine) + '"' + (engine === selectedEngine ? ' selected' : '') + '>' + escapeHtml(engine) + '</option>';
  }).join('') : '<option value="">请先配对</option>';
  if (!settingsOpen) {
    document.getElementById('model').value = agent.model === 'default' ? '' : (agent.model || '');
    document.getElementById('fastModel').value = agent.fastModel === 'default' ? '' : (agent.fastModel || '');
  }
  const modelRows = ['claude', 'codex', 'grok'].map(function(engine) {
    const available = engines.includes(engine);
    const active = agent.engine === engine;
    const label = active && !available ? '当前配置，未检测到本机' : available ? '可用' : '未检测到';
    return '<div class="model-row"><span>' + engine + (active ? ' · 当前' : '') + '</span><span class="' + (available ? 'available' : 'unavailable') + '">' + label + '</span></div>';
  }).join('');
  document.getElementById('modelStatus').innerHTML = modelRows + '<div class="model-row"><span>运行模式</span><span>' + lifecycleLabel(agent.lifecycle) + '</span></div>';
}
async function refresh(options) {
  const payload = await loadGuiPayload(options || {});
  if (!payload) return;
  renderSummary(payload.summary);
  renderMessages(payload.state, options || {});
  renderTasks(payload.state);
}
refresh();
document.querySelector('.workspace').addEventListener('scroll', handleWorkspaceScroll);
// Real-time updates over SSE: the server pushes a "change" nudge on any state change so the page
// refreshes instantly instead of relying on the poll. The poll below stays as a fallback.
let guiEventsHealthy = false;
let guiEventSource = null;
let refreshNudgeTimer = null;
function nudgeRefresh() {
  if (refreshNudgeTimer) return;
  refreshNudgeTimer = setTimeout(function() {
    refreshNudgeTimer = null;
    if (document.visibilityState === 'visible') refresh();
  }, 300);
}
function guiEventsUrl() {
  const params = new URLSearchParams(location.search);
  const assist = params.get('assist');
  const tenant = params.get('tenant');
  let url = base + '/gui/events';
  if (assist) url += '?assist=' + encodeURIComponent(assist) + (tenant ? '&tenant=' + encodeURIComponent(tenant) : '');
  return url;
}
function connectGuiEvents() {
  if (typeof EventSource === 'undefined') return;
  try {
    if (guiEventSource) guiEventSource.close();
    guiEventSource = new EventSource(guiEventsUrl());
    guiEventSource.addEventListener('open', function() { guiEventsHealthy = true; });
    guiEventSource.addEventListener('change', nudgeRefresh);
    guiEventSource.addEventListener('error', function() { guiEventsHealthy = false; });
  } catch (error) {
    guiEventsHealthy = false;
  }
}
connectGuiEvents();
// Fallback poll: slow while SSE is healthy, faster if the stream is down.
(function scheduleFallbackPoll() {
  setTimeout(function() {
    if (document.visibilityState === 'visible') refresh();
    scheduleFallbackPoll();
  }, guiEventsHealthy ? 15000 : 3500);
})();
document.addEventListener('visibilitychange', function() { if (document.visibilityState === 'visible') refresh(); });
`;
