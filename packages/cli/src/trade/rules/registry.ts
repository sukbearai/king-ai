import type { AlertRule } from "../alert-rule.js";
import { createRuleA } from "./rule-a-btc-price.js";
import { createRuleB } from "./rule-b-funding.js";
import { createRuleC } from "./rule-c-smart-money.js";
import { createRuleD } from "./rule-d-polymarket.js";
import { createRuleE } from "./rule-e-meme.js";
import { createRuleF } from "./rule-f-stocks.js";
import { createRuleG } from "./rule-g-options.js";
import { createRuleH } from "./rule-h-stablecoin.js";
import { createRuleI } from "./rule-i-whale.js";
import { createRuleJ } from "./rule-j-vix.js";
import { createRuleK } from "./rule-k-ma.js";
import { createRuleL } from "./rule-l-rsi.js";
import { createRuleM } from "./rule-m-bbands.js";
import { createRuleN } from "./rule-n-liquidation.js";
import { createRuleO } from "./rule-o-gas.js";
import { createRuleP } from "./rule-p-macro.js";
import { createRuleQ } from "./rule-q-panews.js";
import { createRuleR } from "./rule-r-long-short.js";
import { createRuleS } from "./rule-s-subscribed.js";
import { createRuleTCelebrity } from "./rule-t-celebrity.js";
import { createRuleTTicker } from "./rule-t-ticker.js";
import { createRuleU } from "./rule-u-etf-flow.js";
import { createRuleDiscordWba } from "./rule-discord-wba.js";

export const RULE_REGISTRY: Record<string, () => AlertRule> = {
  a: createRuleA,
  b: createRuleB,
  c: createRuleC,
  d: createRuleD,
  e: createRuleE,
  f: createRuleF,
  g: createRuleG,
  h: createRuleH,
  i: createRuleI,
  j: createRuleJ,
  k: createRuleK,
  l: createRuleL,
  m: createRuleM,
  n: createRuleN,
  o: createRuleO,
  p: createRuleP,
  q: createRuleQ,
  r: createRuleR,
  s: createRuleS,
  t: createRuleTCelebrity,
  celebrity: createRuleTCelebrity,
  tm: createRuleTTicker,
  ticker: createRuleTTicker,
  u: createRuleU,
  discord_wba: createRuleDiscordWba
};

export function listRuleIds(): string[] {
  return Object.keys(RULE_REGISTRY).sort();
}

export function createRule(id: string): AlertRule | null {
  const factory = RULE_REGISTRY[id];
  return factory ? factory() : null;
}