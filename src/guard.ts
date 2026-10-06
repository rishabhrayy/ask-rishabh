/**
 * Cheap checks that run before retrieval or any model call. They catch the questions this
 * assistant should never answer, so those cost nothing and cannot be talked around.
 *
 * Matching runs on a normalised copy of the question, so the usual disguises do not help:
 * zero-width characters, spaced-out letters ("i g n o r e") and leetspeak ("1gn0re").
 * This is one layer, not the defence: the prompt, the output check and the per-visitor
 * pause on repeated blocks sit behind it.
 */
export const MAX_QUESTION_CHARS = 300;

export type GuardReason = 'empty' | 'too_long' | 'private' | 'injection' | 'encoded' | 'noise';
export type GuardResult = { ok: true; question: string } | { ok: false; reason: GuardReason; reply: string };

const CONTACT = 'For anything else, email hi@rishabhray.me.';
const SCOPE = `I only answer questions about Rishabh's work, using what is on this site. ${CONTACT}`;

const PRIVATE = [
  /\b(salary|salaries|compensation|remuneration|wages?|package|ctc)\b/,
  /\b(pay|paid|earn\w*|rate|money)\b.*\b(expect\w*|want\w*|ask\w*|need\w*|current\w*|his|your|range)\b/,
  /\bhow much\b.*\b(paid|pay|earns?|earning|make|makes|charges?)\b/,
  /\b(how old|age|date of birth|born in|birthday)\b/,
  /\b(girlfriend|boyfriend|wife|husband|partner|married|dating|relationship)\b|\bis (he|rishabh) single\b/,
  /\b(religion|religious|caste|politic\w*|vote|voted|voting)\b/,
  /\b(health|medical|illness|disabilit\w*|diagnos\w*|mental)\b/,
  /\b(home address|where (does he|do you) live|phone number|mobile number|passport|visa number)\b/,
];

const INJECTION = [
  // override the rules, in any wording
  /\b(ignore|disregard|forget|override|bypass|set aside|drop|abandon|skip)\b.{0,40}\b(instructions?|rules?|guidelines?|prompt|constraints?|restrictions?|everything|what you were told|previous|above|earlier)\b/,
  /\b(new|updated|revised) (instructions?|rules?|guidelines?)\b/,
  /\bsystem (override|message|note|prompt|instructions?)\b/,
  /(^|\n)\s*#{2,}\s*(system|assistant|user)\b/,
  /\b(developer|god|admin|debug|unrestricted|jailbreak) mode\b|\bjailbreak\b/,
  /\b(dan|stan|do anything now|mongo tom)\b/,
  // role-play and persona swaps
  /\b(act|respond|answer|behave|reply|speak|talk) (as|like) (a|an|if|the|his|rishabh)\b/,
  /\bpretend\b|\blet'?s play a game\b|\brole ?play\b|\bin character\b/,
  /\byou are (now|no longer|dan|free|an? (unrestricted|unfiltered|evil|new))\b/,
  /\b(evil|unfiltered|uncensored) (twin|version|mode|ai)\b/,
  // extracting the instructions
  /\b(your|you were given|you follow|you've been given)\b.{0,30}\b(instructions?|rules?|guidelines?|prompt|configuration|code|system message)\b/,
  /\b(instructions?|guidelines?|system message|configuration|reference code)\b.{0,30}\b(you|your)\b/,
  /\b(repeat|print|show|reveal|output|quote|translate|summari[sz]e|list|write)\b.{0,30}\b(everything above|your (instructions|rules|guidelines|prompt|configuration))\b/,
  /\b(text|everything|what) (appears |is )?(before|above) (the|this|these)\b/,
  // "safe context, just add a warning" (Skeleton Key) and API-mode tricks
  /\b(safe|educational|research|hypothetical|fictional) (context|scenario|purposes?)\b/,
  /\badd ['"]?warning/,
  /\b(respond|act|answer|work|function) (as|like) an? (api|terminal|linux|shell|interpreter|database)\b/,
  // encodings named outright
  /\b(rot ?13|base ?64|hex(adecimal)?|morse|caesar|reversed?|backwards)\b.{0,30}\b(decode|follow|reply|answer|write|only|instructions|rules|guidelines)\b/,
  /\bdecode (and|then) (follow|obey|run|do)\b/,
  // other languages: "ignore the previous instructions", "system prompt"
  /\bignora\b.*\binstruc/,
  /\bignore[sz]?\b.*\binstructions?\b/,
  /\bignorier\w*\b.*\banweisung/,
  /निर्देश|अनदेखा|भूल जाओ/,
  /忽略|系统提示|系統提示|指令/,
  /無視|指示を|システムプロンプト/,
];

/** A copy of the question for matching: no invisible characters, letters rejoined, leetspeak undone. */
export function normalise(question: string): string {
  let s = question.normalize('NFKC').replace(/[​-‏⁠﻿­]/g, '').toLowerCase();
  // "i g n o r e  p r e v i o u s" -> "ignore previous" (runs of single letters joined)
  s = s.replace(/\b(?:[a-z] ){3,}[a-z]\b/g, (run) => run.replace(/ /g, ''));
  // leetspeak, only inside words that also contain letters
  s = s.replace(/\b\w*[a-z]\w*\b/g, (w) => w.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/@/g, 'a'));
  return s.replace(/\s+/g, ' ').trim();
}

export function guard(raw: unknown): GuardResult {
  const question = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!question) return { ok: false, reason: 'empty', reply: "Ask me anything about Rishabh's work, projects or skills." };
  if (question.length > MAX_QUESTION_CHARS) {
    // also what stops "many-shot" attacks, which need a long run of fake examples
    return { ok: false, reason: 'too_long', reply: `Please keep questions under ${MAX_QUESTION_CHARS} characters.` };
  }
  const text = normalise(String(raw ?? ''));

  // A long unbroken run of base64-like text is an encoded instruction, not a question
  if (/[A-Za-z0-9+/]{28,}={0,2}/.test(question.replace(/https?:\/\/\S+/g, ''))) {
    return { ok: false, reason: 'encoded', reply: SCOPE };
  }
  // Optimised attack strings are dense with brackets, slashes and markup symbols; questions are not
  const symbols = (question.match(/[\\[\](){}<>|^~`*+]/g) ?? []).length;
  if (symbols >= 5 || (question.match(/\bq:/gi) ?? []).length >= 3) {
    return { ok: false, reason: 'noise', reply: SCOPE };
  }
  // Patterns run on both the plain and the normalised question: undoing leetspeak would turn a
  // genuine "rot13" into "rotie" (found by the red team), so neither copy alone is enough
  const plain = question.toLowerCase();
  const matches = (patterns: RegExp[]) => patterns.some((r) => r.test(text) || r.test(plain));
  if (matches(INJECTION)) return { ok: false, reason: 'injection', reply: SCOPE };
  if (matches(PRIVATE)) {
    return { ok: false, reason: 'private', reply: `That is not something I answer here. I stick to Rishabh's work, projects and skills. ${CONTACT}` };
  }
  return { ok: true, question };
}
