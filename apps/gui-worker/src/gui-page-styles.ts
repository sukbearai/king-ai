export const guiPageStyles = `    :root {
      --accent: #ffd633;
      --rail: #ffd83d;
      --sidebar: #fbf4e6;
      --active: #f15b93;
      --canvas: #ffffff;
      --panel: #fffaf0;
      --line: #111111;
      --soft-line: #d7d1c5;
      --ink: #171717;
      --body: #303030;
      --muted: #7d7a73;
      --avatar: #c8b6ff;
      --shadow: rgba(17,17,17,0.16) 0 14px 36px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--canvas);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      line-height: 1.35;
      overflow: hidden;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 17px; line-height: 1.1; }
    h2 { font-size: 15px; line-height: 1.2; }
    h3 { font-size: 13px; line-height: 1.2; }
    p { color: var(--body); }
    button, textarea, select, input { font: inherit; }
    * {
      scrollbar-width: thin;
      scrollbar-color: var(--line) var(--accent);
    }
    *::-webkit-scrollbar {
      width: 13px;
      height: 13px;
    }
    *::-webkit-scrollbar-track {
      background: var(--accent);
      border-left: 1px solid var(--line);
    }
    *::-webkit-scrollbar-thumb {
      background: var(--line);
      border: 3px solid var(--accent);
    }
    *::-webkit-scrollbar-corner { background: var(--accent); }
    button {
      min-height: 27px;
      border: 1px solid var(--line);
      border-radius: 0;
      padding: 4px 9px;
      background: var(--canvas);
      color: var(--ink);
      font-weight: 800;
      cursor: pointer;
    }
    button:hover, button.primary { background: var(--accent); }
    button.icon {
      width: 27px;
      min-width: 27px;
      padding: 0;
      display: grid;
      place-items: center;
    }
    textarea, input, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 0;
      background: var(--canvas);
      color: var(--ink);
      padding: 8px;
    }
    textarea {
      min-height: 54px;
      resize: vertical;
      line-height: 1.45;
    }
    label {
      color: var(--muted);
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .app {
      height: 100vh;
      min-height: 100vh;
      display: grid;
      grid-template-columns: 42px 180px minmax(0, 1fr);
      background: var(--canvas);
    }
    .rail {
      display: grid;
      grid-template-rows: auto 1fr;
      gap: 12px;
      border-right: 2px solid var(--line);
      background: var(--rail);
      padding: 8px 6px;
    }
    .logo {
      width: 27px;
      display: grid;
      grid-template-columns: 1fr;
      gap: 6px;
    }
    .logo span {
      width: 27px;
      height: 27px;
      display: grid;
      place-items: center;
      background: var(--line);
      color: var(--accent);
      font-size: 10px;
      font-weight: 900;
    }
    .rail .icon { background: transparent; border-color: transparent; }
    .rail .icon.active { background: var(--canvas); border-color: var(--line); }
    .windows {
      min-width: 0;
      border-right: 2px solid var(--line);
      background: var(--sidebar);
      padding: 8px 6px;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 8px;
    }
    .windows-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 2px 8px;
      border-bottom: 1px solid var(--soft-line);
      font-weight: 900;
    }
    .window-list {
      min-height: 0;
      overflow: auto;
      display: grid;
      align-content: start;
      gap: 5px;
    }
    .window-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 6px;
      align-items: center;
      min-height: 32px;
      padding: 5px 6px;
      border: 1px solid transparent;
      background: transparent;
      text-align: left;
      font-weight: 800;
    }
    .window-select {
      min-width: 0;
      min-height: 0;
      padding: 0;
      border: 0;
      background: transparent;
      text-align: left;
      font-weight: 900;
    }
    .window-item.active {
      border-color: var(--line);
      background: var(--active);
    }
    .window-delete {
      width: 18px;
      min-width: 18px;
      min-height: 18px;
      padding: 0;
      border-color: var(--line);
      background: var(--canvas);
      color: var(--line);
      line-height: 1;
    }
    .window-delete:hover { background: var(--accent); }
    .window-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .window-meta {
      color: var(--muted);
      font-size: 10px;
      font-weight: 900;
    }
    .sidebar {
      display: none;
      min-width: 0;
      border-right: 2px solid var(--line);
      background: var(--sidebar);
      padding: 9px 5px;
      overflow: hidden;
    }
    .side-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0 4px 11px;
      border-bottom: 1px solid var(--soft-line);
      margin-bottom: 8px;
    }
    .side-section { display: grid; gap: 3px; margin: 12px 0; }
    .side-label {
      padding: 0 7px;
      color: var(--muted);
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .side-link, .channel {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 25px;
      padding: 4px 6px;
      border: 1px solid transparent;
      color: var(--body);
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
    }
    .channel.active {
      background: var(--active);
      border-color: var(--line);
      color: var(--line);
      font-weight: 900;
    }
    .badge { color: var(--muted); font-size: 10px; font-weight: 900; }
    .main {
      min-width: 0;
      min-height: 0;
      height: 100vh;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
    }
    .topbar {
      height: 38px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      border-bottom: 2px solid var(--line);
      padding: 6px 12px;
    }
    .channel-head {
      display: grid;
      grid-template-columns: 21px minmax(0, auto);
      gap: 8px;
      align-items: center;
      min-width: 0;
    }
    .hash {
      width: 21px;
      height: 21px;
      display: grid;
      place-items: center;
      background: var(--accent);
      border: 1px solid var(--line);
      font-weight: 900;
    }
    .channel-name { font-weight: 900; line-height: 1; }
    .channel-desc {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .top-actions { display: flex; gap: 6px; }
    .tabs {
      height: 24px;
      display: flex;
      align-items: stretch;
      border-bottom: 2px solid var(--line);
    }
    .tab {
      min-height: 0;
      padding: 3px 12px;
      border-width: 0 1px 0 0;
      background: var(--canvas);
      font-size: 11px;
    }
    .tab.active { background: var(--accent); }
    .workspace {
      min-height: 0;
      overflow: auto;
      background: var(--canvas);
    }
    .panel { display: none; min-height: 100%; }
    .panel.active { display: block; }
    .chat-panel {
      position: relative;
      min-height: 100%;
      padding: 14px 0 124px;
    }
    .message-list {
      display: grid;
      gap: 11px;
      width: 100%;
      padding: 0 18px;
    }
    .system-line {
      color: #aaa49a;
      font-size: 10px;
      text-align: center;
      padding: 4px 0;
    }
    .post {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 8px;
      padding: 8px;
      border: 1px solid transparent;
    }
    .post.highlight { border-color: var(--line); }
    .avatar {
      width: 22px;
      height: 22px;
      display: grid;
      place-items: center;
      border: 1px solid var(--line);
      background: var(--avatar);
      color: var(--line);
      font-size: 12px;
      font-weight: 900;
    }
    .post-top {
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
      margin-bottom: 3px;
    }
    .author { font-weight: 900; }
    .time { color: var(--muted); font-size: 10px; white-space: nowrap; }
    .tts-button {
      width: 22px;
      height: 22px;
      padding: 0;
      color: var(--muted);
    }
    .tts-button[data-tts-state="loading"] {
      color: var(--accent);
    }
    .tts-button[data-tts-state="loading"] svg {
      animation: tts-spin 0.8s linear infinite;
    }
    .tts-button[data-tts-state="playing"] {
      color: var(--accent);
      background: var(--active);
    }
    .tts-button[data-tts-state="error"] {
      color: #b42318;
      background: #fff1f0;
    }
    .tts-button svg {
      width: 12px;
      height: 12px;
      display: block;
      fill: currentColor;
    }
    @keyframes tts-spin {
      to { transform: rotate(360deg); }
    }
    .tts-notice {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 80;
      max-width: min(360px, calc(100vw - 36px));
      padding: 9px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--body);
      box-shadow: 0 12px 28px rgba(15, 23, 42, 0.14);
      font-size: 13px;
      line-height: 1.35;
      opacity: 0;
      pointer-events: none;
      transform: translateY(8px);
      transition: opacity 0.16s ease, transform 0.16s ease;
    }
    .tts-notice.show {
      opacity: 1;
      transform: translateY(0);
    }
    .post-body {
      color: var(--body);
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .jump {
      position: sticky;
      bottom: 104px;
      display: none;
      width: max-content;
      margin: 16px auto;
      box-shadow: var(--shadow);
    }
    .jump.visible { display: block; }
    .composer {
      position: fixed;
      right: 16px;
      bottom: 14px;
      left: 238px;
      z-index: 5;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      width: auto;
      max-width: none;
      border: 2px solid var(--line);
      background: var(--canvas);
      padding: 8px;
    }
    .composer textarea {
      min-height: 44px;
      max-height: 110px;
      border: 0;
      padding: 6px;
    }
    .composer button:disabled {
      opacity: 0.62;
      cursor: wait;
    }
    .tab-panel {
      max-width: 920px;
      padding: 18px;
      gap: 10px;
    }
    .tab-panel.active { display: grid; }
    .task-row {
      display: grid;
      gap: 5px;
      max-width: 720px;
      border: 1px solid var(--line);
      padding: 10px;
    }
    .task-top {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
    }
    .model-grid { display: grid; gap: 10px; }
    .model-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-top: 1px solid var(--soft-line);
      padding-top: 8px;
      color: var(--body);
    }
    .model-row:first-child { border-top: 0; padding-top: 0; }
    .available { color: #cc2f68; font-weight: 900; }
    .unavailable { color: var(--muted); }
    .cmd {
      border: 1px solid var(--line);
      background: var(--panel);
      padding: 10px;
      color: var(--body);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      line-height: 1.5;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .side-card {
      display: grid;
      gap: 10px;
      border: 1px solid var(--line);
      padding: 10px;
    }
    .settings-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .field { display: grid; gap: 5px; }
    .muted { color: var(--muted); font-size: 11px; }
    dialog {
      width: min(520px, calc(100vw - 24px));
      max-height: min(760px, calc(100vh - 24px));
      border: 2px solid var(--line);
      border-radius: 0;
      padding: 0;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    dialog::backdrop { background: rgba(0,0,0,0.48); }
    .computer-dialog { width: min(680px, calc(100vw - 24px)); }
    .window-dialog { width: min(440px, calc(100vw - 24px)); }
    .modal-form { margin: 0; }
    .modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 12px;
      border-bottom: 2px solid var(--line);
    }
    .modal-body {
      display: grid;
      gap: 12px;
      padding: 12px;
      overflow: auto;
      max-height: calc(100vh - 120px);
    }
    .computer-flow {
      display: grid;
      gap: 20px;
      padding: 32px;
    }
    .computer-kicker {
      color: var(--muted);
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .computer-title {
      font-size: 20px;
      line-height: 1.15;
      text-transform: uppercase;
    }
    .computer-lead {
      display: grid;
      grid-template-columns: 36px minmax(0, 1fr);
      gap: 14px;
      align-items: start;
      color: var(--body);
      font-size: 15px;
      line-height: 1.5;
    }
    .computer-icon {
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
      border: 2px solid var(--line);
      background: var(--accent);
      font-weight: 900;
    }
    .computer-muted {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .computer-rule { border-top: 2px solid var(--soft-line); }
    .computer-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      flex-wrap: wrap;
    }
    .computer-actions.between { justify-content: space-between; }
    .check-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 800;
      color: var(--body);
    }
    .check-row input {
      width: 16px;
      height: 16px;
      padding: 0;
      accent-color: var(--accent);
    }
    .choice-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .computer-choice {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 10px;
      min-height: 82px;
      border: 2px solid var(--line);
      padding: 14px;
      background: var(--canvas);
      text-align: left;
    }
    .computer-choice.active { background: var(--accent); }
    .computer-choice.disabled {
      border-style: dashed;
      color: var(--muted);
      opacity: 0.56;
      cursor: default;
    }
    .computer-choice-title {
      display: block;
      font-size: 14px;
      text-transform: uppercase;
    }
    .connect-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
    }
    .connect-stack {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .connect-help {
      color: var(--body);
      font-size: 12px;
      font-weight: 900;
    }
    .connect-command {
      border: 2px solid var(--line);
      background: #080808;
      color: #a7d66d;
      padding: 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .connect-status {
      display: flex;
      align-items: center;
      gap: 10px;
      border: 2px solid var(--line);
      background: #fff3c4;
      padding: 14px;
      font-weight: 900;
    }
    .status-dot {
      width: 10px;
      height: 10px;
      border: 2px solid var(--line);
      border-radius: 50%;
      background: #ffad7a;
    }
    .status-dot.online { background: #74d67b; }
    .button-shadow { box-shadow: 4px 5px 0 var(--line); }
    button.primary-pink {
      background: var(--active);
      min-height: 36px;
      padding: 8px 14px;
      font-size: 14px;
    }
    button.disabled-action {
      background: #edf5df;
      color: var(--muted);
      cursor: default;
    }
    @media (max-width: 760px) {
      .app { grid-template-columns: 36px 132px minmax(0, 1fr); }
      .logo {
        width: 24px;
        grid-template-columns: 1fr;
      }
      .logo span {
        width: 22px;
        height: 16px;
        font-size: 10px;
      }
      .message-list { padding: 0 10px; }
      .composer { left: 178px; right: 10px; width: auto; }
      .top-actions .hide-mobile { display: none; }
      .post { max-width: 100%; }
      .computer-flow { padding: 22px; }
      .choice-grid, .connect-row { grid-template-columns: 1fr; }
    }
`;
