/**
 * Cheap checks that run before retrieval or any model call. They catch the questions this
 * assistant should never answer, so those cost nothing and cannot be talked around.
 */
export const MAX_QUESTION_CHARS = 300;

export type GuardResult = { ok: true; question: string } | { ok: false; reason: 'empty' | 'too_long' | 'private' | 'injection'; reply: string };

const CONTACT = 'For anything else, email hi@rishabhray.me.';

const PRIVATE = [
  /\b(salary|pay|paid|earn|earning|wage|rate|money|compensation)\b.*\b(expect|want|ask|need|current|his|your)\b/i,
  /\b(how old|age|date of birth|born in|birthday)\b/i,
  /\b(girlfriend|boyfriend|wife|husband|partner|married|dating|relationship)\b/i,
  /\b(religion|religious|caste|politic|vote|voting)\b/i,
  /\b(home address|where (does he|do you) live|phone number|passport|visa number)\b/i,
];

const INJECTION = [
  /\bignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|prompt)/i,
  /\b(system|hidden|initial) prompt\b/i,
  /\byou are now\b|\bact as\b|\bpretend (to be|you are)\b|\bjailbreak\b|\bDAN\b/,
  /\b(reveal|print|show|repeat) (your|the) (instructions|rules|prompt)\b/i,
];

export function guard(raw: unknown): GuardResult {
  const question = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!question) return { ok: false, reason: 'empty', reply: 'Ask me anything about Rishabh\'s work, projects or skills.' };
  if (question.length > MAX_QUESTION_CHARS) {
    return { ok: false, reason: 'too_long', reply: `Please keep questions under ${MAX_QUESTION_CHARS} characters.` };
  }
  if (INJECTION.some((r) => r.test(question))) {
    return { ok: false, reason: 'injection', reply: `I only answer questions about Rishabh's work, using what is on this site. ${CONTACT}` };
  }
  if (PRIVATE.some((r) => r.test(question))) {
    return { ok: false, reason: 'private', reply: `That is not something I answer here. I stick to Rishabh's work, projects and skills. ${CONTACT}` };
  }
  return { ok: true, question };
}
