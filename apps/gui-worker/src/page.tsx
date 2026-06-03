export function renderPage(styles: string, clientScript: string): string {
  const enhancementStyles = `
    .lang-switch { display: flex; gap: 4px; }
    .lang-switch button { min-height: 24px; padding: 3px 7px; }
    .lang-switch button.active { background: var(--accent); }
    .apply-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }
    .apply-status {
      min-height: 18px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
    }
    .computer-glyph {
      position: relative;
      width: 17px;
      height: 12px;
      display: inline-block;
      border: 2px solid var(--line);
      background: var(--accent);
      vertical-align: -2px;
    }
    .computer-glyph::after {
      content: "";
      position: absolute;
      left: 4px;
      right: 4px;
      bottom: -5px;
      height: 2px;
      background: var(--line);
    }
    .computer-icon .computer-glyph {
      width: 18px;
      height: 13px;
      vertical-align: 0;
    }
    .computer-action-label {
      display: inline-flex;
      align-items: center;
      gap: 7px;
    }
    .engine-chip {
      margin-left: 6px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      font-weight: 900;
    }
    .window-item:hover {
      border-color: var(--line);
      background: rgba(255, 216, 61, 0.34);
    }
    .window-item.active,
    .window-item.active:hover {
      background: var(--active);
    }
    .window-select:hover {
      background: transparent;
    }
    .post-top {
      display: flex;
      align-items: baseline;
      gap: 8px;
      min-width: 0;
      margin-bottom: 3px;
    }
    .post-top .author {
      display: inline-flex;
      align-items: baseline;
      min-width: 0;
      max-width: min(560px, 72vw);
      font-weight: 900;
    }
    .post-top .time {
      flex: 0 0 auto;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10px;
      white-space: nowrap;
    }
    .post.pending .post-body {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-weight: 800;
    }
    .typing-dots {
      display: inline-flex;
      gap: 4px;
      height: 10px;
      align-items: center;
    }
    .typing-dots span {
      width: 5px;
      height: 5px;
      border: 1px solid var(--line);
      background: var(--accent);
      animation: kingPendingDot 900ms infinite ease-in-out;
    }
    .typing-dots span:nth-child(2) { animation-delay: 120ms; }
    .typing-dots span:nth-child(3) { animation-delay: 240ms; }
    @keyframes kingPendingDot {
      0%, 80%, 100% { transform: translateY(0); opacity: 0.45; }
      40% { transform: translateY(-4px); opacity: 1; }
    }
    body.mobile-layout .app {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: 38px minmax(0, 1fr);
    }
    body.mobile-layout .rail {
      display: none;
    }
    body.mobile-layout .logo {
      width: 24px;
    }
    body.mobile-layout .logo span {
      width: 24px;
      height: 24px;
      font-size: 10px;
    }
    body.mobile-layout .windows {
      grid-column: 1;
      grid-row: 1;
      min-width: 0;
      border-right: 0;
      border-bottom: 2px solid var(--line);
      padding: 4px 6px;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      grid-template-rows: 1fr;
      align-items: center;
      gap: 6px;
      overflow: hidden;
    }
    body.mobile-layout .windows-head {
      min-width: 28px;
      padding: 0;
      border-bottom: 0;
      margin: 0;
    }
    body.mobile-layout .windows-head span {
      display: none;
    }
    body.mobile-layout .windows-head .icon {
      width: 28px;
      min-width: 28px;
      height: 28px;
    }
    body.mobile-layout .window-list {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 0 0 2px;
      scroll-snap-type: x proximity;
    }
    body.mobile-layout .window-list::-webkit-scrollbar {
      height: 7px;
    }
    body.mobile-layout .window-item {
      flex: 0 0 auto;
      width: auto;
      max-width: 138px;
      min-height: 28px;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 5px;
      padding: 3px 7px;
      border-color: var(--line);
      scroll-snap-align: start;
    }
    body.mobile-layout .window-select {
      overflow: hidden;
    }
    body.mobile-layout .window-name {
      display: block;
    }
    body.mobile-layout .window-delete {
      width: 18px;
      min-width: 18px;
      min-height: 18px;
    }
    body.mobile-layout .main {
      grid-column: 1;
      grid-row: 2;
      height: calc(100vh - 38px);
      min-width: 0;
      grid-template-rows: auto auto minmax(0, 1fr);
    }
    body.mobile-layout .topbar {
      height: 42px;
      min-width: 0;
      padding: 4px 6px;
      gap: 6px;
    }
    body.mobile-layout .channel-head {
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 6px;
      min-width: 0;
    }
    body.mobile-layout .hash {
      width: 24px;
      height: 24px;
    }
    body.mobile-layout .channel-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    body.mobile-layout .channel-desc {
      max-width: 100%;
      font-size: 10px;
    }
    body.mobile-layout .top-actions {
      flex: 0 0 auto;
      max-width: min(244px, 52vw);
      gap: 4px;
      overflow-x: auto;
      overflow-y: hidden;
      padding-bottom: 2px;
    }
    body.mobile-layout .hide-mobile {
      display: inline-block !important;
    }
    body.mobile-layout .lang-switch button,
    body.mobile-layout .top-actions > button:not(.hide-mobile) {
      min-height: 28px;
      padding: 3px 6px;
      white-space: nowrap;
    }
    body.mobile-layout .tabs {
      height: 28px;
      overflow-x: auto;
    }
    body.mobile-layout .tab {
      flex: 0 0 auto;
      min-width: 58px;
      padding: 4px 12px;
    }
    body.mobile-layout .chat-panel {
      padding: 10px 0 100px;
    }
    body.mobile-layout .message-list {
      padding: 0 10px;
      gap: 14px;
    }
    body.mobile-layout .post {
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 7px;
      padding: 6px 0;
      max-width: 100%;
    }
    body.mobile-layout .post.highlight {
      padding: 6px;
    }
    body.mobile-layout .post-top {
      flex-wrap: wrap;
      gap: 4px 7px;
    }
    body.mobile-layout .post-top .author {
      max-width: calc(100vw - 118px);
      flex-wrap: wrap;
    }
    body.mobile-layout .engine-chip {
      margin-left: 4px;
      font-size: 10px;
    }
    body.mobile-layout .post-body {
      font-size: 14px;
      line-height: 1.5;
    }
    body.mobile-layout .jump {
      bottom: 96px;
    }
    body.mobile-layout .composer {
      left: 8px;
      right: 8px;
      bottom: 8px;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px;
      padding: 6px;
    }
    body.mobile-layout .composer textarea {
      min-height: 52px;
      max-height: 90px;
      padding: 8px 6px;
      font-size: 14px;
    }
    body.mobile-layout .composer button {
      min-width: 54px;
      padding: 6px 8px;
    }
    body.mobile-layout dialog {
      width: calc(100vw - 22px);
      max-height: calc(100vh - 22px);
    }
    body.mobile-layout .modal-body,
    body.mobile-layout .computer-flow {
      padding: 16px;
    }
  `;
  const enhancementScript = `
const LANG_KEY = 'king:lang';
let currentLang = localStorage.getItem(LANG_KEY) || 'zh';
const TRANSLATIONS = {
  zh: {
    windows: '窗口',
    allWindow: '全部',
    refresh: '刷新',
    settings: '设置',
    chat: '聊天',
    tasks: '任务',
    files: '文件',
    settingsTitle: '设置',
    modelStatus: '模型状态',
    agentPersona: 'Agent 人设',
    agentRuntime: 'Agent 运行时',
    name: '名称',
    rolePersona: '角色 / 人设',
    localCli: '本地 CLI',
    mainModel: '主模型',
    fastModel: '快速模型',
    apply: '应用',
    saving: '保存中...',
    saved: '已保存',
    addComputer: '添加电脑',
    newWindow: '新窗口',
    windowName: '名称',
    cancel: '取消',
    create: '创建',
    clearScreen: '清屏',
    clearing: '清屏中',
    send: '发送',
    sending: '发送中',
    connectComputer: '连接电脑',
    connectIntro: '>_ 在你的电脑上运行下面命令来连接：',
    firstPairing: '首次配对：只需要运行一次，把当前浏览器会话绑定到本机。',
    alreadyPaired: '已经配对：后续只需要运行这条命令启动本地运行时。',
    copy: '复制',
    copied: '已复制',
    computerConnected: '电脑已连接。',
    computerPaired: '电脑已配对，等待上线...',
    waitingComputer: '等待电脑连接...',
    done: '完成',
    waitingAgent: '等待本地 agent 回复',
    agentThinking: 'agent 正在处理...',
    agentTyping: 'agent 正在输入...',
    channelDesc: '所有成员的通用频道',
    noMessages: '还没有消息。输入一句话，发送给本地 AI。',
    mainModelPlaceholder: '例如 opus / gpt-5，留空使用默认',
    fastModelPlaceholder: '留空使用默认小模型',
    windowPlaceholder: '例如 发布计划 / 客户 A',
    meetKing: '认识 King',
    addComputerTitle: '添加电脑',
    addComputerLead: '你的 agents 需要一台电脑来运行。连接这台电脑后，它们会在这里上线。',
    addComputerRuntime: '需要先安装一种 agent runtime：Claude Code、Codex CLI、Kimi CLI、Copilot CLI、Cursor CLI、Gemini CLI、OpenCode 或 Pi。',
    doNotRemind: '不再提醒我',
    skip: '跳过',
    next: '下一步',
    yourComputer: '你的电脑',
    yourComputerDesc: '在你自己的电脑上运行 agents',
    cloudComputer: '云电脑',
    comingSoon: '即将支持',
    loadingPairing: '正在加载配对码...',
    loadingStart: '正在加载启动命令...'
  },
  en: {
    windows: 'Windows',
    allWindow: 'all',
    refresh: 'Refresh',
    settings: 'Settings',
    chat: 'Chat',
    tasks: 'Tasks',
    files: 'Files',
    settingsTitle: 'Settings',
    modelStatus: 'Model status',
    agentPersona: 'Agent persona',
    agentRuntime: 'Agent runtime',
    name: 'Name',
    rolePersona: 'Role / persona',
    localCli: 'Local CLI',
    mainModel: 'Main model',
    fastModel: 'Fast model',
    apply: 'Apply',
    saving: 'Saving...',
    saved: 'Saved',
    addComputer: 'Add computer',
    newWindow: 'New Window',
    windowName: 'Name',
    cancel: 'Cancel',
    create: 'Create',
    clearScreen: 'Clear',
    clearing: 'Clearing',
    send: 'Send',
    sending: 'Sending',
    connectComputer: 'CONNECT COMPUTER',
    connectIntro: '>_ Run this command on your computer to connect:',
    firstPairing: 'First-time pairing: run this once to attach this browser session.',
    alreadyPaired: 'Already paired: use this later to start the local computer runtime.',
    copy: 'Copy',
    copied: 'Copied',
    computerConnected: 'Computer connected.',
    computerPaired: 'Computer paired. Waiting for it to come online...',
    waitingComputer: 'Waiting for computer to connect...',
    done: 'Done',
    waitingAgent: 'Waiting for local agent',
    agentThinking: 'agent is processing...',
    agentTyping: 'agent is typing...',
    channelDesc: 'General channel for all members',
    noMessages: 'No messages yet. Type something and send it to the local AI.',
    mainModelPlaceholder: 'e.g. opus / gpt-5, blank means default',
    fastModelPlaceholder: 'Blank means default fast model',
    windowPlaceholder: 'e.g. Release plan / Client A',
    meetKing: 'Meet King',
    addComputerTitle: 'Add a Computer',
    addComputerLead: 'Your agents need somewhere to run. Connect a computer and they will come online there.',
    addComputerRuntime: 'Need an agent runtime installed: Claude Code, Codex CLI, Kimi CLI, Copilot CLI, Cursor CLI, Gemini CLI, OpenCode, or Pi.',
    doNotRemind: 'Do not remind me again',
    skip: 'Skip',
    next: 'Next',
    yourComputer: 'Your Computer',
    yourComputerDesc: 'Run agents on your own computer',
    cloudComputer: 'Cloud Computer',
    comingSoon: 'Coming soon',
    loadingPairing: 'Loading pairing code...',
    loadingStart: 'Loading start command...'
  }
};
formatTime = function(value) {
  if (!value) return currentLang === 'zh' ? '未收到' : 'not received';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
function t(key) {
  return (TRANSLATIONS[currentLang] && TRANSLATIONS[currentLang][key]) || TRANSLATIONS.en[key] || key;
}
function applyLanguage() {
  document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach(function(node) {
    node.textContent = t(node.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(node) {
    node.setAttribute('placeholder', t(node.getAttribute('data-i18n-placeholder')));
  });
  document.querySelectorAll('[data-lang]').forEach(function(node) {
    node.classList.toggle('active', node.getAttribute('data-lang') === currentLang);
  });
  const sendButton = document.getElementById('sendButton');
  if (sendButton && !sendButton.disabled) sendButton.textContent = t('send');
  const clearButton = document.getElementById('clearButton');
  if (clearButton && !clearButton.disabled) clearButton.textContent = t('clearScreen');
  if (typeof renderConversations === 'function' && window.__lastSummary) renderConversations({ ...window.__lastSummary, state: window.__lastState || {} });
  if (document.getElementById('computerDialog').open) renderComputerFlow();
}
function setLanguage(lang) {
  currentLang = lang === 'en' ? 'en' : 'zh';
  localStorage.setItem(LANG_KEY, currentLang);
  applyLanguage();
  refresh();
}
const mobileQuery = window.matchMedia('(max-width: 760px)');
function syncMobileLayout() {
  document.body.classList.toggle('mobile-layout', mobileQuery.matches);
}
syncMobileLayout();
if (mobileQuery.addEventListener) {
  mobileQuery.addEventListener('change', syncMobileLayout);
} else if (mobileQuery.addListener) {
  mobileQuery.addListener(syncMobileLayout);
}
function copyText(value, button) {
  if (!value) return;
  navigator.clipboard.writeText(value).catch(function() {});
  if (!button) return;
  const old = button.textContent;
  button.textContent = t('copied');
  setTimeout(function() { button.textContent = old || t('copy'); }, 900);
}
renderComputerFlow = function() {
  const connected = Boolean(lastConnection.online);
  const paired = Boolean(lastConnection.paired);
  const connectionText = connected ? t('computerConnected') : paired ? t('computerPaired') : t('waitingComputer');
  const flow = document.getElementById('computerFlow');
  if (computerStep === 'connect') {
    flow.innerHTML =
      '<div class="computer-actions"><button class="icon button-shadow" onclick="closeComputerDialog()" aria-label="Close">x</button></div>' +
      '<h2 class="computer-title">' + t('connectComputer') + '</h2>' +
      '<p><strong>' + t('connectIntro') + '</strong></p>' +
      '<div class="connect-stack">' +
      '<div class="connect-help">' + t('firstPairing') + '</div>' +
      '<div class="connect-row"><pre class="connect-command">' + escapeHtml(pairCommandPrimary || t('loadingPairing')) + '</pre><button class="button-shadow" onclick="copyText(pairCommandPrimary, this)">' + t('copy') + '</button></div>' +
      '<div class="connect-help">' + t('alreadyPaired') + '</div>' +
      '<div class="connect-row"><pre class="connect-command">' + escapeHtml(pairCommandStart || t('loadingStart')) + '</pre><button class="button-shadow" onclick="copyText(pairCommandStart, this)">' + t('copy') + '</button></div>' +
      '</div>' +
      '<div class="connect-status"><span class="status-dot' + (connected ? ' online' : '') + '"></span><span>' + connectionText + '</span></div>' +
      '<div class="computer-actions"><button class="button-shadow" onclick="closeComputerDialog()">' + t('cancel') + '</button><button class="' + (connected ? 'primary-pink' : 'disabled-action') + ' button-shadow" onclick="' + (connected ? 'closeComputerDialog()' : 'refresh()') + '">' + t('done') + '</button></div>';
    return;
  }
  if (computerStep === 'select') {
    flow.innerHTML =
      '<div class="computer-actions"><button class="icon button-shadow" onclick="closeComputerDialog()" aria-label="Close">x</button></div>' +
      '<h2 class="computer-title">' + t('addComputerTitle') + '</h2>' +
      '<div class="choice-grid">' +
      '<button class="computer-choice active" onclick="openComputerFlow(&quot;connect&quot;)"><span class="computer-icon"><span class="computer-glyph" aria-hidden="true"></span></span><span><strong class="computer-choice-title">' + t('yourComputer') + '</strong><span class="computer-muted">' + t('yourComputerDesc') + '</span></span></button>' +
      '<button class="computer-choice disabled" type="button"><span class="computer-icon">☁</span><span><strong class="computer-choice-title">' + t('cloudComputer') + '</strong><span class="computer-muted">' + t('comingSoon') + '</span></span></button>' +
      '</div>' +
      '<div class="computer-actions"><button class="button-shadow" onclick="closeComputerDialog()">' + t('cancel') + '</button><button class="primary-pink button-shadow" onclick="openComputerFlow(&quot;connect&quot;)">' + t('next') + '</button></div>';
    return;
  }
  flow.innerHTML =
    '<div><div class="computer-kicker">' + t('meetKing') + '</div><h2 class="computer-title">' + t('addComputerTitle') + '</h2></div>' +
    '<div class="computer-lead"><span class="computer-icon"><span class="computer-glyph" aria-hidden="true"></span></span><div><p>' + t('addComputerLead') + '</p><p class="computer-muted">' + t('addComputerRuntime') + '</p></div></div>' +
    '<div class="computer-rule"></div>' +
    '<div class="computer-actions between"><label class="check-row"><input id="dontRemindComputer" type="checkbox" />' + t('doNotRemind') + '</label><span class="computer-actions"><button class="button-shadow" onclick="dismissComputerIntro()">' + t('skip') + '</button><button class="primary-pink button-shadow" onclick="openComputerFlow(&quot;select&quot;)"><span class="computer-action-label"><span class="computer-glyph" aria-hidden="true"></span>' + t('addComputer') + '</span></button></span></div>';
};
activeConversationStatus = function(summary, active) {
  const state = summary.state || {};
  const typing = (state.typingLog || []).slice().reverse().find(function(row) { return row.conversationId === active.id && !row.done; });
  const thinking = (state.thinkingLog || []).slice().reverse().find(function(row) { return row.action === 'mark' && (row.conversationIds || []).includes(active.id); });
  if (typing) return t('agentTyping');
  if (thinking) return t('agentThinking');
  if ((active.unread || 0) > 0) return t('waitingAgent');
  return t('channelDesc');
};
saveAgentConfig = async function() {
  const button = document.getElementById('applyAgentButton');
  const status = document.getElementById('applyStatus');
  if (button) {
    button.disabled = true;
    button.textContent = t('saving');
  }
  if (status) status.textContent = t('saving');
  try {
    await request('/gui/agent-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('agentName').value,
        role: document.getElementById('agentRole').value,
        engine: document.getElementById('engine').value,
        lifecycle: 'on-demand',
        model: document.getElementById('model').value,
        fastModel: document.getElementById('fastModel').value
      })
    });
    await new Promise(function(resolve) { setTimeout(resolve, 5000); });
    await refresh();
    if (status) status.textContent = t('saved');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = t('apply');
    }
    setTimeout(function() { if (status && status.textContent === t('saved')) status.textContent = ''; }, 1800);
  }
};
sendMessage = async function() {
  if (sendingMessage) return;
  const input = document.getElementById('body');
  const button = document.getElementById('sendButton');
  const body = input.value.trim();
  if (!body) return;
  sendingMessage = true;
  input.value = '';
  input.blur();
  button.disabled = true;
  button.textContent = t('sending');
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
    button.textContent = t('send');
  }
};
clearMessages = async function() {
  const button = document.getElementById('clearButton');
  if (button) {
    button.disabled = true;
    button.textContent = t('clearing');
  }
  try {
    await request('/gui/clear-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: activeConversationId })
    });
    visibleMessageCount = 20;
    lastMessageTotal = 0;
    shouldStickToBottom = true;
    await refresh();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = t('clearScreen');
    }
  }
};
renderMessages = function(state, options) {
  const allRows = (state.messages || []).filter(function(message) { return message.conversation_id === activeConversationId; });
  if (allRows.length > lastMessageTotal) visibleMessageCount = 20;
  lastMessageTotal = allRows.length;
  visibleMessageCount = Math.min(Math.max(visibleMessageCount, 20), Math.max(lastMessageTotal, 20));
  const rows = allRows.slice(-visibleMessageCount);
  const hasOlder = rows.length < allRows.length;
  const olderLine = hasOlder ? 'Pull down or scroll to top to load older messages...' : 'No older messages';
  function authorHtml(message) {
    const name = message.author_kind === 'agent' ? (message.author_name || 'AI') : (message.author_name || 'you');
    const engine = message.author_kind === 'agent' && message.author_engine ? '<span class="engine-chip">' + escapeHtml(message.author_engine) + '</span>' : '';
    return escapeHtml(name) + engine;
  }
  const html = rows.map(function(message) {
    if (message.author_kind === 'system') {
      return '<div class="system-line">' + escapeHtml(message.body) + '</div>';
    }
    const initial = message.author_kind === 'agent' ? 'A' : '人';
    const unreadClass = message.author_kind === 'human' && !(message.readBy || []).includes('king-agent') ? ' highlight' : '';
    const pendingClass = message.status === 'pending' ? ' pending' : '';
    const bodyHtml = message.status === 'pending' ? '<span class="typing-dots"><span></span><span></span><span></span></span><span>' + escapeHtml(t('agentThinking')) + '</span>' : escapeHtml(message.body);
    return '<article class="post' + pendingClass + unreadClass + '"><div class="avatar">' + initial + '</div><div><div class="post-top"><span class="author">' + authorHtml(message) + '</span><span class="time">' + formatTime(message.created_at) + '</span></div><div class="post-body">' + bodyHtml + '</div></div></article>';
  }).join('');
  document.getElementById('chatWindow').innerHTML = '<div class="system-line">' + olderLine + '</div>' + html;
  if (options && options.preserveScroll) updateBackToBottom();
  else if (shouldStickToBottom) scrollToBottom();
  else updateBackToBottom();
};
function displayConversationTitle(row) {
  if (!row || row.id === 'king-convo') return t('allWindow');
  return row.title || row.id;
}
renderConversations = function(summary) {
  const conversations = summary.conversations || [];
  if (conversations.length && !conversations.some(function(row) { return row.id === activeConversationId; })) activeConversationId = conversations[0].id;
  const active = conversations.find(function(row) { return row.id === activeConversationId; }) || conversations[0] || { id: 'king-convo', title: 'all' };
  const activeTitle = displayConversationTitle(active);
  document.querySelector('.channel-name').textContent = activeTitle;
  document.querySelector('.composer textarea').placeholder = 'Message #' + activeTitle;
  document.querySelector('.hash').textContent = active.id === 'king-convo' ? '#' : '~';
  document.getElementById('routeSummary').textContent = activeConversationStatus(summary, active);
  document.getElementById('conversationList').innerHTML = conversations.map(function(row) {
    const deletable = row.id !== 'king-convo';
    return '<div class="window-item' + (row.id === activeConversationId ? ' active' : '') + '"><button class="window-select" onclick="selectConversation(&quot;' + escapeHtml(row.id) + '&quot;)"><span class="window-name">' + escapeHtml(displayConversationTitle(row)) + '</span></button><span class="window-meta">' + escapeHtml(row.unread || 0) + '</span>' + (deletable ? '<button class="window-delete" onclick="deleteConversation(event, &quot;' + escapeHtml(row.id) + '&quot;)" aria-label="Delete window">x</button>' : '') + '</div>';
  }).join('');
};
const baseRenderSummary = renderSummary;
renderSummary = function(summary) {
  window.__lastSummary = summary;
  baseRenderSummary(summary);
};
applyLanguage();
  `;
  return "<!doctype html>" + (
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>King Chat</title>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <style dangerouslySetInnerHTML={{ __html: enhancementStyles }} />
      </head>
      <body>
        <main class="app">
          <aside class="rail" aria-label="Primary navigation">
            <div class="logo" aria-label="King"><span>K</span></div>
            <div></div>
          </aside>

          <aside class="windows" aria-label="Conversation windows">
            <div class="windows-head">
              <span data-i18n="windows">Windows</span>
              <button class="icon" onclick="createConversation()" aria-label="New window">+</button>
            </div>
            <div id="conversationList" class="window-list"></div>
          </aside>

          <aside class="sidebar">
            <div class="side-title">
              <h1>Chat</h1>
              <button class="icon" onclick="openSettings()" aria-label="Open settings">#</button>
            </div>
            <nav class="side-section" aria-label="Shortcuts">
              <a class="side-link" href="#activity"><span>~ Activity</span><span class="badge" id="activityBadge">0</span></a>
              <a class="side-link" href="#saved"><span>[] Saved</span><span class="badge"> </span></a>
            </nav>
            <div class="side-section">
              <div class="side-label">Channels</div>
              <a class="channel active" href="#all"><span># all</span><span class="badge" id="unreadStat">0</span></a>
              <a class="channel" href="#feedback"><span># Bug反馈</span><span class="badge">00+</span></a>
              <a class="channel" href="#features"><span># 功能需求</span><span class="badge">00+</span></a>
              <a class="channel" href="#tasks"><span># 任务反馈</span><span class="badge" id="taskBadge">0</span></a>
              <a class="channel" href="#announcements"><span># 公告</span><span class="badge">24</span></a>
              <a class="channel" href="#cases"><span># 案例分享</span><span class="badge">9</span></a>
              <a class="channel" href="#water"><span># 闲聊</span><span class="badge">99</span></a>
            </div>
            <div class="side-section">
              <div class="side-label">Direct messages</div>
              <a class="side-link" href="#agent"><span>AI</span><span class="badge" id="failedStat">0</span></a>
            </div>
          </aside>

          <section class="main">
            <header class="topbar">
              <div class="channel-head">
                <div class="hash">#</div>
                <div>
                  <div class="channel-name">all</div>
                  <div class="channel-desc" id="routeSummary" data-i18n="channelDesc">General channel for all members</div>
                </div>
              </div>
              <div class="top-actions">
                <span class="lang-switch" aria-label="Language">
                  <button data-lang="zh" onclick="setLanguage('zh')">中文</button>
                  <button data-lang="en" onclick="setLanguage('en')">EN</button>
                </span>
                <button class="hide-mobile" id="clearButton" onclick="clearMessages()" data-i18n="clearScreen">Clear</button>
                <button class="hide-mobile" onclick="refresh()" data-i18n="refresh">Refresh</button>
                <button onclick="openSettings()" data-i18n="settings">Settings</button>
              </div>
            </header>

            <nav class="tabs" aria-label="Channel views">
              <button class="tab active" data-panel="chat" onclick="showPanel('chat')" data-i18n="chat">Chat</button>
              <button class="tab" data-panel="tasks" onclick="showPanel('tasks')" data-i18n="tasks">Tasks</button>
              <button class="tab" data-panel="files" onclick="showPanel('files')" data-i18n="files">Files</button>
            </nav>

            <section class="workspace">
              <section id="panel-chat" class="panel active chat-panel">
                <div id="chatWindow" class="message-list"></div>
                <button class="jump" onclick="scrollToBottom()">↓ Back to bottom</button>
                <div class="composer">
                  <textarea id="body" placeholder="Message #all"></textarea>
                  <button id="sendButton" class="primary" onclick="sendMessage()">Send</button>
                </div>
              </section>
              <section id="panel-tasks" class="panel tab-panel"></section>
              <section id="panel-files" class="panel tab-panel"></section>
            </section>
          </section>
        </main>

        <dialog id="settingsDialog">
          <div class="modal-head">
            <h2 data-i18n="settingsTitle">Settings</h2>
            <button class="icon" onclick="closeSettings()" aria-label="Close settings">x</button>
          </div>
          <div class="modal-body">
            <section class="side-card">
              <h2 data-i18n="modelStatus">Model status</h2>
              <div class="model-grid" id="modelStatus"></div>
            </section>
            <section class="side-card">
              <h2 data-i18n="agentPersona">Agent persona</h2>
              <div class="field">
                <label for="agentName" data-i18n="name">Name</label>
                <input id="agentName" placeholder="King Agent" />
              </div>
              <div class="field">
                <label for="agentRole" data-i18n="rolePersona">Role / persona</label>
                <textarea id="agentRole" placeholder="Local BYOA agent"></textarea>
              </div>
            </section>
            <section class="side-card">
              <h2 data-i18n="agentRuntime">Agent runtime</h2>
              <div class="field">
                <label for="engine" data-i18n="localCli">Local CLI</label>
                <select id="engine"></select>
              </div>
              <div class="field">
                <label for="model" data-i18n="mainModel">Main model</label>
                <input id="model" placeholder="例如 opus / gpt-5，留空使用默认" data-i18n-placeholder="mainModelPlaceholder" />
              </div>
              <div class="field">
                <label for="fastModel" data-i18n="fastModel">Fast model</label>
                <input id="fastModel" placeholder="留空使用默认小模型" data-i18n-placeholder="fastModelPlaceholder" />
              </div>
              <div class="apply-row">
                <span id="applyStatus" class="apply-status"></span>
                <button id="applyAgentButton" onclick="saveAgentConfig()" data-i18n="apply">Apply</button>
              </div>
            </section>
            <div class="settings-actions">
              <button class="primary" onclick="openComputerFlow('intro')" data-i18n="addComputer">Add computer</button>
            </div>
          </div>
        </dialog>
        <dialog id="computerDialog" class="computer-dialog">
          <div id="computerFlow" class="computer-flow"></div>
        </dialog>
        <dialog id="newWindowDialog" class="window-dialog">
          <form id="newWindowForm" class="modal-form" onsubmit="submitConversation(event)">
            <div class="modal-head">
                <h2 data-i18n="newWindow">New Window</h2>
              <button class="icon" type="button" onclick="closeNewWindowDialog()" aria-label="Close new window">x</button>
            </div>
            <div class="modal-body">
              <div class="field">
                <label for="newWindowTitle" data-i18n="windowName">Name</label>
                <input id="newWindowTitle" placeholder="例如 发布计划 / 客户 A" data-i18n-placeholder="windowPlaceholder" autocomplete="off" />
              </div>
              <div class="settings-actions">
                <button class="button-shadow" type="button" onclick="closeNewWindowDialog()" data-i18n="cancel">Cancel</button>
                <button id="newWindowSubmit" class="primary-pink button-shadow" type="submit" data-i18n="create">Create</button>
              </div>
            </div>
          </form>
        </dialog>
        <script dangerouslySetInnerHTML={{ __html: clientScript }} />
        <script dangerouslySetInnerHTML={{ __html: enhancementScript }} />
      </body>
    </html>
  ).toString();
}
