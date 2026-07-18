import type { AlertRule } from "../alert-rule.js";
import { createRuleB } from "./rule-b-treasury.js";
import { createRuleDiscordWba } from "./rule-discord-wba.js";
import { createRuleE } from "./rule-e-meme.js";
import { createRuleF } from "./rule-f-stocks.js";
import { createRuleKimpremium } from "./rule-kimpremium.js";
import { createRuleQ } from "./rule-q-panews.js";
import { createRuleTCelebrity } from "./rule-t-celebrity.js";
import { createRuleTTicker } from "./rule-t-ticker.js";

/** Default slim stack — keyed by canonical rule ids. */
export const SLIM_RULE_REGISTRY: Record<string, () => AlertRule> = {
  treasury: createRuleB,
  meme_large: createRuleE,
  stocks: createRuleF,
  celebrity: createRuleTCelebrity,
  ticker_velocity: createRuleTTicker,
  discord_wba: createRuleDiscordWba,
  panews: createRuleQ,
  kimpremium: createRuleKimpremium,
};
