export const guiClientEnhancementScript = `
function shellQuote(value) {
  const singleQuote = String.fromCharCode(39);
  const doubleQuote = String.fromCharCode(34);
  return singleQuote + String(value).split(singleQuote).join(singleQuote + doubleQuote + singleQuote + doubleQuote + singleQuote) + singleQuote;
}
const ASSIST_PARAMS = new URLSearchParams(location.search);
const assistToken = ASSIST_PARAMS.get('assist') || '';
const assistTenant = ASSIST_PARAMS.get('tenant') || '';
const LANG_KEY = 'king-ai:lang';
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
    agentRuntime: 'Agent 运行时',
    localCli: '本地 CLI',
    mainModel: '主模型',
    fastModel: '快速模型',
    apply: '应用',
    saving: '保存中...',
    saved: '已保存',
    addComputer: '添加电脑',
    remoteAssist: '远程协助',
    remoteAssistDesc: '生成一个可多人使用的远程协助链接，同事打开后可以在这个窗口里发消息、看任务和处理决策；链接长期有效，直到你撤销。',
    remoteDevices: '远端测试机',
    remoteDevicesDesc: '配置 agent 可自主连接的测试机，用于查看日志、数据库记录、Redis 状态和统计信息。',
    remoteConfigJson: 'JSON 配置',
    loadRemoteConfig: '加载当前配置',
    copyRemoteConfig: '复制 JSON',
    saveRemoteConfig: '保存 JSON 配置',
    probeDevice: '测试连接',
    profileDevice: '探测环境',
    noRemoteDevices: '尚未配置远端测试机',
    hostBridgeMissing: '未配置 KING_AI_HOST_URL，无法连接本机 host server。',
    createAssistLink: '生成链接',
    revokeAssistLink: '撤销链接',
    assistNoLink: '尚未生成远程协助链接',
    assistActive: '链接已启用，可多人使用。',
    assistCopyUnavailable: '完整链接只会在生成时显示；请重新生成链接后复制。',
    dataResetTitle: '重新开始',
    dataResetDesc: '还原到系统最初状态：清除当前账号下的窗口、消息、任务、文件、决策、配对信息和运行记录，并通知本机清理所有 agent 上下文、会话和 workspace。操作后会生成新的配对码。',
    dataResetButton: '还原初始状态',
    dataResetConfirm: '再次点击确认清除',
    dataResetting: '正在清除...',
    dataResetDone: '已还原，可以重新开始。',
	    dataResetFailed: '清除失败，请稍后重试。',
	    attachFile: '添加附件',
	    attachments: '附件',
	    removeAttachment: '移除',
	    newWindow: '新窗口',
    windowName: '名称',
    windowWorkflow: '工作流',
    windowMode: '协作方式',
    singleAgent: '单 Agent',
    singleAgentDesc: '只让负责人回复',
    defaultTeam: '默认团队',
    defaultTeamDesc: '按工作流角色协作',
    customTeam: '自定义',
    customTeamDesc: '选择参与角色',
    windowTeam: '参与角色',
    agentPrompts: '角色提示词',
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
    runActive: '运行中',
    runIdle: '空闲',
    backToBottom: '↓ 回到底部',
    loadOlder: '向上滚动加载更早消息...',
    noOlderMessages: '没有更早消息',
    channelDesc: '所有成员的通用频道',
    noMessages: '还没有消息。输入一句话，发送给本地 AI。',
    taskBoardTitle: '任务',
    taskFilterAll: '全部',
    taskFilterActive: '进行中',
    taskFilterDone: '已完成',
    taskEmpty: '暂无任务',
    taskOpenChat: '查看聊天',
    taskChatTitle: '任务聊天记录',
    taskChatEmpty: '这个任务暂无聊天记录',
    taskChatNoConversation: '这个任务没有绑定聊天窗口',
    taskChatClose: '关闭',
    taskAssigneeFallback: '未分配',
    noDescription: '暂无描述',
    fileEmpty: '暂无文件',
    decisions: '决策',
    decisionEmpty: '暂无待人类决策事项',
    decisionPending: '待决策',
    decisionApproved: '已批准',
    decisionDenied: '已否决',
    decisionApprove: '批准',
    decisionDeny: '否决',
    decisionSourceHost: '来自电脑',
    taskStatusPending: '待分配',
    taskStatusAssigned: '已分配',
    taskStatusInProgress: '进行中',
    taskStatusReview: '待评审',
    taskStatusDone: '已完成',
    taskStatusFailed: '失败',
    taskStatusBlocked: '被阻塞',
    taskEventAssigned: '已分配',
    taskEventReview: '提交评审',
    taskEventCompleted: '已完成',
    taskEventChanges: '需修改',
    vocabAudio: '播放单词发音',
    vocabAudioLoading: '正在加载单词发音',
    vocabAudioStop: '停止单词发音',
    vocabAudioFailed: '单词发音失败',
    vocabMeaning: '词义',
    vocabPos: '词性',
    vocabPhonetic: '音标',
    vocabSyllables: '音节',
    vocabRoots: '词根词缀',
    vocabNoDetails: '词义待补充',
    agentStatusRunning: '运行中',
    agentStatusThinking: '思考中',
    agentStatusUnread: '未读',
    agentStatusTasks: '任务',
    agentStatusCards: '卡片',
    agentStatusIdle: '空闲',
    agentStatusAvailable: '可用',
    artifactsLabel: '产物',
    revisionLabel: '退回原因',
    mainModelPlaceholder: '例如 opus / gpt-5，留空使用默认',
    fastModelPlaceholder: '留空使用默认小模型',
    windowPlaceholder: '例如 发布计划 / 客户 A',
    workflowSoftwareDev: '软件开发',
    workflowIeltsStudy: '雅思学习',
    meetKing: '认识 King AI',
    addComputerTitle: '添加电脑',
    addComputerLead: '你的 agents 需要一台电脑来运行。连接这台电脑后，它们会在这里上线。',
    addComputerRuntime: '需要先安装一种 agent runtime：Claude Code 或 Codex CLI。',
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
    agentRuntime: 'Agent runtime',
    localCli: 'Local CLI',
    mainModel: 'Main model',
    fastModel: 'Fast model',
    apply: 'Apply',
    saving: 'Saving...',
    saved: 'Saved',
    addComputer: 'Add computer',
    remoteAssist: 'Remote Assist',
    remoteAssistDesc: 'Create one reusable remote assist link so teammates can chat, view tasks, and resolve decisions in this workspace. The link stays valid until revoked.',
    remoteDevices: 'Remote Test Devices',
    remoteDevicesDesc: 'Configure test machines agents may use for logs, database records, Redis state, and statistics.',
    remoteConfigJson: 'JSON config',
    loadRemoteConfig: 'Load current config',
    copyRemoteConfig: 'Copy JSON',
    saveRemoteConfig: 'Save JSON config',
    probeDevice: 'Test',
    profileDevice: 'Profile',
    noRemoteDevices: 'No remote test devices configured',
    hostBridgeMissing: 'KING_AI_HOST_URL is not configured; local host server is unavailable.',
    createAssistLink: 'Create link',
    revokeAssistLink: 'Revoke link',
    assistNoLink: 'No remote assist link yet',
    assistActive: 'Link enabled; multiple people can use it.',
    assistCopyUnavailable: 'The full link is only shown when created. Create a new link to copy it.',
    dataResetTitle: 'Start over',
    dataResetDesc: 'Restore the initial system state: clear current account windows, messages, tasks, files, decisions, pairing info, and run history, then ask this computer to clear every agent context, session, and workspace. A new pairing code will be generated.',
    dataResetButton: 'Restore initial state',
    dataResetConfirm: 'Click again to confirm',
    dataResetting: 'Clearing...',
	    dataResetDone: 'Restored. You can start over.',
	    dataResetFailed: 'Clear failed. Try again.',
	    attachFile: 'Attach',
	    attachments: 'Attachments',
	    removeAttachment: 'Remove',
	    newWindow: 'New Window',
    windowName: 'Name',
    windowWorkflow: 'Workflow',
    windowMode: 'Collaboration',
    singleAgent: 'Single agent',
    singleAgentDesc: 'Only the owner replies',
    defaultTeam: 'Default team',
    defaultTeamDesc: 'Use workflow agents',
    customTeam: 'Custom',
    customTeamDesc: 'Choose roles',
    windowTeam: 'Roles',
    agentPrompts: 'Role prompts',
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
    runActive: 'Running',
    runIdle: 'Idle',
    backToBottom: '↓ Back to bottom',
    loadOlder: 'Scroll to top to load older messages...',
    noOlderMessages: 'No older messages',
    channelDesc: 'General channel for all members',
    noMessages: 'No messages yet. Type something and send it to the local AI.',
    taskBoardTitle: 'Tasks',
    taskFilterAll: 'All',
    taskFilterActive: 'Active',
    taskFilterDone: 'Done',
    taskEmpty: 'No tasks yet',
    taskOpenChat: 'View chat',
    taskChatTitle: 'Task chat history',
    taskChatEmpty: 'No chat history for this task',
    taskChatNoConversation: 'This task is not linked to a chat window',
    taskChatClose: 'Close',
    taskAssigneeFallback: 'Unassigned',
    noDescription: 'No description',
    fileEmpty: 'No files yet',
    decisions: 'Decisions',
    decisionEmpty: 'No decisions waiting for a human',
    decisionPending: 'Pending',
    decisionApproved: 'Approved',
    decisionDenied: 'Denied',
    decisionApprove: 'Approve',
    decisionDeny: 'Deny',
    decisionSourceHost: 'Computer',
    taskStatusPending: 'Pending',
    taskStatusAssigned: 'Assigned',
    taskStatusInProgress: 'In progress',
    taskStatusReview: 'In review',
    taskStatusDone: 'Done',
    taskStatusFailed: 'Failed',
    taskStatusBlocked: 'Blocked',
    taskEventAssigned: 'Assigned',
    taskEventReview: 'Review',
    taskEventCompleted: 'Completed',
    taskEventChanges: 'Changes',
    vocabAudio: 'Play word audio',
    vocabAudioLoading: 'Loading word audio',
    vocabAudioStop: 'Stop word audio',
    vocabAudioFailed: 'Word audio failed',
    vocabMeaning: 'Meaning',
    vocabPos: 'Part of speech',
    vocabPhonetic: 'Phonetic',
    vocabSyllables: 'Syllables',
    vocabRoots: 'Roots & affixes',
    vocabNoDetails: 'Meaning pending',
    agentStatusRunning: 'Running',
    agentStatusThinking: 'Thinking',
    agentStatusUnread: 'Unread',
    agentStatusTasks: 'Tasks',
    agentStatusCards: 'Cards',
    agentStatusIdle: 'Idle',
    agentStatusAvailable: 'Available',
    artifactsLabel: 'Artifacts',
    revisionLabel: 'Revision',
    mainModelPlaceholder: 'e.g. opus / gpt-5, blank means default',
    fastModelPlaceholder: 'Blank means default fast model',
    windowPlaceholder: 'e.g. Release plan / Client A',
    workflowSoftwareDev: 'Software Development',
    workflowIeltsStudy: 'IELTS Study',
    meetKing: 'Meet King AI',
    addComputerTitle: 'Add a Computer',
    addComputerLead: 'Your agents need somewhere to run. Connect a computer and they will come online there.',
    addComputerRuntime: 'Need an agent runtime installed: Claude Code or Codex CLI.',
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
const baseRequest = request;
request = async function(path, options) {
  const next = options ? { ...options } : {};
  const headers = new Headers(next.headers || {});
  if (assistToken) headers.set('X-King-AI-Assist-Token', assistToken);
  if (assistTenant) headers.set('X-King-AI-Tenant', assistTenant);
  next.headers = headers;
  return baseRequest(path, next);
};
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
  if (document.getElementById('newWindowDialog').open) syncNewWindowMode();
  if (document.getElementById('computerDialog').open) renderComputerFlow();
}
function setLanguage(lang) {
  currentLang = lang === 'en' ? 'en' : 'zh';
  localStorage.setItem(LANG_KEY, currentLang);
  applyLanguage();
  refresh();
}
const mobileQuery = window.matchMedia('(max-width: 820px)');
function syncMobileLayout() {
  document.body.classList.toggle('mobile-layout', mobileQuery.matches);
}
syncMobileLayout();
if (mobileQuery.addEventListener) {
  mobileQuery.addEventListener('change', syncMobileLayout);
} else if (mobileQuery.addListener) {
  mobileQuery.addListener(syncMobileLayout);
}
const workspaceEl = document.querySelector('.workspace');
if (workspaceEl) workspaceEl.addEventListener('scroll', updateBackToBottom);
function shouldRenderChatMessage(message) {
  if (message.author_kind === 'system' && message.payload && message.payload.taskEventType) return false;
  if (message.status === 'pending') return false; // "agent thinking" placeholder bubbles are not shown
  return true;
}
function workspaceScroller() {
  return document.querySelector('.workspace');
}
scrollToBottom = function() {
  const workspace = workspaceScroller();
  if (!workspace) return;
  workspace.scrollTop = workspace.scrollHeight;
  shouldStickToBottom = true;
  updateBackToBottom();
};
function updateBackToBottom() {
  const workspace = workspaceScroller();
  const jumpButton = document.querySelector('.composer-tools .jump');
  if (!workspace || !jumpButton || !document.getElementById('panel-chat').classList.contains('active')) {
    if (jumpButton) jumpButton.classList.remove('visible');
    return;
  }
  const distanceFromBottom = workspace.scrollHeight - workspace.clientHeight - workspace.scrollTop;
  shouldStickToBottom = distanceFromBottom < 80;
  jumpButton.classList.toggle('visible', !shouldStickToBottom);
}
	function copyText(value, button) {
	  if (!value) return;
	  navigator.clipboard.writeText(value).catch(function() {});
	  if (!button) return;
	  const old = button.textContent;
	  button.textContent = t('copied');
	  setTimeout(function() { button.textContent = old || t('copy'); }, 900);
	}
	function refreshSoon() {
	  setTimeout(function() { refresh().catch(function() {}); }, 0);
	}
	function revokeOptimisticAttachmentUrls(rows) {
	  (rows || []).forEach(function(attachment) {
	    if (attachment && attachment.__objectUrl) URL.revokeObjectURL(attachment.__objectUrl);
	  });
	}
	function addOptimisticMessages(optimisticBody, optimisticAttachments) {
	  // Only the human message is shown optimistically; we no longer render an agent "thinking" placeholder.
	  const now = Date.now();
	  const convRows = ((window.__lastState && window.__lastState.messages) || []).filter(function(m) {
	    return m.conversation_id === activeConversationId;
	  });
	  const baselineHuman = convRows.filter(function(m) { return m.author_kind === 'human' && m.body === optimisticBody; }).length;
	  optimisticMessages.push({
	    id: 'optimistic-' + now,
	    __optimistic: true,
	    __batch: now,
	    __baseline: baselineHuman,
	    conversation_id: activeConversationId,
	    author_kind: 'human',
	    body: optimisticBody,
	    attachments: optimisticAttachments && optimisticAttachments.length ? optimisticAttachments : undefined,
	    created_at: now,
	    readBy: []
	  });
	  return now;
	}
	function reconcileOptimistic(serverRows) {
	  if (!optimisticMessages.length) return;
	  const now = Date.now();
	  // A batch is confirmed once the server reflects its human message (count for that exact body grew
	  // past the baseline captured at send time). The server creates the human message and its pending
	  // placeholder atomically, so confirming the human lets us drop the whole batch — placeholder included.
	  const serverIds = {};
	  serverRows.forEach(function(m) { if (m && m.id) serverIds[m.id] = true; });
	  const confirmed = {};
	  optimisticMessages.forEach(function(opt) {
	    if (opt.conversation_id !== activeConversationId) return;
	    // Bulletproof: the POST response gave us the server's id for this send; drop the batch once it lands.
	    if (opt.__serverId && serverIds[opt.__serverId]) confirmed[opt.__batch] = true;
	    if (opt.author_kind !== 'human') return;
	    const count = serverRows.filter(function(m) { return m.author_kind === 'human' && m.body === opt.body; }).length;
	    if (count > opt.__baseline) confirmed[opt.__batch] = true;
	  });
	  optimisticMessages = optimisticMessages.filter(function(opt) {
	    if (now - (opt.created_at || 0) > 60000) {
	      revokeOptimisticAttachmentUrls(opt.attachments);
	      return false; // safety TTL so nothing lingers forever
	    }
	    if (opt.conversation_id !== activeConversationId) return true; // not in view; TTL bounds the leak
	    if (confirmed[opt.__batch]) {
	      revokeOptimisticAttachmentUrls(opt.attachments);
	      return false;
	    }
	    return true;
	  });
	}
	function mergeOptimistic(serverRows) {
	  const sorted = sortMessagesChronologically(serverRows);
	  if (!optimisticMessages.length) return sorted;
	  const visible = optimisticMessages.filter(function(opt) { return opt.conversation_id === activeConversationId; });
	  if (!visible.length) return sorted;
	  return sortMessagesChronologically(sorted.concat(visible));
	}
	let pendingAttachments = [];
	function formatBytes(value) {
	  const bytes = Number(value || 0);
	  if (bytes < 1024) return bytes + 'B';
	  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + 'KB';
	  return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + 'MB';
	}
function renderAttachmentTray() {
  const tray = document.getElementById('attachmentTray');
  if (!tray) return;
  tray.innerHTML = pendingAttachments.map(function(file, index) {
    return '<span class="attachment-token" title="' + escapeHtml(file.name) + '"><span>[' + escapeHtml(file.name) + ']</span><span class="attachment-size">' + escapeHtml(formatBytes(file.size)) + '</span></span><button class="attachment-remove" type="button" onclick="removePendingAttachment(' + index + ')" aria-label="' + escapeHtml(t('removeAttachment')) + '">×</button>';
  }).join('');
}
	function openAttachmentPicker() {
	  const input = document.getElementById('attachmentInput');
	  if (input) input.click();
	}
	function handleAttachmentFiles(input) {
	  const files = Array.from(input.files || []);
	  pendingAttachments = pendingAttachments.concat(files).slice(0, 10);
	  input.value = '';
	  renderAttachmentTray();
	}
	function removePendingAttachment(index) {
	  pendingAttachments.splice(index, 1);
	  renderAttachmentTray();
	}
	function fileToBase64(file) {
	  return new Promise(function(resolve, reject) {
	    const reader = new FileReader();
	    reader.onload = function() {
	      const value = String(reader.result || '');
	      resolve(value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);
	    };
	    reader.onerror = function() { reject(reader.error || new Error('failed to read file')); };
	    reader.readAsDataURL(file);
	  });
	}
	async function uploadAttachmentFiles(files) {
	  const uploaded = [];
	  for (const file of files) {
	    const bytesBase64 = await fileToBase64(file);
	    const result = await request('/gui/attachments', {
	      method: 'POST',
	      headers: { 'Content-Type': 'application/json' },
	      body: JSON.stringify({
	        name: file.name || 'attachment',
	        mime: file.type || 'application/octet-stream',
	        size: file.size || 0,
	        bytesBase64
	      })
	    });
	    if (result.attachment) uploaded.push({
	      id: result.attachment.id,
	      name: result.attachment.name,
	      mime: result.attachment.mime,
	      size: result.attachment.size,
	      url: result.attachment.url,
	      source: result.attachment.source || 'gui-upload',
	      required: true
	    });
	  }
	  return uploaded;
	}
function attachmentListHtml(attachments) {
	  const rows = Array.isArray(attachments) ? attachments : [];
  if (!rows.length) return '';
  return '<div class="message-attachments" aria-label="' + escapeHtml(t('attachments')) + '">' + rows.map(function(attachment) {
    const name = attachment.name || 'attachment';
    const href = attachment.url ? ' href="' + escapeHtml(attachment.url) + '" target="_blank" rel="noreferrer noopener"' : '';
    return '<a class="attachment-token"' + href + ' title="' + escapeHtml(name) + '"><span>[' + escapeHtml(name) + ']</span><span class="attachment-size">' + escapeHtml(formatBytes(attachment.size)) + '</span></a>';
  }).join('') + '</div>';
}
window.__messageAudioText = window.__messageAudioText || {};
const ttsAudioCache = new Map();
let activeTts = null;
let loadingTtsId = '';
let ttsNoticeTimer = 0;
let ttsPlayRequestId = 0;
const messageTtsLabels = {
  idle: 'Play audio',
  loading: 'Loading audio',
  playing: 'Stop audio',
  error: 'TTS failed'
};
function isIeltsTutorMessage(message) {
  if (!message || message.author_kind !== 'agent') return false;
  if (message.author_agent_id === 'ielts-tutor') return true;
  return !message.author_agent_id && message.author_name === 'IELTS Reading & Writing Coach';
}
function ttsTextFromIeltsMessage(message) {
  const codeFencePattern = new RegExp(String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96) + '[\\\\s\\\\S]*?' + String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96), 'g');
  const source = String(message && message.body || '').replace(/WordCards:\\s*\\{[\\s\\S]*$/i, '').replace(codeFencePattern, ' ');
  const lines = source.split(/\\n+/).map(function(line) { return line.trim(); }).filter(Boolean);
  const englishLines = [];
  for (const line of lines) {
    const withoutTip = line.replace(/^Tip:\\s*/i, '').replace(/Useful phrases:[\\s\\S]*$/i, '');
    const asciiLetters = (withoutTip.match(/[A-Za-z]/g) || []).length;
    const cjkChars = (withoutTip.match(/[\\u3400-\\u9fff]/g) || []).length;
    if (asciiLetters >= 3 && asciiLetters >= cjkChars * 2) englishLines.push(withoutTip);
  }
  return englishLines.join(' ').replace(/\\s+/g, ' ').trim().slice(0, 1200);
}
function ttsIconHtml(kind) {
  if (kind === 'stop') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h8v8H8z"/></svg>';
  if (kind === 'loading') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9h-3a6 6 0 1 1-6-6z"/></svg>';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9v6h4l5 4V5L9 9H5zm12.5 3a4.5 4.5 0 0 0-2-3.74v7.48a4.5 4.5 0 0 0 2-3.74z"/></svg>';
}
function setTtsButtonState(ttsId, state, label) {
  const button = document.querySelector('[data-tts-id="' + CSS.escape(ttsId) + '"]');
  if (!button) return;
  button.dataset.ttsState = state;
  button.disabled = state === 'loading';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = ttsIconHtml(state === 'playing' ? 'stop' : state);
}
function ttsIdleLabel(ttsId) {
  return String(ttsId || '').startsWith('vocab:') ? t('vocabAudio') : messageTtsLabels.idle;
}
function showTtsNotice(message) {
  let notice = document.getElementById('ttsNotice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'ttsNotice';
    notice.className = 'tts-notice';
    notice.setAttribute('role', 'status');
    document.body.appendChild(notice);
  }
  notice.textContent = message;
  notice.classList.add('show');
  if (ttsNoticeTimer) clearTimeout(ttsNoticeTimer);
  ttsNoticeTimer = setTimeout(function() { notice.classList.remove('show'); }, 3600);
}
function ttsErrorMessage(error) {
  const raw = error && error.message ? String(error.message) : String(error || '');
  if (/402|Insufficient balance|BYOK/i.test(raw)) return 'TTS needs Cloudflare AI balance or BYOK.';
  if (/401|403|Authentication|Unauthorized|Forbidden/i.test(raw)) return 'TTS authentication failed. Check the Cloudflare AI token.';
  if (/workers_ai_not_configured|not_configured/i.test(raw)) return 'TTS is not configured on this Worker.';
  return 'TTS playback failed. Try again.';
}
function stopActiveTts() {
  if (!activeTts) return;
  activeTts.audio.pause();
  activeTts.audio.currentTime = 0;
  activeTts.cleanup();
}
function cancelTts(ttsId) {
  if (!ttsId) return;
  if (activeTts && activeTts.ttsId === ttsId) stopActiveTts();
  if (loadingTtsId === ttsId) {
    ttsPlayRequestId += 1;
    loadingTtsId = '';
    setTtsButtonState(ttsId, 'idle', ttsIdleLabel(ttsId));
  }
}
function cacheTtsAudio(cacheKey, url) {
  if (ttsAudioCache.size >= 20) {
    const oldestKey = ttsAudioCache.keys().next().value;
    const oldestUrl = ttsAudioCache.get(oldestKey);
    if (oldestUrl) URL.revokeObjectURL(oldestUrl);
    ttsAudioCache.delete(oldestKey);
  }
  ttsAudioCache.set(cacheKey, url);
}
async function playTts(ttsId, text, labels) {
  if (!text) return;
  if (activeTts && activeTts.ttsId === ttsId) {
    ttsPlayRequestId += 1;
    stopActiveTts();
    return;
  }
  const requestId = ++ttsPlayRequestId;
  stopActiveTts();
  if (loadingTtsId && loadingTtsId !== ttsId) setTtsButtonState(loadingTtsId, 'idle', ttsIdleLabel(loadingTtsId));
  loadingTtsId = ttsId;
  setTtsButtonState(ttsId, 'loading', labels.loading);
  try {
    const cacheKey = ttsId + ':' + text;
    let url = ttsAudioCache.get(cacheKey);
    if (!url) {
      const response = await fetch('/gui/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, language: 'en' })
      });
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      url = URL.createObjectURL(blob);
      cacheTtsAudio(cacheKey, url);
    }
    if (requestId !== ttsPlayRequestId) {
      if (loadingTtsId === ttsId) {
        loadingTtsId = '';
        setTtsButtonState(ttsId, 'idle', labels.idle);
      }
      return;
    }
    const audio = new Audio(url);
    const cleanup = function() {
      audio.onended = null;
      audio.onerror = null;
      if (activeTts && activeTts.audio === audio) activeTts = null;
      setTtsButtonState(ttsId, 'idle', labels.idle);
    };
    activeTts = { ttsId: ttsId, audio: audio, cleanup: cleanup };
    if (loadingTtsId === ttsId) loadingTtsId = '';
    audio.onended = cleanup;
    audio.onerror = function() {
      cleanup();
      showTtsNotice('TTS audio could not be played.');
    };
    setTtsButtonState(ttsId, 'playing', labels.playing);
    await audio.play();
  } catch (error) {
    console.warn('TTS playback failed', error);
    if (loadingTtsId === ttsId) loadingTtsId = '';
    if (activeTts && activeTts.ttsId === ttsId) {
      activeTts.audio.pause();
      activeTts.cleanup();
    }
    showTtsNotice(ttsErrorMessage(error));
    setTtsButtonState(ttsId, 'error', labels.error);
    setTimeout(function() { setTtsButtonState(ttsId, 'idle', labels.idle); }, 1800);
  } finally {
  }
}
async function playMessageTts(messageId) {
  const text = window.__messageAudioText && window.__messageAudioText[messageId];
  await playTts(messageId, text, messageTtsLabels);
}
function ttsButtonState(ttsId) {
  if (activeTts && activeTts.ttsId === ttsId) return 'playing';
  if (loadingTtsId === ttsId) return 'loading';
  return 'idle';
}
function ttsButtonHtml(message) {
  if (!message || message.status === 'pending' || !message.body || !message.id || !isIeltsTutorMessage(message)) return '';
  const text = ttsTextFromIeltsMessage(message);
  if (!text) return '';
  window.__messageAudioText[message.id] = text;
  const state = ttsButtonState(message.id);
  const label = state === 'playing' ? messageTtsLabels.playing : state === 'loading' ? messageTtsLabels.loading : messageTtsLabels.idle;
  const iconKind = state === 'playing' ? 'stop' : state === 'loading' ? 'loading' : 'play';
  const disabledAttr = state === 'loading' ? ' disabled' : '';
  return '<button class="icon-btn tts-button" data-tts-id="' + escapeHtml(message.id) + '" data-tts-state="' + state + '"' + disabledAttr + ' onclick="playMessageTts(&quot;' + escapeHtml(message.id) + '&quot;)" title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">' + ttsIconHtml(iconKind) + '</button>';
}
	const REMOTE_ASSIST_URL_KEY = 'king-ai:remoteAssistUrl';
let remoteAssistUrl = localStorage.getItem(REMOTE_ASSIST_URL_KEY) || '';
function setRemoteAssistUrl(value) {
  remoteAssistUrl = value || '';
  if (remoteAssistUrl) localStorage.setItem(REMOTE_ASSIST_URL_KEY, remoteAssistUrl);
  else localStorage.removeItem(REMOTE_ASSIST_URL_KEY);
}
function remoteAssistUrlMatchesGrant(value, grant) {
  if (!value || !grant || !grant.tokenPreview) return false;
  try {
    const token = new URL(value, location.origin).searchParams.get('assist') || '';
    return token && grant.tokenPreview === token.slice(0, 8) + '...' + token.slice(-4);
  } catch (error) {
    return false;
  }
}
function copyRemoteAssistLink(button) {
  if (!remoteAssistUrl) {
    const statusEl = document.getElementById('assistStatus');
    if (statusEl) statusEl.textContent = t('assistCopyUnavailable');
    return;
  }
  copyText(remoteAssistUrl, button);
}
async function createRemoteAssistLink() {
  const button = document.getElementById('createAssistButton');
  if (button) {
    button.disabled = true;
    button.textContent = t('saving');
  }
  try {
    const result = await request('/gui/remote-assist/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    setRemoteAssistUrl(result.url || '');
    await navigator.clipboard.writeText(remoteAssistUrl).catch(function() {});
    await refresh();
    renderRemoteAssist(window.__lastSummary || {});
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = t('createAssistLink');
    }
  }
}
async function revokeRemoteAssistLink() {
  await request('/gui/remote-assist/revoke', { method: 'POST' });
  setRemoteAssistUrl('');
  await refresh();
  renderRemoteAssist(window.__lastSummary || {});
}
function renderRemoteAssist(summary) {
  const linkEl = document.getElementById('assistLink');
  const statusEl = document.getElementById('assistStatus');
  const revokeButton = document.getElementById('revokeAssistButton');
  const copyButton = document.getElementById('copyAssistButton');
  if (!linkEl || !statusEl || !revokeButton || !copyButton) return;
  const grant = summary.remoteAssist || { active: false };
  if (!grant.active) setRemoteAssistUrl('');
  else if (remoteAssistUrl && !remoteAssistUrlMatchesGrant(remoteAssistUrl, grant)) setRemoteAssistUrl('');
  linkEl.textContent = remoteAssistUrl || (grant.active ? '•••• ' + grant.tokenPreview : t('assistNoLink'));
  statusEl.textContent = grant.active ? t('assistActive') : '';
  revokeButton.disabled = !grant.active;
  copyButton.disabled = !remoteAssistUrl;
}
let resetAccountConfirming = false;
let resetAccountTimer = 0;
function resetResetAccountButton() {
  resetAccountConfirming = false;
  const button = document.getElementById('resetAccountButton');
  if (button && !button.disabled) button.textContent = t('dataResetButton');
}
async function resetCurrentAccountData() {
  const button = document.getElementById('resetAccountButton');
  const status = document.getElementById('resetAccountStatus');
  if (!button) return;
  if (!resetAccountConfirming) {
    resetAccountConfirming = true;
    button.textContent = t('dataResetConfirm');
    if (status) status.textContent = '';
    if (resetAccountTimer) clearTimeout(resetAccountTimer);
    resetAccountTimer = window.setTimeout(resetResetAccountButton, 5000);
    return;
  }
  if (resetAccountTimer) {
    clearTimeout(resetAccountTimer);
    resetAccountTimer = 0;
  }
  button.disabled = true;
  button.textContent = t('dataResetting');
  if (status) status.textContent = t('dataResetting');
  try {
    await request('/gui/reset-state', { method: 'POST' });
    activeConversationId = 'king-ai-convo';
    localStorage.setItem('king-ai:activeConversationId', activeConversationId);
    localStorage.removeItem('king-ai:taskFilter');
    localStorage.removeItem('king-ai:addComputerDismissed');
    setRemoteAssistUrl('');
    resetAccountConfirming = false;
    visibleMessageCount = 20;
    lastMessageTotal = 0;
    shouldStickToBottom = true;
    await refresh();
    if (status) status.textContent = t('dataResetDone');
  } catch (error) {
    if (status) status.textContent = t('dataResetFailed');
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = t('dataResetButton');
  }
}
const REMOTE_CONFIG_EXAMPLE = {
  _help: {
    note: "_help 只用于 GUI 说明，保存时会自动删除，不会写入真实配置。",
    required: [
      "devices: 测试机数组，必填，可一次配置 N 台。",
      "devices[].id: 设备唯一 id，必填，例如 test-61。",
      "devices[].host: SSH 主机 IP 或域名，必填。",
      "devices[].user: SSH 用户，必填，例如 root。",
      "devices[].databases.<db>.command: 配置某个数据库别名时必填。",
      "devices[].redis.<name>.command: 配置某个 Redis 别名时必填。"
    ],
    optional: [
      "defaultDevice: 默认设备 id；填写时必须匹配 devices[].id。",
      "devices[].name: 展示名称，可写 IP、环境名或业务名。",
      "devices[].port: SSH 端口，默认 22。",
      "devices[].password: 测试机明文密码。",
      "devices[].passwordEnv: 从本机环境变量读取 SSH 密码；优先级高于 password。",
      "devices[].identityFile: SSH 私钥文件路径；可与 password/passwordEnv 任选，或留空走 ssh-agent。",
      "devices[].defaultApp: 默认应用名；remote-logs 未传 app 时会使用它。",
      "devices[].apps: 应用配置对象；key 是应用名，例如 fc。",
      "devices[].databases: 数据库配置对象；key 是数据库别名，例如 fc。",
      "devices[].redis: Redis 配置对象；key 是 Redis 别名，例如 default。"
    ],
    fields: {
      defaultDevice: "string，可选；默认设备 id。",
      devices: "RemoteDevice[]，必填；测试机列表。",
      "devices[].id": "string，必填；设备唯一 id。",
      "devices[].name": "string，可选；展示名称。",
      "devices[].host": "string，必填；SSH 主机。",
      "devices[].port": "number，可选；1-65535，默认 22。",
      "devices[].user": "string，必填；SSH 用户。",
      "devices[].password": "string，可选；明文 SSH 密码。",
      "devices[].passwordEnv": "string，可选；本机环境变量名，存在时优先读取该变量作为密码。",
      "devices[].identityFile": "string，可选；SSH 私钥路径。",
      "devices[].defaultApp": "string，可选；默认应用名。",
      "devices[].apps": "object，可选；应用名到 RemoteAppConfig 的映射。",
      "devices[].apps.<app>.logRoots": "string[]，可选；日志根目录，remote-logs/remote-find-logs 使用。",
      "devices[].apps.<app>.installMarkers": "string[]，可选；安装标记文件，remote-profile 使用。",
      "devices[].apps.<app>.errorPatterns": "string[]，可选；常用错误模式，目前作为配置记录。",
      "devices[].databases": "object，可选；数据库别名到 RemoteServiceCommand 的映射。",
      "devices[].databases.<db>.type": "string，可选；数据库类型说明，例如 postgres。",
      "devices[].databases.<db>.command": "string，必填；配置该 db 时必须有基础命令，remote-pg 会追加 -c <sql>。",
      "devices[].redis": "object，可选；Redis 别名到 RemoteServiceCommand 的映射。",
      "devices[].redis.<name>.type": "string，可选；Redis 类型说明。",
      "devices[].redis.<name>.command": "string，必填；配置该 Redis 时必须有基础命令，remote-redis 会追加 <cmd>。"
    }
  },
  defaultDevice: "test-61",
  devices: [
    {
      id: "test-61",
      name: "10.12.9.61",
      host: "10.12.9.61",
      port: 22,
      user: "root",
      password: "plain-test-password",
      defaultApp: "fc",
      apps: {
        fc: {
          logRoots: ["/gpfc/logs"],
          installMarkers: ["/etc/gpfc/install_app_dir"],
          errorPatterns: ["ERROR", "Exception"]
        }
      },
      databases: {
        fc: {
          type: "postgres",
          command: "psql -h 127.0.0.1 -U postgres -d gpfc"
        }
      },
      redis: {
        default: {
          command: "redis-cli -h 127.0.0.1 -p 6379"
        }
      }
    }
  ]
};
function formatRemoteConfig(value) {
  return JSON.stringify(value, null, 2);
}
function stripRemoteConfigHelp(value) {
  if (Array.isArray(value)) return value.map(stripRemoteConfigHelp);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value)) {
    if (key === '_help') continue;
    result[key] = stripRemoteConfigHelp(value[key]);
  }
  return result;
}
function showRemoteOutput(text) {
  const out = document.getElementById('remoteDeviceOutput');
  if (!out) return;
  out.textContent = text || '';
  out.hidden = !text;
}
const localHostBridgeBase = 'http://127.0.0.1:8799';
function localHostBridgePath(path) {
  const mapped = ({
    '/remote-config': '/remote/config',
    '/remote-devices': '/remote/devices'
  })[path];
  if (mapped) return mapped;
  const prefix = '/remote-devices/';
  return path.startsWith(prefix) ? '/remote/devices/' + path.slice(prefix.length) : path;
}
async function hostBridgeRequest(path, options) {
  try {
    return await request('/gui' + path, options);
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error);
    if (!/host bridge not configured|404/.test(message)) throw error;
    const res = await fetch(localHostBridgeBase + localHostBridgePath(path), options);
    if (!res.ok) throw new Error(await res.text());
    const contentType = res.headers.get('Content-Type') || '';
    const result = contentType.includes('application/json') ? await res.json() : await res.text();
    return { configured: true, result: result && result.ok !== undefined ? result : { ok: true, json: result } };
  }
}
async function loadRemoteConfig() {
  const listEl = document.getElementById('remoteDeviceList');
  const statusEl = document.getElementById('remoteDeviceStatus');
  const configEl = document.getElementById('remoteConfigJson');
  if (!listEl || !statusEl) return;
  showRemoteOutput('');
  try {
    const response = await hostBridgeRequest('/remote-config');
    const result = response.result || {};
    const config = (result.json && result.json.config) || { devices: [] };
    if (configEl) configEl.value = formatRemoteConfig(config.devices && config.devices.length ? config : REMOTE_CONFIG_EXAMPLE);
    renderRemoteDeviceList((result.json && result.json.devices) || config.devices || [], config.defaultDevice || result.json?.defaultDevice);
    statusEl.textContent = result.error || response.error || '';
  } catch (error) {
    if (configEl && !configEl.value.trim()) configEl.value = formatRemoteConfig(REMOTE_CONFIG_EXAMPLE);
    listEl.innerHTML = '<div class="muted">' + escapeHtml(t('hostBridgeMissing')) + '</div>';
    statusEl.textContent = error && error.message ? error.message : String(error);
  }
}
async function loadRemoteDevices() {
  const listEl = document.getElementById('remoteDeviceList');
  const statusEl = document.getElementById('remoteDeviceStatus');
  if (!listEl || !statusEl) return;
  showRemoteOutput('');
  try {
    const response = await hostBridgeRequest('/remote-devices');
    const result = response.result || {};
    renderRemoteDeviceList((result.json && result.json.devices) || [], result.json && result.json.defaultDevice);
    statusEl.textContent = result.error || response.error || '';
  } catch (error) {
    listEl.innerHTML = '<div class="muted">' + escapeHtml(t('hostBridgeMissing')) + '</div>';
    statusEl.textContent = error && error.message ? error.message : String(error);
  }
}
function renderRemoteDeviceList(devices, defaultDevice) {
  const listEl = document.getElementById('remoteDeviceList');
  if (!listEl) return;
  if (!devices.length) {
    listEl.innerHTML = '<div class="muted">' + escapeHtml(t('noRemoteDevices')) + '</div>';
    return;
  }
  listEl.innerHTML = devices.map(function(device) {
    const title = (device.id || '') + (device.id === defaultDevice ? ' *' : '');
    const meta = (device.user || '') + '@' + (device.host || '') + ':' + (device.port || 22) + ' ' + (device.auth || '');
    return '<article class="remote-device-item">' +
      '<div class="remote-device-main"><div class="remote-device-title">' + escapeHtml(title) + '</div><div class="remote-device-meta">' + escapeHtml(meta) + '</div></div>' +
      '<button onclick="probeRemoteDevice(' + escapeHtml(JSON.stringify(device.id || '')) + ')">' + escapeHtml(t('probeDevice')) + '</button>' +
      '<button onclick="profileRemoteDevice(' + escapeHtml(JSON.stringify(device.id || '')) + ')">' + escapeHtml(t('profileDevice')) + '</button>' +
      '</article>';
  }).join('');
}
async function saveRemoteConfig() {
  const statusEl = document.getElementById('remoteDeviceStatus');
  const configEl = document.getElementById('remoteConfigJson');
  showRemoteOutput('');
  try {
    const body = stripRemoteConfigHelp(JSON.parse(configEl?.value || '{"devices":[]}'));
    const response = await hostBridgeRequest('/remote-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (statusEl) statusEl.textContent = response.result?.text || response.error || t('saved');
    await loadRemoteConfig();
  } catch (error) {
    if (statusEl) statusEl.textContent = error && error.message ? error.message : String(error);
  }
}
async function copyRemoteConfig() {
  const statusEl = document.getElementById('remoteDeviceStatus');
  const configEl = document.getElementById('remoteConfigJson');
  try {
    const text = configEl?.value || '';
    await navigator.clipboard.writeText(text);
    if (statusEl) statusEl.textContent = t('copied');
  } catch (error) {
    if (statusEl) statusEl.textContent = error && error.message ? error.message : String(error);
  }
}
async function probeRemoteDevice(id) {
  showRemoteOutput(t('saving'));
  const response = await hostBridgeRequest('/remote-devices/' + encodeURIComponent(id) + '/probe', { method: 'POST' });
  showRemoteOutput(response.result?.text || response.error || '');
}
async function profileRemoteDevice(id) {
  showRemoteOutput(t('saving'));
  const response = await hostBridgeRequest('/remote-devices/' + encodeURIComponent(id) + '/profile', { method: 'POST' });
  showRemoteOutput(response.result?.text || response.error || '');
}
const previousOpenSettings = typeof openSettings === 'function' ? openSettings : null;
openSettings = function() {
  if (previousOpenSettings) previousOpenSettings();
  else document.getElementById('settingsDialog').showModal();
  loadRemoteConfig();
};
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
  // Drive "busy" off authoritative agent status (what the team strip shows), not the typing/thinking
  // logs alone — those can leave a stale not-done entry that keeps the status stuck after work finishes.
  const agents = typeof currentRoomAgents === 'function' ? currentRoomAgents(summary) : [];
  const working = agents.some(function(agent) { return agent.status === 'running' || agent.status === 'thinking'; });
  if (working) {
    const typing = (state.typingLog || []).slice().reverse().find(function(row) { return row.conversationId === active.id && !row.done; });
    return typing ? t('agentTyping') : t('agentThinking');
  }
  if ((active.unread || 0) > 0) return t('waitingAgent');
  return '';
};
function npxKingAiCommand(args) {
  return 'npx -y @suwujs/king-ai@latest ' + args;
}
const previousLoadPairCommand = typeof loadPairCommand === 'function' ? loadPairCommand : null;
loadPairCommand = async function() {
  const summary = await request('/gui/summary?conversationId=' + encodeURIComponent(activeConversationId));
  if (!summary.pairingCode) return;
  pairCommandPrimary = npxKingAiCommand('agent computer --pair ' + summary.pairingCode + ' --server ' + base + (summary.pairCommandTenantArg || ''));
  pairCommandStart = npxKingAiCommand('agent computer --server ' + base + (summary.pairCommandTenantArg || ''));
  pairCommand = pairCommandPrimary + '\\n' + pairCommandStart;
  lastConnection = summary.connection || lastConnection;
  if (document.getElementById('computerDialog').open && computerStep === 'connect') renderComputerFlow();
};
function agentDisplayName(summary, id) {
  const agents = summary.agents || [];
  const agent = agents.find(function(row) { return row.id === id; });
  return agent && (agent.name || agent.id) || id;
}
let taskFilterMode = localStorage.getItem('king-ai:taskFilter') || 'all';
function setTaskFilter(mode) {
  taskFilterMode = mode === 'done' || mode === 'active' ? mode : 'all';
  localStorage.setItem('king-ai:taskFilter', taskFilterMode);
  renderTasks(window.__lastState || { tasks: [], artifacts: [] });
  const workspace = document.querySelector('.workspace');
  if (workspace) workspace.scrollTop = 0;
}
function taskMatchesFilter(task) {
  if (taskFilterMode === 'done') return task.status === 'done';
  if (taskFilterMode === 'active') return task.status !== 'done';
  return true;
}
function taskStateClass(status) {
  if (status === 'done') return 'done';
  if (status === 'failed' || status === 'blocked') return 'failed';
  if (status === 'pending' || status === 'assigned') return 'pending';
  return 'active';
}
function taskStatusText(status) {
  return ({
    pending: t('taskStatusPending'),
    assigned: t('taskStatusAssigned'),
    in_progress: t('taskStatusInProgress'),
    review: t('taskStatusReview'),
    done: t('taskStatusDone'),
    failed: t('taskStatusFailed'),
    blocked: t('taskStatusBlocked')
  })[status] || taskStatusLabel(status);
}
function taskOwnerLabel(task) {
  const summary = window.__lastSummary || {};
  return task.assignee ? agentDisplayName(summary, task.assignee) : t('taskAssigneeFallback');
}
function isLowSignalTaskText(value, task) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (/^Handle the human request in .+?:/i.test(text)) return true;
  if (task.title && text === task.title) return true;
  return false;
}
function latestTaskEvent(task) {
  const state = window.__lastState || {};
  const events = (state.taskEvents || []).filter(function(event) { return event.taskId === task.id; });
  return events.length ? events[events.length - 1] : null;
}
function taskEventLabel(type) {
  return ({
    assigned: t('taskEventAssigned'),
    submitted_for_review: t('taskEventReview'),
    completed: t('taskEventCompleted'),
    changes_requested: t('taskEventChanges')
  })[type] || type || '';
}
function taskText(task) {
  const paths = (task.scope && task.scope.paths || []).join(', ');
  const latest = latestTaskEvent(task);
  if (latest && latest.summary && !isLowSignalTaskText(latest.summary, task)) return latest.summary;
  if (task.revisionReason) return t('revisionLabel') + ': ' + task.revisionReason;
  if (!isLowSignalTaskText(task.result, task)) return task.result;
  if (!isLowSignalTaskText(task.description, task)) return task.description;
  if (paths) return paths;
  return t('noDescription');
}
function taskMetaHtml(task) {
  const meta = [];
  const latest = latestTaskEvent(task);
  if (latest && latest.type) meta.push(taskEventLabel(latest.type));
  if (task.ownerRole) meta.push('ownerRole=' + task.ownerRole);
  if (task.reviewerRole) meta.push('reviewerRole=' + task.reviewerRole);
  const blockedBy = task.blockedBy || [];
  if (blockedBy.length) meta.push('blockedBy=' + blockedBy.join(','));
  if (task.subsystem) meta.push(task.subsystem);
  if (task.priority !== undefined) meta.push('P' + task.priority);
  const acceptance = task.acceptance || [];
  if (acceptance.length) meta.push(acceptance.length + ' acceptance');
  if (task.reviewResult) meta.push(task.reviewResult === 'approved' ? (currentLang === 'zh' ? '评审通过' : 'approved') : t('taskEventChanges'));
  const artifactIds = task.artifactIds || latest && latest.artifactIds || [];
  if (artifactIds.length) meta.push(artifactIds.length + ' ' + t('artifactsLabel'));
  const paths = task.scope && task.scope.paths || [];
  paths.slice(0, 1).forEach(function(path) { meta.push(path); });
  return meta.length ? '<div class="task-card-meta">' + meta.map(function(item) { return '<span>' + escapeHtml(item) + '</span>'; }).join('') + '</div>' : '';
}
function taskCardHtml(task) {
  const stateClass = taskStateClass(task.status);
  const taskId = String(task.id || '');
  return '<article class="task-card ' + stateClass + '">' +
    '<button type="button" class="task-card-action" onclick="openTaskChat(&quot;' + escapeHtml(taskId) + '&quot;)">' +
    '<div class="task-card-top"><span class="task-chip">' + escapeHtml(taskOwnerLabel(task)) + '</span><span class="task-state"><span class="task-state-dot ' + stateClass + '"></span>' + escapeHtml(taskStatusText(task.status)) + '</span></div>' +
    '<h3>' + escapeHtml(task.title || task.id || t('taskBoardTitle')) + '</h3>' +
    '<p>' + escapeHtml(taskText(task)) + '</p>' +
    taskMetaHtml(task) +
    '</button>' +
    '<div class="task-card-footer"><button type="button" class="task-chat-open" onclick="openTaskChat(&quot;' + escapeHtml(taskId) + '&quot;)">' + t('taskOpenChat') + '</button></div>' +
    '</article>';
}
function taskConversationTitle(conversationId) {
  const summary = window.__lastSummary || {};
  const conversations = summary.conversations || [];
  const conversation = conversations.find(function(row) { return row.id === conversationId; });
  return conversation ? displayConversationTitle(conversation) : conversationId;
}
function taskChatRows(task) {
  if (!task || !task.conversationId) return [];
  const state = window.__lastState || {};
  const allRows = state.messages || [];
  const request = task.requestMessageId ? allRows.find(function(message) { return message.id === task.requestMessageId; }) : null;
  const nextRequestAt = request ? (allRows.find(function(message) {
    return message.conversation_id === task.conversationId &&
      message.author_kind === 'human' &&
      message.kind !== 'system' &&
      message.created_at > request.created_at;
  }) || {}).created_at : 0;
  return (state.messages || []).filter(function(message) {
    if (message.conversation_id !== task.conversationId) return false;
    if (request && message.created_at < request.created_at) return false;
    if (request && nextRequestAt && message.created_at >= nextRequestAt) return false;
    return shouldRenderChatMessage(message);
  });
}
function taskChatAuthorName(message) {
  if (message.author_kind === 'agent') return message.author_name || 'AI';
  if (message.author_kind === 'human') {
    const user = (window.__lastSummary || {}).currentUser || {};
    return message.author_name || user.name || user.email || user.id || 'you';
  }
  return message.author_name || message.author_kind || 'system';
}
function taskChatInitial(message, author) {
  const clean = String(author || '').trim();
  const match = clean.match(/[A-Za-z0-9]/);
  const fallback = message.author_kind === 'agent' ? 'A' : 'U';
  return (match ? match[0] : clean.slice(0, 1) || fallback).toUpperCase();
}
function taskChatMessageHtml(message) {
  if (message.author_kind === 'system') {
    return '<div class="system-line">' + escapeHtml(message.body) + '</div>';
  }
  const author = taskChatAuthorName(message);
  const engine = message.author_kind === 'agent' && message.author_engine ? '<span class="engine-chip">' + escapeHtml(message.author_engine) + '</span>' : '';
  const initial = taskChatInitial(message, author);
  const renderedBody = message.body_html || '';
  const bodyClass = renderedBody ? 'post-body markdown-body' : 'post-body plain';
  const bodyHtml = renderedBody || escapeHtml(message.body);
	  return '<article class="post"><div class="avatar">' + escapeHtml(initial) + '</div><div><div class="post-top"><span class="author">' + escapeHtml(author) + engine + '</span><span class="time">' + formatTime(message.created_at) + '</span></div><div class="' + bodyClass + '">' + bodyHtml + '</div>' + attachmentListHtml(message.attachments) + '</div></article>';
}
function openTaskChat(taskId) {
  const state = window.__lastState || {};
  const task = visibleTasksForState(state).find(function(row) { return row.id === taskId; });
  if (!task) return;
  const dialog = document.getElementById('taskChatDialog');
  const title = document.getElementById('taskChatTitle');
  const subtitle = document.getElementById('taskChatSubtitle');
  const body = document.getElementById('taskChatBody');
  title.textContent = task.title || task.id || t('taskChatTitle');
  subtitle.textContent = task.conversationId ? '#' + taskConversationTitle(task.conversationId) + ' · ' + task.id : task.id || '';
  const rows = taskChatRows(task);
  const empty = task.conversationId ? t('taskChatEmpty') : t('taskChatNoConversation');
  body.innerHTML = rows.length
    ? '<div class="message-list">' + rows.map(taskChatMessageHtml).join('') + '</div>'
    : '<div class="task-empty">' + empty + '</div>';
  if (!dialog.open) dialog.showModal();
}
function closeTaskChat() {
  document.getElementById('taskChatDialog').close();
}
function openVocabDialog(node) {
  const dialog = document.getElementById('vocabDialog');
  if (!dialog || !node) return;
  const previousAudioButton = document.getElementById('vocabAudioButton');
  if (previousAudioButton) cancelTts(previousAudioButton.dataset.ttsId || '');
  const word = node.getAttribute('data-word') || node.textContent || '';
  const meaning = node.getAttribute('data-meaning') || '';
  const pos = node.getAttribute('data-pos') || '';
  const phonetic = node.getAttribute('data-phonetic') || '';
  const syllables = node.getAttribute('data-syllables') || '';
  const roots = node.getAttribute('data-roots') || '';
  const hasDetails = Boolean(meaning || pos || phonetic || syllables || roots);
  document.getElementById('vocabWord').textContent = word;
  const audioButton = document.getElementById('vocabAudioButton');
  if (audioButton) {
    const ttsId = 'vocab:' + word.toLowerCase();
    audioButton.dataset.ttsId = ttsId;
    audioButton.dataset.ttsText = word;
    audioButton.dataset.ttsState = 'idle';
    audioButton.disabled = !word;
    audioButton.title = t('vocabAudio');
    audioButton.setAttribute('aria-label', t('vocabAudio'));
    audioButton.innerHTML = ttsIconHtml('play');
  }
  document.getElementById('vocabMeaningLabel').textContent = t('vocabMeaning');
  document.getElementById('vocabMeaning').textContent = meaning || t('vocabNoDetails');
  document.getElementById('vocabPosLabel').textContent = t('vocabPos');
  document.getElementById('vocabPos').textContent = pos;
  document.getElementById('vocabPos').closest('.vocab-row').hidden = !hasDetails || !pos;
  document.getElementById('vocabPhoneticLabel').textContent = t('vocabPhonetic');
  document.getElementById('vocabPhonetic').textContent = phonetic;
  document.getElementById('vocabPhonetic').closest('.vocab-row').hidden = !hasDetails || !phonetic;
  document.getElementById('vocabSyllablesLabel').textContent = t('vocabSyllables');
  document.getElementById('vocabSyllables').textContent = syllables;
  document.getElementById('vocabSyllables').closest('.vocab-row').hidden = !hasDetails || !syllables;
  document.getElementById('vocabRootsLabel').textContent = t('vocabRoots');
  document.getElementById('vocabRoots').textContent = roots;
  document.getElementById('vocabRoots').closest('.vocab-row').hidden = !hasDetails || !roots;
  if (!dialog.open) dialog.showModal();
}
function playVocabTts() {
  const button = document.getElementById('vocabAudioButton');
  if (!button) return;
  playTts(button.dataset.ttsId || 'vocab', (button.dataset.ttsText || '').trim(), {
    idle: t('vocabAudio'),
    loading: t('vocabAudioLoading'),
    playing: t('vocabAudioStop'),
    error: t('vocabAudioFailed')
  });
}
function closeVocabDialog() {
  const dialog = document.getElementById('vocabDialog');
  const audioButton = document.getElementById('vocabAudioButton');
  if (audioButton) cancelTts(audioButton.dataset.ttsId || '');
  if (dialog && dialog.open) dialog.close();
}
document.addEventListener('click', function(event) {
  const target = event.target && event.target.closest ? event.target.closest('.ielts-word') : null;
  if (!target) return;
  event.preventDefault();
  openVocabDialog(target);
});
function taskFilterButton(mode, label) {
  return '<button class="' + (taskFilterMode === mode ? 'active' : '') + '" onclick="setTaskFilter(&quot;' + mode + '&quot;)">' + label + '</button>';
}
function taskBoardHtml(tasks) {
  const activeCount = tasks.filter(function(task) { return task.status !== 'done'; }).length;
  const filtered = tasks.slice().reverse().filter(taskMatchesFilter);
  return '<div class="task-board">' +
    '<div class="task-board-head">' +
    '<div class="task-count"><strong>' + escapeHtml(tasks.length) + '</strong><span>' + t('taskBoardTitle') + '</span><span>' + escapeHtml(activeCount) + ' ' + t('taskFilterActive') + '</span></div>' +
    '<div class="task-filter">' +
    taskFilterButton('all', t('taskFilterAll')) +
    taskFilterButton('active', t('taskFilterActive')) +
    taskFilterButton('done', t('taskFilterDone')) +
    '</div>' +
    '</div>' +
    (filtered.length ? '<div class="task-grid">' + filtered.map(taskCardHtml).join('') + '</div>' : '<div class="task-empty">' + t('taskEmpty') + '</div>') +
    '</div>';
}
function isAllConversationView() {
  return !activeConversationId || activeConversationId === 'king-ai-convo';
}
function taskMatchesConversation(task) {
  if (isAllConversationView()) return true;
  return task && task.conversationId === activeConversationId;
}
function messageMatchesConversation(message) {
  if (isAllConversationView()) return true;
  return message && message.conversation_id === activeConversationId;
}
function derivedRequestTasks(state, existingTasks) {
  const taskRequestIds = {};
  existingTasks.forEach(function(task) {
    if (task && task.requestMessageId) taskRequestIds[task.requestMessageId] = true;
  });
  return (state.messages || [])
    .filter(function(message) {
      return message.author_kind === 'human' && message.kind !== 'system' && messageMatchesConversation(message) && !taskRequestIds[message.id];
    })
    .map(function(message) {
      const nextRequestAt = ((state.messages || []).find(function(row) {
        return row.conversation_id === message.conversation_id &&
          row.author_kind === 'human' &&
          row.kind !== 'system' &&
          row.created_at > message.created_at;
      }) || {}).created_at;
      const hasAgentReply = (state.messages || []).some(function(row) {
        return row.conversation_id === message.conversation_id &&
          row.author_kind === 'agent' &&
          row.status !== 'pending' &&
          row.created_at > message.created_at &&
          (!nextRequestAt || row.created_at < nextRequestAt);
      });
      return {
        id: 'request-' + message.id,
        title: message.body || t('taskBoardTitle'),
        description: message.body || '',
        status: hasAgentReply ? 'done' : 'in_progress',
        assignee: message.to_agent_id || 'king-ai-ceo',
        ownerRole: 'request',
        priority: 5,
        conversationId: message.conversation_id,
        requestMessageId: message.id,
        derived: true,
        created_at: message.created_at,
        updated_at: message.created_at
      };
    });
}
function workflowCardViewStatus(status) {
  if (status === 'open') return 'pending';
  if (status === 'waiting_human') return 'review';
  if (status === 'cancelled') return 'failed';
  return status || 'pending';
}
function workflowCardMatchesConversation(card, state) {
  if (isAllConversationView()) return true;
  if (String(card.id || '').startsWith('card-')) return false;
  const task = (state.tasks || []).find(function(row) { return row.id === card.id; });
  if (task) return task.conversationId === activeConversationId;
  return false;
}
function taskViewFromWorkflowCard(card, state) {
  const explicit = (state.tasks || []).find(function(row) { return row.id === card.id; });
  return {
    id: card.id,
    title: card.title || card.id,
    description: explicit && explicit.description,
    status: workflowCardViewStatus(card.status),
    assignee: card.assignee,
    ownerRole: card.ownerRole || (explicit && explicit.ownerRole),
    priority: explicit && explicit.priority,
    conversationId: explicit && explicit.conversationId,
    requestMessageId: explicit && explicit.requestMessageId,
    result: card.result,
    created_at: explicit && explicit.created_at,
    updated_at: explicit && explicit.updated_at
  };
}
function visibleTasksForState(state) {
  const workflowCards = Array.isArray(state.workflowCards) ? state.workflowCards : [];
  const allTasks = state.tasks || [];
  if (workflowCards.length) {
    const fromWorkflow = workflowCards
      .filter(function(card) { return card && card.kind !== 'decision'; })
      .filter(function(card) { return workflowCardMatchesConversation(card, state); })
      .map(function(card) { return taskViewFromWorkflowCard(card, state); });
    return fromWorkflow.concat(derivedRequestTasks(state, allTasks));
  }
  const explicitTasks = allTasks.filter(taskMatchesConversation);
  return explicitTasks.concat(derivedRequestTasks(state, allTasks));
}
function hostDecisionCardsFromResult(hostResult) {
  if (!hostResult) return [];
  const workflow = Array.isArray(hostResult.workflowCards) ? hostResult.workflowCards : [];
  const fromWorkflow = workflow.filter(function(card) {
    return card && (card.kind === 'decision' || card.status === 'waiting_human');
  });
  if (fromWorkflow.length) return fromWorkflow;
  return hostResult.cards || [];
}
function taskByIdMap(tasks) {
  const map = {};
  tasks.forEach(function(task) {
    if (task && task.id) map[task.id] = task;
  });
  return map;
}
function artifactMatchesConversation(artifact, tasksById) {
  if (isAllConversationView()) return true;
  if (!artifact || !artifact.taskId) return false;
  const task = tasksById[artifact.taskId];
  return task && task.conversationId === activeConversationId;
}
function attachmentFilesForState(state) {
  const seen = {};
  const files = [];
  (state.messages || []).filter(messageMatchesConversation).forEach(function(message) {
    (message.attachments || []).forEach(function(attachment) {
      const key = attachment.id || attachment.url || (attachment.name + ':' + attachment.size + ':' + message.id);
      if (seen[key]) return;
      seen[key] = true;
      files.push({
        id: key,
        name: attachment.name || 'attachment',
        kind: attachment.mime || 'attachment',
        source: t('attachments'),
        size: attachment.size,
        url: attachment.url,
        created_at: message.created_at
      });
    });
  });
  return files;
}
function fileCardHtml(file) {
  const title = escapeHtml(file.path || file.name || 'artifact');
  const href = file.url ? ' href="' + escapeHtml(file.url) + '" target="_blank" rel="noreferrer noopener"' : '';
  const open = file.url ? '<a class="task-chat-open" href="' + escapeHtml(file.url) + '" target="_blank" rel="noreferrer noopener">' + t('files') + '</a>' : '';
  const size = file.size ? '<span>' + escapeHtml(formatBytes(file.size)) + '</span>' : '';
  const source = file.source || file.confidence || t('noDescription');
  return '<article class="task-card done file-card">' +
    '<div class="task-card-action">' +
    '<div class="file-card-icon" aria-hidden="true"></div>' +
    '<div class="file-card-main">' +
    '<div class="task-card-top"><span class="task-chip">' + escapeHtml(file.kind || 'file') + '</span><span class="task-state"><span class="task-state-dot done"></span>' + t('files') + '</span></div>' +
    '<h3>' + (href ? '<a' + href + '>' + title + '</a>' : title) + '</h3>' +
    '<div class="file-card-meta"><span>' + escapeHtml(source) + '</span>' + size + '</div>' +
    '</div>' +
    '</div>' +
    (open ? '<div class="task-card-footer">' + open + '</div>' : '') +
    '</article>';
}
function contextStringValue(context, key) {
  return context && typeof context[key] === 'string' ? context[key] : '';
}
function approvalConversationId(approval) {
  if (!approval) return '';
  if (typeof approval.conversationId === 'string') return approval.conversationId;
  return contextStringValue(approval.context || {}, 'conversationId');
}
function approvalTaskId(approval) {
  if (!approval) return '';
  if (typeof approval.taskId === 'string') return approval.taskId;
  return contextStringValue(approval.context || {}, 'taskId');
}
function approvalMatchesConversation(approval, tasksById) {
  if (isAllConversationView()) return true;
  const conversationId = approvalConversationId(approval);
  if (conversationId) return conversationId === activeConversationId;
  const taskId = approvalTaskId(approval);
  if (!taskId) return false;
  const task = tasksById[taskId];
  return task && task.conversationId === activeConversationId;
}
renderTasks = function(state) {
  const allTasks = state.tasks || [];
  const tasks = visibleTasksForState(state);
  const tasksById = taskByIdMap(tasks);
  document.getElementById('taskBadge').textContent = String(tasks.filter(function(task) { return task.status !== 'done'; }).length);
  document.getElementById('panel-tasks').innerHTML = taskBoardHtml(tasks);
  const artifacts = (state.artifacts || []).filter(function(artifact) { return artifactMatchesConversation(artifact, tasksById); });
  const files = artifacts.concat(attachmentFilesForState(state));
  document.getElementById('panel-files').innerHTML = files.length ? '<div class="task-board"><div class="task-grid">' + files.slice().reverse().map(fileCardHtml).join('') + '</div></div>' : '<div class="task-board"><div class="task-empty">' + t('fileEmpty') + '</div></div>';
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
    const engine = document.getElementById('engine').value;
    const savedEngine = ((window.__lastState && window.__lastState.agents) || []).find(function(agent) { return agent.id === 'king-ai-ceo'; });
    if (savedEngine && savedEngine.engine && engine && engine !== savedEngine.engine) {
      const ok = confirm(t('engineSwitchConfirm') || 'Switching engine restarts all local agents and may take up to a minute. Continue?');
      if (!ok) return;
    }
    await request('/gui/agent-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine: engine,
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
	  const attachmentsToSend = pendingAttachments.slice();
	  if (!body && !attachmentsToSend.length) return;
	  sendingMessage = true;
	  const optimisticBody = body || t('attachments');
	  const optimisticAttachments = attachmentsToSend.map(function(file) {
	    const row = {
	      name: file.name || 'attachment',
	      mime: file.type || 'application/octet-stream',
	      size: file.size || 0,
	      source: 'optimistic',
	      required: true
	    };
	    if (file.type && file.type.indexOf('image/') === 0) {
	      row.url = URL.createObjectURL(file);
	      row.__objectUrl = row.url;
	    }
	    return row;
	  });
	  pendingAttachments = [];
	  renderAttachmentTray();
	  input.value = '';
	  input.blur();
	  // Paint the human message (and attachment chips) instantly, before upload/message POST.
	  const batchId = addOptimisticMessages(optimisticBody, optimisticAttachments);
	  button.disabled = true;
	  button.textContent = t('send');
	  visibleMessageCount = 20;
	  shouldStickToBottom = true;
	  renderMessages(window.__lastState || { messages: [] }, {});
	  try {
	    const attachments = await uploadAttachmentFiles(attachmentsToSend);
	    const result = await request('/gui/message', {
	      method: 'POST',
	      headers: { 'Content-Type': 'application/json' },
	      body: JSON.stringify({ body: optimisticBody, conversationId: activeConversationId, attachments })
	    });
	    const serverId = result && result.message && result.message.id;
	    if (serverId) optimisticMessages.forEach(function(m) { if (m.__batch === batchId) m.__serverId = serverId; });
	    refreshSoon();
	  } catch (error) {
	    optimisticMessages = optimisticMessages.filter(function(m) {
	      if (m.__batch !== batchId) return true;
	      revokeOptimisticAttachmentUrls(m.attachments);
	      return false;
	    });
	    input.value = body;
	    pendingAttachments = attachmentsToSend;
	    renderAttachmentTray();
	    renderMessages(window.__lastState || { messages: [] }, {});
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
  const serverRows = sortMessagesChronologically((state.messages || []).filter(function(message) { return message.conversation_id === activeConversationId; }));
  reconcileOptimistic(serverRows);
  const allRows = mergeOptimistic(serverRows);
  if (allRows.length > lastMessageTotal) visibleMessageCount = 20;
  lastMessageTotal = allRows.length;
  visibleMessageCount = Math.min(Math.max(visibleMessageCount, 20), Math.max(lastMessageTotal, 20));
  const rows = allRows.slice(-visibleMessageCount);
  const hasOlder = rows.length < allRows.length;
  const olderLine = hasOlder ? t('loadOlder') : t('noOlderMessages');
  const visibleRows = rows.filter(shouldRenderChatMessage);
  function currentHumanName() {
    const user = window.__lastSummary && window.__lastSummary.currentUser;
    return user && (user.name || user.email || user.id) || 'you';
  }
  function currentHumanInitial() {
    return displayInitial(currentHumanName(), 'U');
  }
  function displayInitial(label, fallback) {
    const clean = String(label || '').trim();
    const match = clean.match(/[A-Za-z0-9]/);
    return (match ? match[0] : clean.slice(0, 1) || fallback || '?').toUpperCase();
  }
  function authorHtml(message) {
    const name = message.author_kind === 'agent' ? (message.author_name || 'AI') : (message.author_name || currentHumanName());
    const engine = message.author_kind === 'agent' && message.author_engine ? '<span class="engine-chip">' + escapeHtml(message.author_engine) + '</span>' : '';
    return escapeHtml(name) + engine;
  }
  const html = visibleRows.map(function(message) {
    if (message.author_kind === 'system') {
      return '<div class="system-line">' + escapeHtml(message.body) + '</div>';
    }
    const initial = message.author_kind === 'agent' ? displayInitial(message.author_name || 'AI', 'A') : currentHumanInitial();
    const unreadClass = message.author_kind === 'human' && !(message.readBy || []).includes('king-ai-ceo') ? ' highlight' : '';
    const pendingClass = message.status === 'pending' ? ' pending' : '';
    const renderedBody = message.body_html || '';
    const bodyHtml = message.status === 'pending' ? '<span class="typing-dots"><span></span><span></span><span></span></span><span>' + escapeHtml(t('agentThinking')) + '</span>' : (renderedBody || escapeHtml(message.body));
    const bodyClass = renderedBody && message.status !== 'pending' ? 'post-body markdown-body' : 'post-body plain';
	    return '<article class="post' + pendingClass + unreadClass + '"><div class="avatar">' + escapeHtml(initial) + '</div><div><div class="post-top"><span class="author">' + authorHtml(message) + '</span>' + ttsButtonHtml(message) + '<span class="time">' + formatTime(message.created_at) + '</span></div><div class="' + bodyClass + '">' + bodyHtml + '</div>' + attachmentListHtml(message.attachments) + '</div></article>';
  }).join('');
  const chatWindow = document.getElementById('chatWindow');
  chatWindow.classList.toggle('empty-state', !visibleRows.length);
  chatWindow.innerHTML = '<div class="system-line">' + olderLine + '</div>' + html;
  if (!visibleRows.length) {
    const workspace = document.querySelector('.workspace');
    if (workspace) workspace.scrollTop = 0;
    shouldStickToBottom = true;
    updateBackToBottom();
    return;
  }
  if (options && options.preserveScroll) updateBackToBottom();
  else if (shouldStickToBottom && visibleRows.length) scrollToBottom();
  else updateBackToBottom();
};
function displayConversationTitle(row) {
  if (!row || row.id === 'king-ai-convo') return t('allWindow');
  return row.title || row.id;
}
function currentAgents() {
  const summary = window.__lastSummary || {};
  return summary.agents || summary.activeAgents || (summary.agent ? [summary.agent] : []);
}
function currentWorkflows() {
  const summary = window.__lastSummary || {};
  return summary.workflows || [];
}
function selectedWorkflowId() {
  const select = document.getElementById('newWindowWorkflow');
  return select && select.value ? select.value : 'ielts-study';
}
function selectedWorkflow() {
  const workflowId = selectedWorkflowId();
  return currentWorkflows().find(function(workflow) { return workflow.id === workflowId; }) || currentWorkflows()[0] || null;
}
function workflowLabel(workflow) {
  if (!workflow) return '';
  if (workflow.id === 'software-dev') return t('workflowSoftwareDev');
  if (workflow.id === 'ielts-study') return t('workflowIeltsStudy');
  return workflow.name || workflow.id;
}
function workflowAgents() {
  const workflow = selectedWorkflow();
  return workflow && workflow.agents && workflow.agents.length ? workflow.agents : currentAgents();
}
function agentCountLabel(count) {
  return count + (currentLang === 'zh' ? ' 个 Agent' : (count === 1 ? ' agent' : ' agents'));
}
function workflowCoordinatorId() {
  const workflow = selectedWorkflow();
  return workflow && workflow.defaultCoordinatorAgentId ? workflow.defaultCoordinatorAgentId : (workflowAgents()[0] || {}).id || 'king-ai-ceo';
}
function selectedWindowMode() {
  const checked = document.querySelector('input[name="newWindowMode"]:checked');
  return checked ? checked.value : 'team';
}
function selectedTeamAgentIds() {
  const ids = Array.from(document.querySelectorAll('input[name="newWindowTeamAgent"]:checked')).map(function(input) {
    return input.value;
  });
  const coordinatorId = workflowCoordinatorId();
  if (coordinatorId && !ids.includes(coordinatorId)) ids.unshift(coordinatorId);
  return ids;
}
function renderWorkflowOptions() {
  const select = document.getElementById('newWindowWorkflow');
  if (!select) return;
  const workflows = currentWorkflows();
  select.innerHTML = workflows.map(function(workflow) {
    return '<option value="' + escapeHtml(workflow.id) + '">' + escapeHtml(workflowLabel(workflow)) + '</option>';
  }).join('');
  const defaultWorkflow = workflows.find(function(workflow) { return workflow.id === 'ielts-study'; }) || workflows[0];
  if (defaultWorkflow) select.value = defaultWorkflow.id;
}
function renderAgentOptions() {
  const agents = workflowAgents();
  const coordinatorId = workflowCoordinatorId();
  const checks = document.getElementById('newWindowTeam');
  if (checks) {
    checks.innerHTML = agents.map(function(agent) {
      const fixed = agent.id === coordinatorId;
      const checked = fixed ? ' checked' : '';
      const disabled = fixed ? ' disabled' : '';
      return '<label class="agent-check"><input type="checkbox" name="newWindowTeamAgent" value="' + escapeHtml(agent.id) + '"' + checked + disabled + ' /><span>' + escapeHtml(agent.name || agent.id) + '</span></label>';
    }).join('');
  }
}
function syncNewWindowModeOptions() {
  const agents = workflowAgents();
  const teamAvailable = agents.length > 1;
  const teamOption = document.querySelector('[data-window-mode-option="team"]');
  const customOption = document.querySelector('[data-window-mode-option="custom"]');
  const teamInput = document.querySelector('input[name="newWindowMode"][value="team"]');
  const customInput = document.querySelector('input[name="newWindowMode"][value="custom"]');
  const teamDesc = document.getElementById('newWindowTeamModeDesc');
  const customDesc = document.getElementById('newWindowCustomModeDesc');
  if (teamOption) teamOption.classList.toggle('unavailable', !teamAvailable);
  if (customOption) customOption.classList.toggle('unavailable', !teamAvailable);
  if (teamOption) teamOption.classList.toggle('hidden', !teamAvailable);
  if (customOption) customOption.classList.toggle('hidden', !teamAvailable);
  if (teamInput) teamInput.disabled = !teamAvailable;
  if (customInput) customInput.disabled = !teamAvailable;
  if (teamDesc) teamDesc.textContent = agentCountLabel(agents.length);
  if (customDesc) customDesc.textContent = teamAvailable ? t('customTeamDesc') : agentCountLabel(agents.length);
  if (!teamAvailable && selectedWindowMode() !== 'single') setWindowMode('single');
}
function syncNewWindowMode() {
  syncNewWindowModeOptions();
  const mode = selectedWindowMode();
  const custom = document.getElementById('newWindowCustomTeam');
  if (custom) custom.classList.toggle('hidden', mode !== 'custom');
}
function syncNewWindowWorkflow() {
  renderAgentOptions();
  syncNewWindowMode();
}
function setWindowMode(mode) {
  const option = document.querySelector('input[name="newWindowMode"][value="' + mode + '"]');
  if (option && !option.disabled) option.checked = true;
  syncNewWindowMode();
}
function setTeamAgentChecks(ids) {
  const wanted = new Set(ids || []);
  const coordinatorId = workflowCoordinatorId();
  document.querySelectorAll('input[name="newWindowTeamAgent"]').forEach(function(input) {
    input.checked = input.value === coordinatorId || wanted.has(input.value);
  });
}
createConversation = function() {
  const input = document.getElementById('newWindowTitle');
  input.disabled = false;
  const title = document.querySelector('#newWindowDialog h2');
  if (title) title.textContent = t('newWindow');
  input.value = '';
  renderWorkflowOptions();
  renderAgentOptions();
  setWindowMode('single');
  const submit = document.getElementById('newWindowSubmit');
  if (submit) submit.textContent = t('create');
  const dialog = document.getElementById('newWindowDialog');
  if (!dialog.open) dialog.showModal();
  setTimeout(function() { input.focus(); }, 0);
};
closeNewWindowDialog = function() {
  const input = document.getElementById('newWindowTitle');
  if (input) input.disabled = false;
  document.getElementById('newWindowDialog').close();
};
submitConversation = async function(event) {
  event.preventDefault();
  const input = document.getElementById('newWindowTitle');
  const title = input.value.trim();
  const workflowId = selectedWorkflowId();
  const mode = selectedWindowMode();
  const coordinatorAgentId = workflowCoordinatorId();
  const teamAgentIds = mode === 'custom' ? selectedTeamAgentIds() : undefined;
  const submit = document.getElementById('newWindowSubmit');
  submit.disabled = true;
  submit.textContent = t('sending');
  try {
    const result = await request('/gui/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, workflowId, teamMode: mode, coordinatorAgentId, teamAgentIds })
    });
    optimisticMessages = [];
    activeConversationId = result.conversation.id;
    localStorage.setItem('king-ai:activeConversationId', activeConversationId);
    applyNewConversationOptimistic(result.conversation);
    visibleMessageCount = 20;
    shouldStickToBottom = true;
    input.disabled = false;
    closeNewWindowDialog();
    const switchToken = ++conversationSwitchToken;
    void loadGuiPayload({ conversationSwitch: true, switchToken: switchToken }).then(function(payload) {
      if (!payload) return;
      renderSummary(payload.summary);
      renderMessages(payload.state);
      renderTasks(payload.state);
      renderDecisions(payload.state, window.__lastHostDecisions || { configured: false, cards: [] });
    }).catch(function() {});
  } finally {
    submit.disabled = false;
    submit.textContent = t('create');
  }
};
renderConversations = function(summary) {
  const conversations = summary.conversations || [];
  if (conversations.length && !conversations.some(function(row) { return row.id === activeConversationId; })) activeConversationId = conversations[0].id;
  const active = conversations.find(function(row) { return row.id === activeConversationId; }) || conversations[0] || { id: 'king-ai-convo', title: 'all' };
  const activeTitle = displayConversationTitle(active);
  document.querySelector('.channel-name').textContent = activeTitle;
  document.querySelector('.composer textarea').placeholder = 'Message #' + activeTitle;
  document.querySelector('.hash').textContent = active.id === 'king-ai-convo' ? '#' : '~';
  const runStatus = activeConversationStatus(summary, active);
  document.getElementById('routeSummary').textContent = runStatus;
  const runIndicator = document.getElementById('runIndicator');
  if (runIndicator) {
    const busy = Boolean(runStatus);
    const label = busy ? t('runActive') : t('runIdle');
    runIndicator.classList.toggle('running', busy);
    runIndicator.setAttribute('aria-label', label);
    runIndicator.setAttribute('title', runStatus || label);
    const runLabel = document.getElementById('runLabel');
    if (runLabel) runLabel.textContent = label;
  }
  document.getElementById('conversationList').innerHTML = conversations.map(function(row) {
    const deletable = row.id !== 'king-ai-convo';
    return '<div class="window-item' + (row.id === activeConversationId ? ' active' : '') + '"><button class="window-select" onclick="selectConversation(&quot;' + escapeHtml(row.id) + '&quot;)"><span class="window-name">' + escapeHtml(displayConversationTitle(row)) + '</span></button><span class="window-meta">' + escapeHtml(row.unread || 0) + '</span>' + (deletable ? '<button class="window-delete" onclick="deleteConversation(event, &quot;' + escapeHtml(row.id) + '&quot;)" aria-label="Delete window">x</button>' : '') + '</div>';
  }).join('');
};
function teamStatusClass(agent) {
  const active = (agent.status === 'running' || agent.status === 'thinking' || (agent.unreadMessages || 0) > 0 || (agent.openTasks || 0) > 0 || (agent.activeCards || 0) > 0);
  return active ? ' active' : '';
}
function teamActivityTitle(agent, label, meta) {
  const reasons = [];
  if (agent.status === 'running' || agent.status === 'thinking') reasons.push(teamStatusText(agent));
  if ((agent.unreadMessages || 0) > 0) reasons.push(t('agentStatusUnread') + ' ' + agent.unreadMessages);
  if ((agent.openTasks || 0) > 0) reasons.push(t('agentStatusTasks') + ' ' + agent.openTasks);
  if ((agent.activeCards || 0) > 0) reasons.push(t('agentStatusCards') + ' ' + agent.activeCards);
  return label + ' · ' + (reasons.join(' · ') || teamStatusText(agent)) + ' · ' + meta;
}
function teamStatusText(agent) {
  if (agent.status === 'running') return t('agentStatusRunning');
  if (agent.status === 'thinking') return t('agentStatusThinking');
  if ((agent.unreadMessages || 0) > 0) return t('agentStatusUnread');
  if ((agent.openTasks || 0) > 0) return t('agentStatusTasks');
  if ((agent.activeCards || 0) > 0) return t('agentStatusCards');
  return translatedAgentStatus(agent.status);
}
function translatedAgentStatus(status) {
  const value = String(status || '').toLowerCase();
  if (!value || value === 'idle') return t('agentStatusIdle');
  if (value === 'avail' || value === 'available' || value === 'online' || value === 'ready') return t('agentStatusAvailable');
  if (value === 'running') return t('agentStatusRunning');
  if (value === 'thinking') return t('agentStatusThinking');
  return status;
}
function agentMatchKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function findAgentByName(summary, name) {
  const key = agentMatchKey(name);
  const agents = summary.agents || [];
  return agents.find(function(agent) {
    return agentMatchKey(agent.id) === key || agentMatchKey(agent.name) === key;
  });
}
function currentRoomAgents(summary) {
  const seen = new Set();
  const agents = [];
  function add(agent) {
    if (!agent) return;
    const key = agent.id || agent.name;
    if (!key || seen.has(key)) return;
    seen.add(key);
    agents.push(agent);
  }
  (summary.activeAgents || []).forEach(add);
  const state = window.__lastState || {};
  (state.messages || []).forEach(function(message) {
    if (message.conversation_id !== activeConversationId || message.author_kind !== 'agent') return;
    add(findAgentByName(summary, message.author_name) || {
      id: 'room-' + agentMatchKey(message.author_name),
      name: message.author_name || 'agent',
      status: 'idle',
      unreadMessages: 0,
      openTasks: 0,
      activeCards: 0
    });
  });
  if (!agents.length && summary.agent) add(summary.agent);
  return agents;
}
function renderTeamStrip(summary) {
  const team = currentRoomAgents(summary);
  const strip = document.getElementById('teamStrip');
  if (!strip) return;
  const agentsHtml = team.map(function(agent) {
    const label = agent.name || agent.id || 'agent';
    const meta = 'u' + (agent.unreadMessages || 0) + ' t' + (agent.openTasks || 0);
    const title = teamActivityTitle(agent, label, meta);
    return '<div class="team-agent" title="' + escapeHtml(title) + '">' +
      '<span class="team-dot' + teamStatusClass(agent) + '"></span>' +
      '<span class="team-name">' + escapeHtml(label) + '</span>' +
      '<span class="team-status">' + escapeHtml(teamStatusText(agent)) + '</span>' +
      '<span class="team-meta">' + escapeHtml(meta) + '</span>' +
      '</div>';
  }).join('');
  strip.innerHTML = agentsHtml;
}
const baseRenderSummary = renderSummary;
renderSummary = function(summary) {
  window.__lastSummary = summary;
  baseRenderSummary(summary);
  renderTeamStrip(summary);
  renderRemoteAssist(summary);
  if (summary.pairingLocator) {
    pairCommandPrimary = npxKingAiCommand('agent computer --pair ' + shellQuote(summary.pairingLocator));
    pairCommandStart = npxKingAiCommand('agent computer');
    pairCommand = pairCommandPrimary + '\\n' + pairCommandStart;
    if (document.getElementById('computerDialog').open) renderComputerFlow();
  }
};
function decisionStatusText(status) {
  return ({ pending: t('decisionPending'), approved: t('decisionApproved'), denied: t('decisionDenied') })[status] || status || t('decisionPending');
}
function decisionCardHtml(approval) {
  const status = approval.status || 'pending';
  const stateClass = status === 'approved' ? 'done' : status === 'denied' ? 'failed' : 'pending';
  const context = approval.context && Object.keys(approval.context).length ? JSON.stringify(approval.context) : '';
  const when = approval.createdAt ? formatTime(approval.createdAt) : '';
  const id = String(approval.id || '');
  const controls = status === 'pending'
    ? '<div class="decision-actions"><button class="decision-approve" onclick="resolveDecision(&quot;' + escapeHtml(id) + '&quot;, &quot;approve&quot;)">' + t('decisionApprove') + '</button><button class="decision-deny" onclick="resolveDecision(&quot;' + escapeHtml(id) + '&quot;, &quot;deny&quot;)">' + t('decisionDeny') + '</button></div>'
    : '<div class="decision-resolved">' + escapeHtml(decisionStatusText(status)) + (approval.reason ? ' · ' + escapeHtml(approval.reason) : '') + '</div>';
  return '<article class="task-card ' + stateClass + '">' +
    '<div class="task-card-top"><span class="task-chip">' + escapeHtml(approval.action || 'decision') + '</span><span class="task-state"><span class="task-state-dot ' + stateClass + '"></span>' + escapeHtml(decisionStatusText(status)) + '</span></div>' +
    '<h3>' + escapeHtml(approval.action || id) + '</h3>' +
    (context ? '<p>' + escapeHtml(context) + '</p>' : '') +
    (when ? '<div class="task-card-meta"><span>' + escapeHtml(when) + '</span></div>' : '') +
    controls +
    '</article>';
}
function hostDecisionCardHtml(card) {
  const id = String(card.id || '');
  const detail = card.detail || (card.kind === 'decision' && card.result ? card.result : '');
  const meta = [card.ownerRole ? 'owner=' + card.ownerRole : '', card.decisionBy ? 'decideBy=' + card.decisionBy : ''].filter(Boolean).join(' · ');
  return '<article class="task-card pending decision-host">' +
    '<div class="task-card-top"><span class="task-chip">' + t('decisionSourceHost') + '</span><span class="task-state"><span class="task-state-dot pending"></span>' + t('decisionPending') + '</span></div>' +
    '<h3>' + escapeHtml(card.title || id) + '</h3>' +
    (detail ? '<p>' + escapeHtml(detail) + '</p>' : '') +
    (meta ? '<div class="task-card-meta"><span>' + escapeHtml(meta) + '</span></div>' : '') +
    '<div class="decision-actions"><button class="decision-approve" onclick="resolveHostDecision(&quot;' + escapeHtml(id) + '&quot;, &quot;approve&quot;)">' + t('decisionApprove') + '</button><button class="decision-deny" onclick="resolveHostDecision(&quot;' + escapeHtml(id) + '&quot;, &quot;deny&quot;)">' + t('decisionDeny') + '</button></div>' +
    '</article>';
}
async function resolveHostDecision(id, decision) {
  await request('/gui/host-decisions/' + encodeURIComponent(id) + '/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: decision })
  });
  await refresh();
}
function renderDecisions(state, hostResult) {
  const tasksById = taskByIdMap(visibleTasksForState(state));
  const approvals = (state.approvals || []).filter(function(approval) { return approvalMatchesConversation(approval, tasksById); }).slice().reverse();
  const hostCards = isAllConversationView() ? hostDecisionCardsFromResult(hostResult) : [];
  const pending = approvals.filter(function(approval) { return approval.status === 'pending'; });
  const badge = document.getElementById('decisionBadge');
  const count = pending.length + hostCards.length;
  if (badge) {
    badge.textContent = String(count);
    badge.setAttribute('data-empty', count ? '0' : '1');
  }
  const panel = document.getElementById('panel-decisions');
  if (!panel) return;
  const grids = [];
  if (hostCards.length) grids.push('<div class="task-grid">' + hostCards.map(hostDecisionCardHtml).join('') + '</div>');
  if (approvals.length) grids.push('<div class="task-grid">' + approvals.map(decisionCardHtml).join('') + '</div>');
  panel.innerHTML = grids.length
    ? '<div class="task-board">' + grids.join('') + '</div>'
    : '<div class="task-board"><div class="task-empty">' + t('decisionEmpty') + '</div></div>';
}
async function resolveDecision(id, decision) {
  await request('/gui/approvals/' + encodeURIComponent(id) + '/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: decision })
  });
  await refresh();
}
showPanel = function(name) {
  ['chat', 'tasks', 'files', 'decisions'].forEach(function(panel) {
    const panelEl = document.getElementById('panel-' + panel);
    const tabEl = document.querySelector('[data-panel="' + panel + '"]');
    if (panelEl) panelEl.classList.toggle('active', panel === name);
    if (tabEl) tabEl.classList.toggle('active', panel === name);
  });
  const workspace = document.querySelector('.workspace');
  if (workspace) workspace.scrollTop = 0;
  updateBackToBottom();
  if (needsFullStateRefresh(name)) {
    void refresh({ full: true, panel: name });
  }
};
refresh = async function(options) {
  const panel = (options && options.panel) || activePanelName();
  const includeDecisions = needsFullStateRefresh(panel) || !(options && options.conversationSwitch);
  const payload = await loadGuiPayload(options || {});
  if (!payload) return;
  if (includeDecisions) {
    window.__lastHostDecisions = await request('/gui/host-decisions').catch(function() { return { configured: false, cards: [] }; });
  }
  renderSummary(payload.summary);
  renderMessages(payload.state, options || {});
  renderTasks(payload.state);
  if (includeDecisions) renderDecisions(payload.state, window.__lastHostDecisions);
};
const baseApplyConversationSwitchOptimistic = applyConversationSwitchOptimistic;
applyConversationSwitchOptimistic = function() {
  baseApplyConversationSwitchOptimistic();
  const state = window.__lastState;
  if (state) renderDecisions(state, window.__lastHostDecisions || { configured: false, cards: [] });
};
const baseApplyNewConversationOptimistic = applyNewConversationOptimistic;
applyNewConversationOptimistic = function(conversation) {
  baseApplyNewConversationOptimistic(conversation);
  const state = window.__lastState;
  if (state) renderDecisions(state, window.__lastHostDecisions || { configured: false, cards: [] });
};
selectConversation = function(id) {
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
    renderDecisions(payload.state, window.__lastHostDecisions || { configured: false, cards: [] });
  }).catch(function() {});
};
applyLanguage();
refresh();
`;
