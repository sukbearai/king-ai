import { engineRemediationAdvice, formatRemediationAdvice } from "./remediation.js";

export const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

export function stripLoneSurrogates(s: string): string {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

export function cleanLine(line: string): string {
  return line.replace(ANSI_RE, "").replace(/\r/g, "").trim();
}

export function concise(text: string, max = 900): string {
  return cleanLine(text).slice(0, max);
}

export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

export function isRateLimited(text: string): boolean {
  return /\b(429|503)\b|too many requests|rate.?limit|\bquota\b|resource_exhausted|usage limit|session limit|overloaded|insufficient_quota|service (temporarily )?unavailable/i.test(text);
}

export function authFailureHint(engine: string, detail: string): string {
  return formatRemediationAdvice(engineRemediationAdvice(engine, detail));
}
