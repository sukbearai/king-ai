import { guiClientBaseScript } from "./gui-client-base.js";
import { guiClientEnhancementScript } from "./gui-client-enhancement.js";
import { guiPageEnhancementStyles } from "./gui-page-enhancement-styles.js";

export function renderPage(styles: string): string {
  return "<!doctype html>" + (
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>King AI Chat</title>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <style dangerouslySetInnerHTML={{ __html: guiPageEnhancementStyles }} />
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
	                    <span id="runIndicator" class="run-indicator" role="status"><span class="run-dot"></span><span class="run-label" id="runLabel"></span></span>
	                    <button class="jump" onclick="scrollToBottom()" data-i18n="backToBottom">↓ Back to bottom</button>
	                    <button onclick="openAttachmentPicker()" data-i18n="attachFile">Attach</button>
	                    <button id="clearButton" onclick="clearMessages()" data-i18n="clearScreen">Clear</button>
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

        <dialog id="vocabDialog" class="vocab-dialog">
          <div class="vocab-card">
            <div class="vocab-head">
              <div id="vocabWord" class="vocab-title"></div>
              <div class="vocab-actions">
                <button id="vocabAudioButton" class="icon-btn tts-button vocab-audio-button" data-tts-id="" data-tts-state="idle" onclick="playVocabTts()" title="Play word audio" aria-label="Play word audio"></button>
                <button class="icon" onclick="closeVocabDialog()" aria-label="Close vocabulary">x</button>
              </div>
            </div>
            <div class="vocab-row">
              <span id="vocabMeaningLabel" class="vocab-label">Meaning</span>
              <span id="vocabMeaning" class="vocab-value"></span>
            </div>
            <div class="vocab-row">
              <span id="vocabPosLabel" class="vocab-label">Part of speech</span>
              <span id="vocabPos" class="vocab-value"></span>
            </div>
            <div class="vocab-row">
              <span id="vocabPhoneticLabel" class="vocab-label">Phonetic</span>
              <span id="vocabPhonetic" class="vocab-value"></span>
            </div>
            <div class="vocab-row">
              <span id="vocabSyllablesLabel" class="vocab-label">Syllables</span>
              <span id="vocabSyllables" class="vocab-value"></span>
            </div>
            <div class="vocab-row">
              <span id="vocabRootsLabel" class="vocab-label">Roots &amp; affixes</span>
              <span id="vocabRoots" class="vocab-value"></span>
            </div>
          </div>
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
              <p class="muted" data-i18n="dataResetDesc">Restore the initial system state: clear current account windows, messages, tasks, files, decisions, pairing info, and run history, then ask this computer to clear every agent context, session, and workspace. A new pairing code will be generated.</p>
              <div id="resetAccountStatus" class="danger-status"></div>
              <div class="danger-actions">
                <button id="resetAccountButton" class="danger-button button-shadow" onclick="resetCurrentAccountData()" data-i18n="dataResetButton">Restore initial state</button>
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
                <label for="newWindowWorkflow" data-i18n="windowWorkflow">Workflow</label>
                <select id="newWindowWorkflow" onchange="syncNewWindowWorkflow()"></select>
              </div>
              <div class="field">
                <label data-i18n="windowMode">Collaboration</label>
                <div class="mode-grid">
                  <label class="mode-option" data-window-mode-option="single">
                    <input type="radio" name="newWindowMode" value="single" onchange="syncNewWindowMode()" />
                    <span class="mode-title" data-i18n="singleAgent">Single agent</span>
                    <span class="mode-desc" data-i18n="singleAgentDesc">Only the owner replies</span>
                  </label>
                  <label class="mode-option" data-window-mode-option="team">
                    <input type="radio" name="newWindowMode" value="team" checked onchange="syncNewWindowMode()" />
                    <span class="mode-title" data-i18n="defaultTeam">Default team</span>
                    <span id="newWindowTeamModeDesc" class="mode-desc" data-i18n="defaultTeamDesc">Use workflow agents</span>
                  </label>
                  <label class="mode-option" data-window-mode-option="custom">
                    <input type="radio" name="newWindowMode" value="custom" onchange="syncNewWindowMode()" />
                    <span class="mode-title" data-i18n="customTeam">Custom</span>
                    <span id="newWindowCustomModeDesc" class="mode-desc" data-i18n="customTeamDesc">Choose roles</span>
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
        <script dangerouslySetInnerHTML={{ __html: guiClientBaseScript }} />
        <script dangerouslySetInnerHTML={{ __html: guiClientEnhancementScript }} />
      </body>
    </html>
  ).toString();
}
