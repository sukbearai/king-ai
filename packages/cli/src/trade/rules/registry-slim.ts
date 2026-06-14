import type { AlertRule } from "../alert-rule.js";
import { createRuleDiscordWba } from "./rule-discord-wba.js";
import { createRuleE } from "./rule-e-meme.js";
import { createRuleF } from "./rule-f-stocks.js";
import { createRuleQ } from "./rule-q-panews.js";
import { createRuleTCelebrity } from "./rule-t-celebrity.js";
import { createRuleTTicker } from "./rule-t-ticker.js";

/** Default slim stack — eagerly loaded at daemon startup. */
export const SLIM_RULE_REGISTRY: Record<string, () => AlertRule> = {
  e: createRuleE,
  f: createRuleF,
  t: createRuleTCelebrity,
  tm: createRuleTTicker,
  discord_wba: createRuleDiscordWba,
  q: createRuleQ
};