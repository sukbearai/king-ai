/// <reference types="@cloudflare/workers-types" />

export {
  GuiState,
  resolveWakeEvent,
  resolveWakeData,
  shouldAutoDelegateMessage,
  triageResponseMode,
  wakeEventVisibleToAgent,
  wakeResolveContextFromState
} from "./gui-state-do.js";

export { default } from "./gui-state-do.js";
