export const guiPageEnhancementStyles = `
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
    dialog[open] {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    dialog[open] > .modal-body,
    dialog[open] > .modal-form > .modal-body,
    dialog[open] > .modal-form > .window-body,
    dialog[open] > .computer-flow {
      flex: 1 1 auto;
      min-height: 0;
      max-height: none;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    dialog[open] > .modal-form {
      min-height: 0;
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
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
    .ielts-core {
      display: inline;
      background: #dff3ee;
      border-bottom: 2px solid #2f7d69;
      padding: 0 3px;
      font-weight: 900;
    }
    .ielts-phrase {
      display: inline;
      background: #fff0a8;
      border-bottom: 2px solid #b28b00;
      padding: 0 3px;
      font-weight: 800;
    }
    .ielts-word {
      display: inline;
      border-bottom: 1px dotted #6b5b00;
      padding: 0 1px;
      cursor: pointer;
    }
    .ielts-word:hover {
      background: #fff8c7;
    }
    .vocab-dialog {
      width: min(360px, calc(100vw - 28px));
      border: 2px solid var(--line);
      border-radius: 0;
      padding: 0;
      box-shadow: 8px 8px 0 var(--line), var(--shadow);
    }
    .vocab-card {
      display: grid;
      gap: 10px;
      padding: 14px;
      background: var(--canvas);
    }
    .vocab-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border-bottom: 2px solid var(--line);
      padding-bottom: 8px;
    }
    .vocab-title {
      min-width: 0;
      font-size: 18px;
      font-weight: 900;
      overflow-wrap: anywhere;
    }
    .vocab-actions {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      gap: 6px;
    }
    .vocab-audio-button {
      width: 28px;
      min-width: 28px;
      min-height: 28px;
      height: 28px;
    }
    .vocab-row {
      display: grid;
      grid-template-columns: 74px minmax(0, 1fr);
      gap: 8px;
      align-items: baseline;
    }
    .vocab-row[hidden] {
      display: none;
    }
    .vocab-label {
      color: var(--muted);
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .vocab-value {
      min-width: 0;
      overflow-wrap: anywhere;
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
	    .attachment-tray {
	      display: inline-flex;
	      align-items: baseline;
	      gap: 5px;
	      flex-wrap: wrap;
	      min-width: 0;
	    }
	    .attachment-tray:empty {
	      display: none;
	    }
	    .message-attachments {
	      display: flex;
	      flex-direction: column;
	      align-items: flex-start;
	      gap: 8px;
	      margin-top: 8px;
	      min-width: 0;
	      max-width: 100%;
	    }
	    .message-attachments:empty {
	      display: none;
	    }
	    .attachment-previews {
	      display: flex;
	      flex-wrap: wrap;
	      gap: 8px;
	      max-width: 100%;
	    }
	    .attachment-preview {
	      margin: 0;
	      max-width: min(360px, 100%);
	    }
	    .attachment-preview-link {
	      display: block;
	      position: relative;
	      border: 1px solid var(--line);
	      background: var(--panel);
	      line-height: 0;
	      overflow: hidden;
	    }
	    .attachment-preview-link.is-loading {
	      min-height: 180px;
	      width: min(280px, 100%);
	    }
	    .attachment-preview-placeholder {
	      display: none;
	    }
	    .attachment-preview-link.is-loading .attachment-preview-placeholder {
	      display: flex;
	      align-items: center;
	      justify-content: center;
	      position: absolute;
	      inset: 0;
	      background: linear-gradient(110deg, var(--panel) 8%, #fff 18%, var(--panel) 33%);
	      background-size: 200% 100%;
	      animation: attachmentPreviewShimmer 1.2s linear infinite;
	    }
	    .attachment-preview-link.is-loading .attachment-preview-placeholder::after {
	      content: '';
	      width: 22px;
	      height: 22px;
	      border: 2px solid var(--soft-line);
	      border-top-color: var(--muted);
	      border-radius: 50%;
	      animation: attachmentPreviewSpin 0.8s linear infinite;
	    }
	    .attachment-preview-image {
	      display: block;
	      max-width: 100%;
	      max-height: 280px;
	      width: auto;
	      height: auto;
	      object-fit: contain;
	      background: var(--canvas);
	    }
	    .attachment-preview-link.is-loading .attachment-preview-image {
	      opacity: 0;
	    }
	    .attachment-preview-link.is-loaded .attachment-preview-image {
	      opacity: 1;
	    }
	    @keyframes attachmentPreviewShimmer {
	      0% { background-position: 200% 0; }
	      100% { background-position: -200% 0; }
	    }
	    @keyframes attachmentPreviewSpin {
	      to { transform: rotate(360deg); }
	    }
	    .attachment-preview-meta {
	      display: flex;
	      align-items: baseline;
	      gap: 6px;
	      margin-top: 4px;
	      font-size: 11px;
	      color: var(--muted);
	      line-height: 1.35;
	    }
	    .attachment-preview-name {
	      overflow: hidden;
	      text-overflow: ellipsis;
	      white-space: nowrap;
	      max-width: 220px;
	      font-weight: 700;
	      color: var(--ink);
	    }
	    .attachment-files {
	      display: inline-flex;
	      align-items: baseline;
	      gap: 5px;
	      flex-wrap: wrap;
	      min-width: 0;
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
    .run-indicator {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      color: var(--muted);
      white-space: nowrap;
      user-select: none;
    }
    .run-indicator .run-dot {
      width: 8px;
      height: 8px;
      flex: 0 0 auto;
      border: 1px solid var(--line);
      background: var(--muted);
    }
    .run-indicator.running {
      color: #5c9f96;
    }
    .run-indicator.running .run-dot {
      background: #5c9f96;
      animation: kingRunPulse 1s infinite ease-in-out;
    }
    @keyframes kingRunPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
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
    .mode-option.unavailable {
      opacity: 0.52;
      cursor: not-allowed;
      background: #f7f7f7;
    }
    .mode-option.unavailable:has(input:checked) {
      background: #f7f7f7;
      box-shadow: none;
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
      padding: 10px 0 196px;
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
      grid-template-areas:
        "tools tools"
        "main send";
      align-items: stretch;
      gap: 8px;
      padding: 10px;
    }
    body.mobile-layout .composer-tools {
      position: static;
      grid-area: tools;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 6px 8px;
      align-items: center;
      padding-bottom: 8px;
      margin-bottom: 2px;
      border-bottom: 1px solid var(--line);
      background: transparent;
    }
    body.mobile-layout .composer-main {
      grid-area: main;
    }
    body.mobile-layout .composer-tools .jump.visible {
      grid-column: 1 / -1;
      justify-content: center;
    }
    body.mobile-layout .run-indicator .run-label {
      display: none;
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
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 122px;
      border: 1px solid var(--soft-line);
      background: #fff8df;
      padding: 12px;
    }
    .task-card-action {
      width: 100%;
      min-height: 0;
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
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
      margin-top: auto;
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
    .file-card {
      min-height: 0;
      background: #fff;
      padding: 10px;
    }
    .file-card .task-card-action {
      display: grid;
      grid-template-columns: 38px minmax(0, 1fr);
      gap: 10px;
      cursor: default;
    }
    .file-card-icon {
      position: relative;
      width: 34px;
      height: 42px;
      border: 2px solid var(--line);
      background: #fff;
      box-shadow: 2px 2px 0 var(--accent);
    }
    .file-card-icon::before {
      content: "";
      position: absolute;
      top: -2px;
      right: -2px;
      width: 12px;
      height: 12px;
      border-left: 2px solid var(--line);
      border-bottom: 2px solid var(--line);
      background: var(--canvas);
    }
    .file-card-icon::after {
      content: "";
      position: absolute;
      left: 7px;
      right: 7px;
      bottom: 9px;
      height: 2px;
      background: var(--soft-line);
      box-shadow: 0 -7px 0 var(--soft-line);
    }
    .file-card-main {
      display: grid;
      gap: 7px;
      min-width: 0;
    }
    .file-card h3 {
      font-size: 14px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .file-card h3 a {
      color: var(--ink);
      text-decoration-thickness: 1px;
      text-underline-offset: 2px;
    }
    .file-card h3 a:hover {
      color: #2f6f68;
    }
    .file-card-meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 900;
    }
    .file-card-meta span + span::before {
      content: "/";
      padding-right: 5px;
      color: var(--soft-line);
    }
    .file-card .task-card-top {
      align-items: flex-start;
      gap: 8px;
    }
    .file-card .task-chip {
      max-width: calc(100% - 62px);
      padding: 3px 7px;
    }
    .file-card .task-card-footer {
      padding-left: 48px;
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
      grid-area: send;
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
    body.mobile-layout .file-card {
      padding: 9px;
    }
    body.mobile-layout .file-card .task-card-action {
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 9px;
    }
    body.mobile-layout .file-card-icon {
      width: 30px;
      height: 38px;
    }
    body.mobile-layout .file-card .task-card-footer {
      padding-left: 43px;
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
