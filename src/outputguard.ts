import { LEAK_SIGNATURES } from './prompt.ts';

export const BLOCKED_REPLY =
  "I can't help with that here. I only answer questions about Rishabh's work, using what is on this site. For anything else, email hi@rishabhray.me.";

export type OutputVerdict = { ok: true } | { ok: false; reason: 'canary' | 'prompt_leak' | 'markup' | 'external_link' };

const ALLOWED_HOST = /^(?:[a-z0-9-]+\.)*rishabhray\.me$/i;

/** Checks a full or partial answer for leaks and content the UI should never be handed. */
export function checkOutput(text: string, canary: string): OutputVerdict {
  const flat = text.replace(/[​-‏⁠﻿]/g, '');
  if (flat.includes(canary)) return { ok: false, reason: 'canary' };
  const lower = flat.toLowerCase();
  if (LEAK_SIGNATURES.some((s) => lower.includes(s.toLowerCase()))) return { ok: false, reason: 'prompt_leak' };
  // Answers are plain text: markup or script in one is an injection attempt aimed at whoever renders it
  if (/<\s*(script|iframe|img|svg|a|style|object)\b|javascript:|on(error|load|click)\s*=/i.test(flat)) return { ok: false, reason: 'markup' };
  for (const m of flat.matchAll(/\bhttps?:\/\/([^\s/)\]]+)/gi)) {
    if (!ALLOWED_HOST.test(m[1])) return { ok: false, reason: 'external_link' };
  }
  return { ok: true };
}

/**
 * Streams answer text through checkOutput, holding back the last `holdback` characters so a
 * leak is caught before its words reach the screen. A blocked answer is replaced, not cut off.
 */
export function outputFilter(canary: string, holdback = 80) {
  let all = '';
  let sent = 0;
  let verdict: OutputVerdict = { ok: true };
  return {
    /** Add model text; returns what is now safe to show, or null once the answer is blocked */
    push(text: string): string | null {
      if (!verdict.ok) return null;
      all += text;
      verdict = checkOutput(all, canary);
      if (!verdict.ok) return null;
      const safeTo = Math.max(sent, all.length - holdback);
      const out = all.slice(sent, safeTo);
      sent = safeTo;
      return out;
    },
    /** The end of the answer: the held-back tail, or null if it is blocked */
    flush(): string | null {
      if (!verdict.ok) return null;
      const out = all.slice(sent);
      sent = all.length;
      return out;
    },
    get verdict() {
      return verdict;
    },
  };
}
