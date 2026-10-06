/**
 * Evaluates the assistant on a question set.
 *
 *   npm run eval                          retrieval and refusal metrics, no keys needed (runs in CI)
 *   npm run eval -- --answers             also generates answers and checks citations and refusals
 *                                         (needs GROQ_API_KEY and/or GEMINI_API_KEY)
 *   npm run eval -- --index x.json --questions y.json
 *
 * Exits non-zero if any metric falls below the thresholds in the question file, so CI catches
 * a change that makes the assistant worse.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ask } from '../src/answer.ts';
import { guard } from '../src/guard.ts';
import { buildIndex, retrieve, type SearchIndex } from '../src/retrieve.ts';
import type { Provider } from '../src/types.ts';

type Question = { q: string; expect?: string[]; refuse?: boolean | 'model' };
type QuestionFile = { thresholds: { hitAt5: number; refusal: number; citation: number }; questions: Question[] };

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const here = import.meta.dirname;
// Rebuild from the snapshot's passages, so the eval always measures the current engine code
// rather than whatever version built the snapshot
const snapshot = JSON.parse(fs.readFileSync(arg('--index', path.join(here, 'site', 'index.json')), 'utf8')) as SearchIndex;
const index = buildIndex(snapshot.passages, snapshot.embeddings);
const file = JSON.parse(fs.readFileSync(arg('--questions', path.join(here, 'site', 'questions.json')), 'utf8')) as QuestionFile;
const withAnswers = process.argv.includes('--answers');

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const failures: string[] = [];

// --- retrieval: is a passage that answers the question in the top 5? ---
const answerable = file.questions.filter((q) => !q.refuse);
let hits = 0;
let reciprocal = 0;
for (const q of answerable) {
  const ranked = retrieve(index, q.q, null, 5).map((h) => h.passage.docId);
  const rank = ranked.findIndex((id) => q.expect!.includes(id));
  if (rank > -1) {
    hits++;
    reciprocal += 1 / (rank + 1);
  } else failures.push(`MISS  ${q.q}  -> got ${ranked.slice(0, 3).join(', ') || 'nothing'}`);
}
const hitAt5 = hits / answerable.length;
const mrr = reciprocal / answerable.length;

// --- refusals: private and injection questions are stopped by the guard, before any model ---
// (off-topic questions, refuse: "model", reach the model and are checked with --answers)
const mustRefuse = file.questions.filter((q) => q.refuse === true);
let refused = 0;
for (const q of mustRefuse) {
  if (!guard(q.q).ok) refused++;
  else failures.push(`LEAK  ${q.q}  -> passes the guard (it must be stopped before the model)`);
}
const refusalPre = refused / mustRefuse.length;

// --- false blocks: a stricter guard must never stop a real question ---
const falseBlocks = answerable.filter((q) => !guard(q.q).ok);
for (const q of falseBlocks) failures.push(`FALSE BLOCK  ${q.q}  -> ${(guard(q.q) as { reason: string }).reason}`);

console.log(`\nRetrieval   hit@5 ${pct(hitAt5)}  MRR ${mrr.toFixed(3)}  (${answerable.length} questions)`);
console.log(`Refusal     ${pct(refusalPre)} stopped by the guard before the model  (${mustRefuse.length} questions)`);
console.log(`Guard       ${falseBlocks.length} real questions wrongly blocked`);

// --- answers (optional, needs keys): citations on every answer, refusals held by the model ---
let citation = 1;
if (withAnswers) {
  const providers: Provider[] = [];
  if (process.env.GROQ_API_KEY)
    providers.push({ name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile' });
  if (process.env.GEMINI_API_KEY)
    providers.push({ name: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', maxTokens: 2500 });
  if (!providers.length) throw new Error('--answers needs GROQ_API_KEY or GEMINI_API_KEY');

  let cited = 0;
  let modelAnswers = 0;
  let modelRefusalsHeld = 0;
  let modelRefusalsTried = 0;
  for (const q of file.questions) {
    let text = '';
    let mode = '';
    for await (const e of ask(q.q, { index, providers })) {
      if (e.type === 'delta') text += e.text;
      if (e.type === 'done') mode = e.mode;
    }
    if (q.refuse) {
      if (mode === 'model') {
        modelRefusalsTried++;
        if (!/\[\d+\]/.test(text) || /don't have|do not have|not on the site|hi@rishabhray\.me/i.test(text)) modelRefusalsHeld++;
        else failures.push(`ANSWERED  ${q.q}  -> ${text.slice(0, 120)}`);
      }
      continue;
    }
    if (mode !== 'model') continue;
    modelAnswers++;
    // every sentence that states something should carry a citation
    const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 30);
    const ok = sentences.every((s) => /\[\d+\]/.test(s)) && /\[\d+\]/.test(text);
    if (ok) cited++;
    else failures.push(`UNCITED  ${q.q}  -> ${text.slice(0, 120)}`);
  }
  citation = modelAnswers ? cited / modelAnswers : 0;
  console.log(`Citations   ${pct(citation)} of ${modelAnswers} model answers cite every claim`);
  if (modelRefusalsTried) console.log(`Refusal     ${modelRefusalsHeld}/${modelRefusalsTried} held by the model itself`);
}

if (failures.length) console.log(`\n${failures.join('\n')}`);

const t = file.thresholds;
const below = [
  hitAt5 < t.hitAt5 && `hit@5 ${pct(hitAt5)} < ${pct(t.hitAt5)}`,
  refusalPre < t.refusal && `refusal ${pct(refusalPre)} < ${pct(t.refusal)}`,
  falseBlocks.length > 0 && `${falseBlocks.length} real questions blocked by the guard`,
  withAnswers && citation < t.citation && `citation ${pct(citation)} < ${pct(t.citation)}`,
].filter(Boolean);
if (below.length) {
  console.error(`\nBelow threshold: ${below.join('; ')}`);
  process.exit(1);
}
console.log('\nAll metrics at or above threshold.');
