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
    .team-strip {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      overflow-x: auto;
      border-bottom: 2px solid var(--line);
      background: var(--panel);
      padding: 6px 10px;
    }
    .team-agent {
      flex: 0 0 auto;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 6px;
      min-width: 132px;
      max-width: 210px;
      border: 2px solid var(--line);
      background: #fff;
      padding: 4px 7px;
      box-shadow: 2px 2px 0 var(--line);
      font-size: 11px;
      font-weight: 900;
    }
    .team-dot {
      width: 8px;
      height: 8px;
      border: 1px solid var(--line);
      background: var(--muted);
    }
    .team-dot.active { background: var(--accent); }
    .team-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .team-meta {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10px;
      white-space: nowrap;
    }
    .app {
      grid-template-columns: 180px minmax(0, 1fr);
    }
    .composer {
      left: 196px;
      padding-top: 10px;
    }
    .composer-tools {
      position: absolute;
      bottom: calc(100% + 10px);
      right: 8px;
      display: flex;
      gap: 6px;
      align-items: center;
      background: var(--canvas);
    }
    .composer-tools button {
      min-height: 24px;
      padding: 3px 8px;
      font-size: 11px;
    }
    .message-list.empty-state {
      position: sticky;
      top: 14px;
      align-content: start;
    }
    .message-list.empty-state .system-line {
      padding-top: 0;
    }
    .mode-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .mode-option {
      display: grid;
      gap: 4px;
      border: 2px solid var(--line);
      background: #fff;
      padding: 8px;
      min-height: 58px;
      cursor: pointer;
      font-weight: 900;
    }
    .mode-option input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
    .mode-option:has(input:checked) {
      background: var(--accent);
      box-shadow: 3px 3px 0 var(--line);
    }
    .mode-title {
      font-size: 12px;
      line-height: 1.2;
    }
    .mode-desc {
      color: var(--muted);
      font-size: 10px;
      line-height: 1.25;
    }
    .agent-checks {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .agent-check {
      display: flex;
      align-items: center;
      gap: 6px;
      border: 2px solid var(--line);
      background: #fff;
      color: var(--ink);
      padding: 7px;
      font-size: 11px;
      font-weight: 900;
      text-transform: none;
      min-width: 0;
    }
    .agent-check span {
      display: block;
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agent-check input {
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      padding: 0;
      accent-color: var(--accent);
    }
    .role-prompts {
      display: grid;
      gap: 8px;
    }
    .role-prompt {
      display: grid;
      gap: 5px;
    }
    .role-prompt textarea {
      min-height: 58px;
      max-height: 100px;
      font-size: 11px;
      line-height: 1.35;
    }
    .hidden {
      display: none !important;
    }
    body.mobile-layout .app {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: 38px minmax(0, 1fr);
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
      grid-template-rows: auto auto auto minmax(0, 1fr);
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
    body.mobile-layout .lang-switch button,
    body.mobile-layout .top-actions > button {
      min-height: 28px;
      padding: 3px 6px;
      white-space: nowrap;
    }
    body.mobile-layout .tabs {
      height: 28px;
      overflow-x: auto;
    }
    body.mobile-layout .team-strip {
      width: 100%;
      max-width: 100vw;
      min-width: 0;
      padding: 4px 6px;
      gap: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      flex-wrap: nowrap;
      overscroll-behavior-x: contain;
    }
    body.mobile-layout .team-strip::-webkit-scrollbar {
      height: 7px;
    }
    body.mobile-layout .team-agent {
      min-width: 122px;
      max-width: 142px;
      padding: 3px 6px;
    }
    body.mobile-layout .mode-grid,
    body.mobile-layout .agent-checks {
      grid-template-columns: 1fr;
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
      bottom: 112px;
    }
    body.mobile-layout .composer {
      left: 8px;
      right: 8px;
      bottom: 16px;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: stretch;
      gap: 8px;
      padding: 10px;
    }
    body.mobile-layout .composer-tools {
      bottom: calc(100% + 14px);
      right: 10px;
    }
    #panel-tasks.tab-panel,
    #panel-files.tab-panel,
    #panel-decisions.tab-panel {
      max-width: none;
      padding: 0;
      gap: 0;
    }
    #panel-tasks.tab-panel.active,
    #panel-files.tab-panel.active,
    #panel-decisions.tab-panel.active {
      display: block;
    }
    .task-board {
      display: grid;
      gap: 16px;
      min-height: 100%;
      padding: 18px;
      align-content: start;
    }
    .task-board-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      max-width: 1140px;
    }
    .task-count {
      display: inline-flex;
      align-items: baseline;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 900;
    }
    .task-count strong {
      color: var(--ink);
      font-size: 16px;
    }
    .task-filter {
      display: flex;
      align-items: center;
      gap: 0;
      border: 1px solid var(--soft-line);
      background: var(--canvas);
      padding: 3px;
    }
    .task-filter button {
      border-color: transparent;
      min-height: 28px;
      padding: 4px 12px;
      color: var(--muted);
      background: transparent;
    }
    .task-filter button.active {
      border-color: var(--line);
      background: var(--accent);
      color: var(--ink);
    }
    .task-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
      gap: 10px;
      max-width: 1140px;
    }
    .task-card {
      display: grid;
      gap: 8px;
      align-content: start;
      min-height: 122px;
      border: 1px solid var(--soft-line);
      background: #fff8df;
      padding: 12px;
    }
    .task-card.done {
      background: var(--canvas);
    }
    .task-card.failed {
      background: #fff1f1;
    }
    .task-card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .task-chip {
      max-width: 54%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      background: #5c9f96;
      color: #fff;
      padding: 4px 8px;
      font-size: 10px;
      font-weight: 900;
    }
    .task-state {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 900;
      white-space: nowrap;
    }
    .task-state-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #e7d56b;
    }
    .task-state-dot.done { background: #5c9f96; }
    .task-state-dot.failed { background: #d65252; }
    .task-state-dot.pending { background: #ddd7cc; }
    .task-card h3 {
      font-size: 14px;
      line-height: 1.3;
    }
    .task-card p {
      color: var(--body);
      font-size: 12px;
      line-height: 1.4;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .task-card-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      font-weight: 800;
    }
    .task-empty {
      display: grid;
      place-items: center;
      min-height: 220px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }
    .tab-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 16px;
      height: 16px;
      padding: 0 5px;
      margin-left: 4px;
      border-radius: 999px;
      background: #d65252;
      color: #fff;
      font-size: 10px;
      font-weight: 800;
    }
    .tab-badge[data-empty="1"] { display: none; }
    .decision-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .decision-actions button {
      flex: 1;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid var(--line, #ddd7cc);
      font-size: 12px;
      font-weight: 800;
      cursor: pointer;
    }
    .decision-approve { background: #5c9f96; color: #fff; border-color: #5c9f96; }
    .decision-deny { background: #fff; color: #d65252; border-color: #d65252; }
    .decision-resolved {
      margin-top: 10px;
      font-size: 12px;
      font-weight: 700;
      color: var(--muted);
    }
    .task-card.decision-host {
      border-left: 3px solid #7a8cff;
    }
    body.mobile-layout .composer textarea {
      min-height: 52px;
      max-height: 90px;
      padding: 8px 6px;
      font-size: 14px;
    }
    body.mobile-layout .composer button {
      min-width: 54px;
      padding: 6px 10px;
    }
    body.mobile-layout .task-board {
      padding: 10px 10px 24px;
      gap: 10px;
    }
    body.mobile-layout .task-board-head {
      align-items: stretch;
    }
    body.mobile-layout .task-filter {
      width: 100%;
    }
    body.mobile-layout .task-filter button {
      flex: 1 1 0;
      padding: 4px 8px;
    }
    body.mobile-layout .task-grid {
      grid-template-columns: 1fr;
      gap: 8px;
    }
    body.mobile-layout .task-card {
      min-height: 0;
      gap: 7px;
      padding: 10px;
    }
    body.mobile-layout .task-card-top {
      align-items: flex-start;
    }
    body.mobile-layout .task-chip {
      max-width: 48%;
      padding: 3px 7px;
    }
    body.mobile-layout .task-card h3 {
      font-size: 14px;
      line-height: 1.3;
    }
    body.mobile-layout .task-card p {
      font-size: 12px;
      line-height: 1.35;
      -webkit-line-clamp: 2;
    }
    body.mobile-layout .task-card-meta {
      gap: 5px;
      font-size: 10px;
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
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}
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
    agentRuntime: 'Agent 运行时',
    localCli: '本地 CLI',
    mainModel: '主模型',
    fastModel: '快速模型',
    apply: '应用',
    saving: '保存中...',
    saved: '已保存',
    addComputer: '添加电脑',
    newWindow: '新窗口',
    windowName: '名称',
    windowMode: '协作方式',
    singleAgent: '单 Agent',
    singleAgentDesc: '只让负责人回复',
    defaultTeam: '默认团队',
    defaultTeamDesc: 'CEO + Dev + Reviewer',
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
    loadOlder: '向上滚动加载更早消息...',
    noOlderMessages: '没有更早消息',
    channelDesc: '所有成员的通用频道',
    noMessages: '还没有消息。输入一句话，发送给本地 AI。',
    taskBoardTitle: '任务',
    taskFilterAll: '全部',
    taskFilterActive: '进行中',
    taskFilterDone: '已完成',
    taskEmpty: '暂无任务',
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
    artifactsLabel: '产物',
    revisionLabel: '退回原因',
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
    agentRuntime: 'Agent runtime',
    localCli: 'Local CLI',
    mainModel: 'Main model',
    fastModel: 'Fast model',
    apply: 'Apply',
    saving: 'Saving...',
    saved: 'Saved',
    addComputer: 'Add computer',
    newWindow: 'New Window',
    windowName: 'Name',
    windowMode: 'Collaboration',
    singleAgent: 'Single agent',
    singleAgentDesc: 'Only the owner replies',
    defaultTeam: 'Default team',
    defaultTeamDesc: 'CEO + Dev + Reviewer',
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
    loadOlder: 'Scroll to top to load older messages...',
    noOlderMessages: 'No older messages',
    channelDesc: 'General channel for all members',
    noMessages: 'No messages yet. Type something and send it to the local AI.',
    taskBoardTitle: 'Tasks',
    taskFilterAll: 'All',
    taskFilterActive: 'Active',
    taskFilterDone: 'Done',
    taskEmpty: 'No tasks yet',
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
    artifactsLabel: 'Artifacts',
    revisionLabel: 'Revision',
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
let pendingRevealTimer = 0;
function pendingDisplayDelayMs(message) {
  const id = String(message.id || '');
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 2001;
  }
  return 3000 + hash;
}
function shouldRenderChatMessage(message) {
  if (message.author_kind === 'system' && message.payload && message.payload.taskEventType) return false;
  if (message.status !== 'pending') return true;
  const createdAt = Number(message.created_at || Date.now());
  return Date.now() - createdAt >= pendingDisplayDelayMs(message);
}
function schedulePendingReveal(rows) {
  if (pendingRevealTimer) {
    clearTimeout(pendingRevealTimer);
    pendingRevealTimer = 0;
  }
  const remaining = rows
    .filter(function(message) { return message.status === 'pending' && !shouldRenderChatMessage(message); })
    .map(function(message) {
      return Number(message.created_at || Date.now()) + pendingDisplayDelayMs(message) - Date.now();
    })
    .filter(function(delay) { return delay > 0; });
  if (!remaining.length) return;
  pendingRevealTimer = window.setTimeout(function() {
    pendingRevealTimer = 0;
    refresh();
  }, Math.max(250, Math.min.apply(Math, remaining)));
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
  return conversationTeamLabel(summary, active);
};
function agentDisplayName(summary, id) {
  const agents = summary.agents || [];
  const agent = agents.find(function(row) { return row.id === id; });
  return agent && (agent.name || agent.id) || id;
}
function conversationTeamLabel(summary, active) {
  const snapshot = active.teamSnapshot || {};
  const mode = snapshot.mode || active.teamMode || 'team';
  const snapshotAgents = snapshot.agents || [];
  const ids = snapshot.teamAgentIds && snapshot.teamAgentIds.length ? snapshot.teamAgentIds : active.teamAgentIds && active.teamAgentIds.length ? active.teamAgentIds : ['king-ceo', 'dev', 'reviewer'];
  const names = ids.map(function(id) {
    const agent = snapshotAgents.find(function(row) { return row.id === id; });
    return agent && (agent.name || agent.id) || agentDisplayName(summary, id);
  }).join(' + ');
  if (mode === 'single') return currentLang === 'zh' ? '单 Agent：' + names + ' 负责回复' : 'Single agent: ' + names + ' replies';
  if (mode === 'custom') return currentLang === 'zh' ? '自定义团队：' + names : 'Custom team: ' + names;
  return currentLang === 'zh' ? '默认团队：' + names : 'Default team: ' + names;
}
let taskFilterMode = localStorage.getItem('king:taskFilter') || 'all';
function setTaskFilter(mode) {
  taskFilterMode = mode === 'done' || mode === 'active' ? mode : 'all';
  localStorage.setItem('king:taskFilter', taskFilterMode);
  renderTasks(window.__lastState || { tasks: [], artifacts: [] });
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
  return '<article class="task-card ' + stateClass + '">' +
    '<div class="task-card-top"><span class="task-chip">' + escapeHtml(taskOwnerLabel(task)) + '</span><span class="task-state"><span class="task-state-dot ' + stateClass + '"></span>' + escapeHtml(taskStatusText(task.status)) + '</span></div>' +
    '<h3>' + escapeHtml(task.title || task.id || t('taskBoardTitle')) + '</h3>' +
    '<p>' + escapeHtml(taskText(task)) + '</p>' +
    taskMetaHtml(task) +
    '</article>';
}
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
renderTasks = function(state) {
  const tasks = state.tasks || [];
  document.getElementById('taskBadge').textContent = String(tasks.filter(function(task) { return task.status !== 'done'; }).length);
  document.getElementById('panel-tasks').innerHTML = taskBoardHtml(tasks);
  const artifacts = state.artifacts || [];
  document.getElementById('panel-files').innerHTML = artifacts.length ? '<div class="task-board"><div class="task-grid">' + artifacts.slice().reverse().map(function(artifact) {
    return '<article class="task-card done"><div class="task-card-top"><span class="task-chip">' + escapeHtml(artifact.kind || 'file') + '</span><span class="task-state"><span class="task-state-dot done"></span>' + t('files') + '</span></div><h3>' + escapeHtml(artifact.path || artifact.name || 'artifact') + '</h3><p>' + escapeHtml(artifact.source || artifact.confidence || t('noDescription')) + '</p></article>';
  }).join('') + '</div></div>' : '<div class="task-board"><div class="task-empty">' + t('fileEmpty') + '</div></div>';
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
  const olderLine = hasOlder ? t('loadOlder') : t('noOlderMessages');
  schedulePendingReveal(rows);
  const visibleRows = rows.filter(shouldRenderChatMessage);
  function currentHumanName() {
    const user = window.__lastSummary && window.__lastSummary.currentUser;
    return user && (user.name || user.email || user.id) || 'you';
  }
  function currentHumanInitial() {
    const label = currentHumanName();
    return label ? label.slice(0, 1).toUpperCase() : 'U';
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
    const initial = message.author_kind === 'agent' ? 'A' : currentHumanInitial();
    const unreadClass = message.author_kind === 'human' && !(message.readBy || []).includes('king-ceo') ? ' highlight' : '';
    const pendingClass = message.status === 'pending' ? ' pending' : '';
    const bodyHtml = message.status === 'pending' ? '<span class="typing-dots"><span></span><span></span><span></span></span><span>' + escapeHtml(t('agentThinking')) + '</span>' : escapeHtml(message.body);
    return '<article class="post' + pendingClass + unreadClass + '"><div class="avatar">' + initial + '</div><div><div class="post-top"><span class="author">' + authorHtml(message) + '</span><span class="time">' + formatTime(message.created_at) + '</span></div><div class="post-body">' + bodyHtml + '</div></div></article>';
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
  if (!row || row.id === 'king-convo') return t('allWindow');
  return row.title || row.id;
}
function currentAgents() {
  const summary = window.__lastSummary || {};
  return summary.agents || summary.activeAgents || (summary.agent ? [summary.agent] : []);
}
function defaultTeamAgentIdsForUi() {
  return ['king-ceo', 'dev', 'reviewer'];
}
function selectedWindowMode() {
  const checked = document.querySelector('input[name="newWindowMode"]:checked');
  return checked ? checked.value : 'team';
}
function selectedTeamAgentIds() {
  const ids = Array.from(document.querySelectorAll('input[name="newWindowTeamAgent"]:checked')).map(function(input) {
    return input.value;
  });
  if (!ids.includes('king-ceo')) ids.unshift('king-ceo');
  return ids;
}
function rolePromptAgentsForMode(mode) {
  const agents = currentAgents();
  const ids = mode === 'single'
    ? ['king-ceo']
    : mode === 'custom'
      ? selectedTeamAgentIds()
      : defaultTeamAgentIdsForUi();
  const wanted = new Set(ids);
  return agents.filter(function(agent) { return wanted.has(agent.id); });
}
function renderRolePrompts() {
  const prompts = document.getElementById('newWindowRolePrompts');
  if (!prompts) return;
  const promptAgents = rolePromptAgentsForMode(selectedWindowMode());
  prompts.innerHTML = promptAgents.map(function(agent) {
    return '<label class="role-prompt"><span>' + escapeHtml(agent.name || agent.id) + '</span><textarea data-agent-role-id="' + escapeHtml(agent.id) + '">' + escapeHtml(agent.role || '') + '</textarea></label>';
  }).join('');
}
function renderAgentOptions() {
  const agents = currentAgents();
  const checks = document.getElementById('newWindowTeam');
  if (checks) {
    checks.innerHTML = agents.map(function(agent) {
      const fixed = agent.id === 'king-ceo';
      const checked = fixed || defaultTeamAgentIdsForUi().includes(agent.id) ? ' checked' : '';
      const disabled = fixed ? ' disabled' : '';
      return '<label class="agent-check"><input type="checkbox" name="newWindowTeamAgent" value="' + escapeHtml(agent.id) + '"' + checked + disabled + ' onchange="renderRolePrompts()" /><span>' + escapeHtml(agent.name || agent.id) + '</span></label>';
    }).join('');
  }
  renderRolePrompts();
}
function syncNewWindowMode() {
  const mode = selectedWindowMode();
  const custom = document.getElementById('newWindowCustomTeam');
  if (custom) custom.classList.toggle('hidden', mode !== 'custom');
  renderRolePrompts();
}
function selectedAgentRoles() {
  const roles = {};
  document.querySelectorAll('[data-agent-role-id]').forEach(function(input) {
    roles[input.getAttribute('data-agent-role-id')] = input.value;
  });
  return roles;
}
function setWindowMode(mode) {
  const option = document.querySelector('input[name="newWindowMode"][value="' + mode + '"]');
  if (option) option.checked = true;
  syncNewWindowMode();
}
function setTeamAgentChecks(ids) {
  const wanted = new Set(ids || []);
  document.querySelectorAll('input[name="newWindowTeamAgent"]').forEach(function(input) {
    input.checked = input.value === 'king-ceo' || wanted.has(input.value);
  });
  renderRolePrompts();
}
createConversation = function() {
  const input = document.getElementById('newWindowTitle');
  input.disabled = false;
  const title = document.querySelector('#newWindowDialog h2');
  if (title) title.textContent = t('newWindow');
  input.value = '';
  renderAgentOptions();
  setWindowMode('team');
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
  const mode = selectedWindowMode();
  const coordinatorAgentId = 'king-ceo';
  const teamAgentIds = mode === 'custom' ? selectedTeamAgentIds() : undefined;
  const agentRoles = selectedAgentRoles();
  const submit = document.getElementById('newWindowSubmit');
  submit.disabled = true;
  submit.textContent = t('sending');
  try {
    const result = await request('/gui/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, teamMode: mode, coordinatorAgentId, teamAgentIds, agentRoles })
    });
    activeConversationId = result.conversation.id;
    localStorage.setItem('king:activeConversationId', activeConversationId);
    visibleMessageCount = 20;
    shouldStickToBottom = true;
    input.disabled = false;
    closeNewWindowDialog();
    await refresh();
  } finally {
    submit.disabled = false;
    submit.textContent = t('create');
  }
};
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
function teamStatusClass(agent) {
  const active = (agent.status === 'running' || agent.status === 'thinking' || (agent.unreadMessages || 0) > 0 || (agent.openTasks || 0) > 0 || (agent.activeCards || 0) > 0);
  return active ? ' active' : '';
}
function renderTeamStrip(summary) {
  const team = summary.activeAgents || summary.agents || (summary.agent ? [summary.agent] : []);
  const strip = document.getElementById('teamStrip');
  if (!strip) return;
  const agentsHtml = team.map(function(agent) {
    const label = agent.name || agent.id || 'agent';
    const meta = 'u' + (agent.unreadMessages || 0) + ' t' + (agent.openTasks || 0);
    const title = label + ' · ' + (agent.status || 'idle') + ' · ' + meta;
    return '<div class="team-agent" title="' + escapeHtml(title) + '">' +
      '<span class="team-dot' + teamStatusClass(agent) + '"></span>' +
      '<span class="team-name">' + escapeHtml(label) + '</span>' +
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
  if (summary.pairingLocator) {
    pairCommandPrimary = 'king agent computer --pair ' + shellQuote(summary.pairingLocator);
    pairCommandStart = 'king agent computer';
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
  const meta = [card.ownerRole ? 'owner=' + card.ownerRole : '', card.decisionBy ? 'decideBy=' + card.decisionBy : ''].filter(Boolean).join(' · ');
  return '<article class="task-card pending decision-host">' +
    '<div class="task-card-top"><span class="task-chip">' + t('decisionSourceHost') + '</span><span class="task-state"><span class="task-state-dot pending"></span>' + t('decisionPending') + '</span></div>' +
    '<h3>' + escapeHtml(card.title || id) + '</h3>' +
    (card.detail ? '<p>' + escapeHtml(card.detail) + '</p>' : '') +
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
  const approvals = (state.approvals || []).slice().reverse();
  const hostCards = (hostResult && hostResult.cards) || [];
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
};
refresh = async function(options) {
  const results = await Promise.all([
    request('/gui/summary?conversationId=' + encodeURIComponent(activeConversationId)),
    request('/gui/state'),
    request('/gui/host-decisions').catch(function() { return { configured: false, cards: [] }; })
  ]);
  window.__lastState = results[1];
  window.__lastHostDecisions = results[2] || { cards: [] };
  renderSummary(results[0]);
  renderMessages(results[1], options || {});
  renderTasks(results[1]);
  renderDecisions(results[1], window.__lastHostDecisions);
};
applyLanguage();
refresh();
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
                <button onclick="openSettings()" data-i18n="settings">Settings</button>
              </div>
            </header>

            <div id="teamStrip" class="team-strip" aria-label="Agent team"></div>

            <nav class="tabs" aria-label="Channel views">
              <button class="tab active" data-panel="chat" onclick="showPanel('chat')" data-i18n="chat">Chat</button>
              <button class="tab" data-panel="tasks" onclick="showPanel('tasks')" data-i18n="tasks">Tasks</button>
              <button class="tab" data-panel="files" onclick="showPanel('files')" data-i18n="files">Files</button>
              <button class="tab" data-panel="decisions" onclick="showPanel('decisions')"><span data-i18n="decisions">Decisions</span><span class="tab-badge" id="decisionBadge" data-empty="1">0</span></button>
            </nav>

            <section class="workspace">
              <section id="panel-chat" class="panel active chat-panel">
                <div id="chatWindow" class="message-list"></div>
                <button class="jump" onclick="scrollToBottom()">↓ Back to bottom</button>
                <div class="composer">
                  <div class="composer-tools">
                    <button id="clearButton" onclick="clearMessages()" data-i18n="clearScreen">Clear</button>
                    <button onclick="refresh()" data-i18n="refresh">Refresh</button>
                  </div>
                  <textarea id="body" placeholder="Message #all"></textarea>
                  <button id="sendButton" class="primary" onclick="sendMessage()">Send</button>
                </div>
              </section>
              <section id="panel-tasks" class="panel tab-panel"></section>
              <section id="panel-files" class="panel tab-panel"></section>
              <section id="panel-decisions" class="panel tab-panel"></section>
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
              <div class="field">
                <label data-i18n="windowMode">Collaboration</label>
                <div class="mode-grid">
                  <label class="mode-option">
                    <input type="radio" name="newWindowMode" value="single" onchange="syncNewWindowMode()" />
                    <span class="mode-title" data-i18n="singleAgent">Single agent</span>
                    <span class="mode-desc" data-i18n="singleAgentDesc">Only the owner replies</span>
                  </label>
                  <label class="mode-option">
                    <input type="radio" name="newWindowMode" value="team" checked onchange="syncNewWindowMode()" />
                    <span class="mode-title" data-i18n="defaultTeam">Default team</span>
                    <span class="mode-desc" data-i18n="defaultTeamDesc">CEO + Dev + Reviewer</span>
                  </label>
                  <label class="mode-option">
                    <input type="radio" name="newWindowMode" value="custom" onchange="syncNewWindowMode()" />
                    <span class="mode-title" data-i18n="customTeam">Custom</span>
                    <span class="mode-desc" data-i18n="customTeamDesc">Choose roles</span>
                  </label>
                </div>
              </div>
              <div id="newWindowCustomTeam" class="field hidden">
                <label data-i18n="windowTeam">Roles</label>
                <div id="newWindowTeam" class="agent-checks"></div>
              </div>
              <div class="field">
                <label data-i18n="agentPrompts">Role prompts</label>
                <div id="newWindowRolePrompts" class="role-prompts"></div>
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
