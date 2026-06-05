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
    .assist-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }
    .assist-link {
      min-height: 34px;
      border: 1px solid var(--line);
      background: #080808;
      color: #a7d66d;
      padding: 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
    }
    .assist-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .danger-card {
      border-color: #d65252;
      background: #fff8f8;
    }
    .danger-card h2 {
      color: #b32929;
    }
    .danger-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .danger-button {
      background: #d65252;
      color: #fff;
      border-color: #8f1f1f;
    }
    .danger-button:hover {
      background: #b32929;
    }
    .danger-button:disabled {
      opacity: 0.68;
      cursor: wait;
    }
    .danger-status {
      min-height: 18px;
      color: #b32929;
      font-size: 11px;
      font-weight: 900;
    }
    .remote-device-list {
      display: grid;
      gap: 6px;
      max-height: 160px;
      overflow: auto;
    }
    .remote-device-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 6px;
      align-items: center;
      border: 1px solid var(--line);
      background: #fff;
      padding: 6px;
    }
    .remote-device-main {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .remote-device-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 900;
    }
    .remote-device-meta {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .remote-device-form {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .remote-config-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .remote-device-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .remote-device-form textarea {
      width: 100%;
      max-width: 100%;
      box-sizing: border-box;
      min-height: 260px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      overflow-x: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .remote-device-form textarea#remoteConfigJson {
      min-height: 360px;
    }
    .remote-output {
      min-height: 28px;
      max-height: 140px;
      overflow: auto;
      border: 1px solid var(--soft-line);
      background: #080808;
      color: #a7d66d;
      padding: 7px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10px;
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
    .post-body {
      color: var(--body);
      line-height: 1.45;
      word-break: break-word;
    }
    .post-body.plain { white-space: pre-wrap; }
    .post-body.markdown-body {
      display: grid;
      gap: 7px;
      white-space: normal;
    }
    .post-body.markdown-body > * { margin: 0; }
    .post-body.markdown-body ul,
    .post-body.markdown-body ol {
      display: grid;
      gap: 3px;
      padding-left: 20px;
    }
    .post-body.markdown-body blockquote {
      border-left: 3px solid var(--soft-line);
      padding-left: 10px;
      color: var(--muted);
    }
    .post-body.markdown-body pre,
    .post-body.markdown-body code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
    }
    .post-body.markdown-body pre {
      overflow: auto;
      max-width: 100%;
      border: 1px solid var(--soft-line);
      background: var(--panel);
      padding: 8px;
      white-space: pre;
    }
    .post-body.markdown-body code {
      background: var(--panel);
      border: 1px solid var(--soft-line);
      padding: 1px 3px;
    }
    .post-body.markdown-body pre code {
      border: 0;
      padding: 0;
      background: transparent;
    }
    .post-body.markdown-body table {
      display: block;
      width: max-content;
      max-width: 100%;
      overflow: auto;
      border-collapse: collapse;
    }
    .post-body.markdown-body th,
    .post-body.markdown-body td {
      border: 1px solid var(--soft-line);
      padding: 4px 6px;
    }
    .post-body.markdown-body a {
      color: #0b6bcb;
      font-weight: 800;
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
      grid-template-columns: auto minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 6px;
      min-width: 166px;
      max-width: 240px;
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
    .team-dot.active { background: #5c9f96; }
    .team-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .team-status {
      color: #5c9f96;
      font-size: 10px;
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
    .main {
      grid-template-rows: auto auto auto minmax(0, 1fr);
    }
    .workspace {
      min-width: 0;
      overflow-x: hidden;
    }
	    .composer {
	      left: 196px;
	      padding-top: 10px;
	    }
	    #sendButton {
	      align-self: end;
	      width: 54px;
	      min-width: 54px;
	      height: 54px;
	      min-height: 54px;
	      padding: 0 8px;
	    }
	    .composer-main {
	      display: grid;
	      gap: 6px;
	      min-width: 0;
	    }
	    .attachment-tray,
	    .message-attachments {
	      display: inline-flex;
	      align-items: baseline;
	      gap: 5px;
	      flex-wrap: wrap;
	      min-width: 0;
	    }
	    .attachment-tray:empty,
	    .message-attachments:empty {
	      display: none;
	    }
	    .message-attachments {
	      margin-top: 2px;
	    }
	    .attachment-token {
	      display: inline-flex;
	      align-items: baseline;
	      gap: 4px;
	      max-width: min(320px, 100%);
	      color: var(--line);
	      background: var(--accent);
	      border: 1px solid var(--line);
	      padding: 1px 5px;
	      font-size: 12px;
	      font-weight: 900;
	      line-height: 1.35;
	      text-decoration: none;
	    }
	    .attachment-token span {
	      overflow: hidden;
	      text-overflow: ellipsis;
	      white-space: nowrap;
	    }
	    .attachment-token .attachment-size {
	      color: var(--muted);
	      font-size: 10px;
	      text-decoration: none;
	    }
	    .attachment-remove {
	      min-width: 18px;
	      width: 18px;
	      min-height: 18px;
	      padding: 0;
	      line-height: 1;
	      background: var(--canvas);
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
    .composer-tools .jump {
      position: static;
      display: none;
      width: auto;
      margin: 0;
      box-shadow: none;
    }
    .composer-tools .jump.visible {
      display: inline-flex;
    }
	    .composer-tools button {
	      min-height: 24px;
	      padding: 3px 8px;
	      font-size: 11px;
	    }
	    .composer-file-input {
	      display: none;
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
    .modal-body.window-body {
      gap: 16px;
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
      padding: 10px 0 156px;
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
      position: absolute;
      bottom: calc(100% + 8px);
      right: 0;
      justify-content: flex-end;
      background: var(--canvas);
    }
    #panel-tasks.tab-panel,
    #panel-files.tab-panel,
    #panel-decisions.tab-panel {
      width: 100%;
      max-width: none;
      min-width: 0;
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
      min-width: 0;
      max-width: 100%;
      min-height: 0;
      padding: 24px 18px 40px;
      align-content: start;
      overflow-x: hidden;
    }
    .task-board-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      width: 100%;
      max-width: 100%;
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
      grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
      gap: 10px;
      width: 100%;
      max-width: 100%;
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
    .task-card-action {
      width: 100%;
      min-height: 0;
      display: grid;
      gap: 8px;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }
    .task-card-action:hover {
      background: transparent;
    }
    .task-card-action:focus-visible {
      outline: 2px solid var(--line);
      outline-offset: 3px;
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
    .task-card-footer {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 8px;
      margin-top: 2px;
    }
    .task-chat-open {
      min-height: 24px;
      padding: 3px 8px;
      border-color: var(--soft-line);
      background: #fff;
      color: var(--ink);
      font-size: 11px;
      font-weight: 900;
    }
    .task-chat-dialog {
      width: min(820px, calc(100vw - 24px));
    }
    .task-chat-title {
      display: grid;
      gap: 3px;
      min-width: 0;
    }
    .task-chat-title h2 {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .task-chat-subtitle {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10px;
      font-weight: 800;
    }
    .task-chat-body {
      display: block;
      padding: 14px 18px 18px;
      max-height: min(620px, calc(100vh - 118px));
      background: var(--canvas);
    }
    .task-chat-body .message-list {
      display: grid;
      gap: 11px;
      width: 100%;
      padding: 0;
    }
    .task-chat-body .post {
      padding: 8px;
      border: 1px solid transparent;
    }
    .task-chat-body .system-line {
      text-align: center;
      padding: 4px 0;
    }
    .task-empty {
      display: grid;
      place-items: start center;
      width: 100%;
      max-width: 100%;
      min-height: 120px;
      padding-top: 42px;
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
    body.mobile-layout #sendButton {
      height: 54px;
      min-height: 54px;
      padding: 0 8px;
    }
    body.mobile-layout .composer-tools button {
      min-height: 28px;
      padding: 4px 10px;
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
    body.mobile-layout .task-card-action {
      gap: 7px;
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
    body.mobile-layout .task-chat-dialog {
      width: calc(100vw - 12px);
    }
    body.mobile-layout .task-chat-body {
      max-height: calc(100vh - 92px);
    }
    body.mobile-layout dialog {
      width: calc(100vw - 22px);
      max-height: calc(100vh - 22px);
    }
    body.mobile-layout .modal-body,
    body.mobile-layout .computer-flow {
      padding: 16px;
    }
    body.mobile-layout .assist-row {
      grid-template-columns: 1fr;
    }
  `;
  const enhancementScript = `
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}
const ASSIST_PARAMS = new URLSearchParams(location.search);
const assistToken = ASSIST_PARAMS.get('assist') || '';
const assistTenant = ASSIST_PARAMS.get('tenant') || '';
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
    hostBridgeMissing: '未配置 KING_HOST_URL，无法连接本机 host server。',
    createAssistLink: '生成链接',
    revokeAssistLink: '撤销链接',
    assistNoLink: '尚未生成远程协助链接',
    assistActive: '链接已启用，可多人使用。',
    assistCopyUnavailable: '完整链接只会在生成时显示；请重新生成链接后复制。',
    dataResetTitle: '重新开始',
    dataResetDesc: '清除当前账号下的所有窗口、消息、任务、文件、决策、配对信息和运行记录。操作后会生成新的配对码。',
    dataResetButton: '清除当前账号数据',
    dataResetConfirm: '再次点击确认清除',
    dataResetting: '正在清除...',
	    dataResetDone: '已清除，可以重新开始。',
	    dataResetFailed: '清除失败，请稍后重试。',
	    attachFile: '添加附件',
	    attachments: '附件',
	    removeAttachment: '移除',
	    newWindow: '新窗口',
    windowName: '名称',
    windowMode: '协作方式',
    singleAgent: '单 Agent',
    singleAgentDesc: '只让负责人回复',
    defaultTeam: '默认团队',
    defaultTeamDesc: '7 个 agent',
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
    meetKing: '认识 King',
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
    hostBridgeMissing: 'KING_HOST_URL is not configured; local host server is unavailable.',
    createAssistLink: 'Create link',
    revokeAssistLink: 'Revoke link',
    assistNoLink: 'No remote assist link yet',
    assistActive: 'Link enabled; multiple people can use it.',
    assistCopyUnavailable: 'The full link is only shown when created. Create a new link to copy it.',
    dataResetTitle: 'Start over',
    dataResetDesc: 'Clear all windows, messages, tasks, files, decisions, pairing info, and run history for the current account. A new pairing code will be generated.',
    dataResetButton: 'Clear current account data',
    dataResetConfirm: 'Click again to confirm',
    dataResetting: 'Clearing...',
	    dataResetDone: 'Cleared. You can start over.',
	    dataResetFailed: 'Clear failed. Try again.',
	    attachFile: 'Attach',
	    attachments: 'Attachments',
	    removeAttachment: 'Remove',
	    newWindow: 'New Window',
    windowName: 'Name',
    windowMode: 'Collaboration',
    singleAgent: 'Single agent',
    singleAgentDesc: 'Only the owner replies',
    defaultTeam: 'Default team',
    defaultTeamDesc: '7 agents',
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
    meetKing: 'Meet King',
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
  if (assistToken) headers.set('X-King-Assist-Token', assistToken);
  if (assistTenant) headers.set('X-King-Tenant', assistTenant);
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
	async function uploadPendingAttachments() {
	  const uploaded = [];
	  for (const file of pendingAttachments) {
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
	const REMOTE_ASSIST_URL_KEY = 'king:remoteAssistUrl';
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
    activeConversationId = 'king-convo';
    localStorage.setItem('king:activeConversationId', activeConversationId);
    localStorage.removeItem('king:taskFilter');
    localStorage.removeItem('king:addComputerDismissed');
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
async function loadRemoteConfig() {
  const listEl = document.getElementById('remoteDeviceList');
  const statusEl = document.getElementById('remoteDeviceStatus');
  const configEl = document.getElementById('remoteConfigJson');
  if (!listEl || !statusEl) return;
  showRemoteOutput('');
  try {
    const response = await request('/gui/remote-config');
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
    const response = await request('/gui/remote-devices');
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
    const response = await request('/gui/remote-config', {
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
  const response = await request('/gui/remote-devices/' + encodeURIComponent(id) + '/probe', { method: 'POST' });
  showRemoteOutput(response.result?.text || response.error || '');
}
async function profileRemoteDevice(id) {
  showRemoteOutput(t('saving'));
  const response = await request('/gui/remote-devices/' + encodeURIComponent(id) + '/profile', { method: 'POST' });
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
  const typing = (state.typingLog || []).slice().reverse().find(function(row) { return row.conversationId === active.id && !row.done; });
  const thinking = (state.thinkingLog || []).slice().reverse().find(function(row) { return row.action === 'mark' && (row.conversationIds || []).includes(active.id); });
  if (typing) return t('agentTyping');
  if (thinking) return t('agentThinking');
  if ((active.unread || 0) > 0) return t('waitingAgent');
  return '';
};
function agentDisplayName(summary, id) {
  const agents = summary.agents || [];
  const agent = agents.find(function(row) { return row.id === id; });
  return agent && (agent.name || agent.id) || id;
}
let taskFilterMode = localStorage.getItem('king:taskFilter') || 'all';
function setTaskFilter(mode) {
  taskFilterMode = mode === 'done' || mode === 'active' ? mode : 'all';
  localStorage.setItem('king:taskFilter', taskFilterMode);
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
  return (state.messages || []).filter(function(message) {
    if (message.conversation_id !== task.conversationId) return false;
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
  const task = (state.tasks || []).find(function(row) { return row.id === taskId; });
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
  return !activeConversationId || activeConversationId === 'king-convo';
}
function taskMatchesConversation(task) {
  if (isAllConversationView()) return true;
  return task && task.conversationId === activeConversationId;
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
  const tasks = allTasks.filter(taskMatchesConversation);
  const tasksById = taskByIdMap(allTasks);
  document.getElementById('taskBadge').textContent = String(tasks.filter(function(task) { return task.status !== 'done'; }).length);
  document.getElementById('panel-tasks').innerHTML = taskBoardHtml(tasks);
  const artifacts = (state.artifacts || []).filter(function(artifact) { return artifactMatchesConversation(artifact, tasksById); });
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
	  const attachmentsToSend = pendingAttachments.slice();
	  if (!body && !attachmentsToSend.length) return;
	  sendingMessage = true;
	  input.value = '';
	  input.blur();
	  button.disabled = true;
	  button.textContent = t('sending');
	  try {
	    const attachments = await uploadPendingAttachments();
	    await request('/gui/message', {
	      method: 'POST',
	      headers: { 'Content-Type': 'application/json' },
	      body: JSON.stringify({ body: body || t('attachments'), conversationId: activeConversationId, attachments })
	    });
	    pendingAttachments = [];
	    renderAttachmentTray();
	    visibleMessageCount = 20;
	    shouldStickToBottom = true;
	    await refresh();
	  } catch (error) {
	    input.value = body;
	    pendingAttachments = attachmentsToSend;
	    renderAttachmentTray();
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
    const unreadClass = message.author_kind === 'human' && !(message.readBy || []).includes('king-ceo') ? ' highlight' : '';
    const pendingClass = message.status === 'pending' ? ' pending' : '';
    const renderedBody = message.body_html || '';
    const bodyHtml = message.status === 'pending' ? '<span class="typing-dots"><span></span><span></span><span></span></span><span>' + escapeHtml(t('agentThinking')) + '</span>' : (renderedBody || escapeHtml(message.body));
    const bodyClass = renderedBody && message.status !== 'pending' ? 'post-body markdown-body' : 'post-body plain';
	    return '<article class="post' + pendingClass + unreadClass + '"><div class="avatar">' + escapeHtml(initial) + '</div><div><div class="post-top"><span class="author">' + authorHtml(message) + '</span><span class="time">' + formatTime(message.created_at) + '</span></div><div class="' + bodyClass + '">' + bodyHtml + '</div>' + attachmentListHtml(message.attachments) + '</div></article>';
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
function renderAgentOptions() {
  const agents = currentAgents();
  const checks = document.getElementById('newWindowTeam');
  if (checks) {
    checks.innerHTML = agents.map(function(agent) {
      const fixed = agent.id === 'king-ceo';
      const checked = fixed ? ' checked' : '';
      const disabled = fixed ? ' disabled' : '';
      return '<label class="agent-check"><input type="checkbox" name="newWindowTeamAgent" value="' + escapeHtml(agent.id) + '"' + checked + disabled + ' /><span>' + escapeHtml(agent.name || agent.id) + '</span></label>';
    }).join('');
  }
}
function syncNewWindowMode() {
  const mode = selectedWindowMode();
  const custom = document.getElementById('newWindowCustomTeam');
  if (custom) custom.classList.toggle('hidden', mode !== 'custom');
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
  const submit = document.getElementById('newWindowSubmit');
  submit.disabled = true;
  submit.textContent = t('sending');
  try {
    const result = await request('/gui/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, teamMode: mode, coordinatorAgentId, teamAgentIds })
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
  const tasksById = taskByIdMap(state.tasks || []);
  const approvals = (state.approvals || []).filter(function(approval) { return approvalMatchesConversation(approval, tasksById); }).slice().reverse();
  const hostCards = isAllConversationView() ? ((hostResult && hostResult.cards) || []) : [];
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
                  <div class="channel-desc" id="routeSummary"></div>
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
                <div class="composer">
	                  <div class="composer-tools">
	                    <button class="jump" onclick="scrollToBottom()" data-i18n="backToBottom">↓ Back to bottom</button>
	                    <button onclick="openAttachmentPicker()" data-i18n="attachFile">Attach</button>
	                    <button id="clearButton" onclick="clearMessages()" data-i18n="clearScreen">Clear</button>
	                    <button onclick="refresh()" data-i18n="refresh">Refresh</button>
	                  </div>
	                  <div class="composer-main">
	                    <div id="attachmentTray" class="attachment-tray"></div>
	                    <textarea id="body" placeholder="Message #all"></textarea>
	                  </div>
	                  <input id="attachmentInput" class="composer-file-input" type="file" multiple onchange="handleAttachmentFiles(this)" />
	                  <button id="sendButton" class="primary" onclick="sendMessage()">Send</button>
	                </div>
              </section>
              <section id="panel-tasks" class="panel tab-panel"></section>
              <section id="panel-files" class="panel tab-panel"></section>
              <section id="panel-decisions" class="panel tab-panel"></section>
            </section>
          </section>
        </main>

        <dialog id="taskChatDialog" class="task-chat-dialog">
          <div class="modal-head">
            <div class="task-chat-title">
              <h2 id="taskChatTitle" data-i18n="taskChatTitle">Task chat history</h2>
              <div id="taskChatSubtitle" class="task-chat-subtitle"></div>
            </div>
            <button class="icon" onclick="closeTaskChat()" aria-label="Close task chat">x</button>
          </div>
          <div id="taskChatBody" class="modal-body task-chat-body"></div>
        </dialog>

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
            <section class="side-card">
              <h2 data-i18n="remoteDevices">Remote Test Devices</h2>
              <p class="muted" data-i18n="remoteDevicesDesc">Configure test machines agents may use for logs, database records, Redis state, and statistics.</p>
              <div id="remoteDeviceList" class="remote-device-list"></div>
              <div class="remote-device-form">
                <div class="field">
                  <label for="remoteConfigJson" data-i18n="remoteConfigJson">JSON config</label>
                  <textarea id="remoteConfigJson" spellCheck={false}></textarea>
                </div>
                <div class="remote-config-actions">
                  <button class="button-shadow" onclick="loadRemoteConfig()" data-i18n="loadRemoteConfig">Load current config</button>
                  <button class="button-shadow" onclick="copyRemoteConfig()" data-i18n="copyRemoteConfig">Copy JSON</button>
                  <button class="primary-pink button-shadow" onclick="saveRemoteConfig()" data-i18n="saveRemoteConfig">Save JSON config</button>
                </div>
                <div id="remoteDeviceOutput" class="remote-output" hidden></div>
                <div id="remoteDeviceStatus" class="apply-status"></div>
              </div>
            </section>
            <section class="side-card">
              <h2 data-i18n="remoteAssist">Remote Assist</h2>
              <p class="muted" data-i18n="remoteAssistDesc">Create one reusable remote assist link so teammates can chat, view tasks, and resolve decisions in this workspace. The link stays valid until revoked.</p>
              <div class="assist-row">
                <div id="assistLink" class="assist-link">No remote assist link yet</div>
                <button id="copyAssistButton" class="button-shadow" onclick="copyRemoteAssistLink(this)" data-i18n="copy">Copy</button>
              </div>
              <div id="assistStatus" class="apply-status"></div>
              <div class="assist-actions">
                <button id="revokeAssistButton" class="button-shadow" onclick="revokeRemoteAssistLink()" data-i18n="revokeAssistLink">Revoke link</button>
                <button id="createAssistButton" class="primary-pink button-shadow" onclick="createRemoteAssistLink()" data-i18n="createAssistLink">Create link</button>
              </div>
            </section>
            <section class="side-card danger-card">
              <h2 data-i18n="dataResetTitle">Start over</h2>
              <p class="muted" data-i18n="dataResetDesc">Clear all windows, messages, tasks, files, decisions, pairing info, and run history for the current account. A new pairing code will be generated.</p>
              <div id="resetAccountStatus" class="danger-status"></div>
              <div class="danger-actions">
                <button id="resetAccountButton" class="danger-button button-shadow" onclick="resetCurrentAccountData()" data-i18n="dataResetButton">Clear current account data</button>
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
            <div class="modal-body window-body">
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
                    <span class="mode-desc" data-i18n="defaultTeamDesc">7 agents</span>
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
