import { tokenize } from './bm25.ts';
import { guard } from './guard.ts';
import { buildMessages } from './prompt.ts';
import { embed, streamChat } from './providers.ts';
import { retrieve, type SearchIndex } from './retrieve.ts';
import type { AskEvent, Hit, Provider } from './types.ts';

export type AskOptions = {
  index: SearchIndex;
  /** Tried in order; the next one is used only if the previous fails before writing anything */
  providers: Provider[];
  /** Embeds the question for hybrid search; skipped (keyword search only) if absent or slow */
  embedder?: Provider | null;
  k?: number;
  signal?: AbortSignal;
};

const NOT_FOUND =
  "I couldn't find that on the site. It covers Rishabh's projects, skills, experience and how he works. For anything else, email hi@rishabhray.me.";

/**
 * Answers a question as a stream of events: the sources first, then the answer text.
 * Every failure has a defined outcome: a guarded refusal, a "not on the site" reply, the next
 * provider, or, when every model is down, the relevant passages themselves. It never just errors.
 */
export async function* ask(rawQuestion: unknown, opts: AskOptions): AsyncGenerator<AskEvent> {
  const checked = guard(rawQuestion);
  if (!checked.ok) {
    yield { type: 'delta', text: checked.reply };
    yield { type: 'done', mode: 'refused' };
    return;
  }
  const question = checked.question;

  let queryVector: number[] | null = null;
  if (opts.embedder && opts.index.embeddings) {
    try {
      [queryVector] = await embed(opts.embedder, [question], { timeoutMs: 2500 });
    } catch {
      queryVector = null; // keyword search alone is still a good answer
    }
  }

  const hits = retrieve(opts.index, question, queryVector, opts.k ?? 5);
  if (!hits.length) {
    yield { type: 'delta', text: NOT_FOUND };
    yield { type: 'done', mode: 'refused' };
    return;
  }
  yield { type: 'sources', sources: sourcesFor(hits) };

  const messages = buildMessages(question, hits);
  for (const provider of opts.providers) {
    let wrote = false;
    try {
      for await (const text of streamChat(provider, messages, { signal: opts.signal })) {
        wrote = true;
        yield { type: 'delta', text };
      }
      yield { type: 'done', mode: 'model', provider: provider.name };
      return;
    } catch (error) {
      if (wrote) {
        // The answer was cut off mid-way: say so rather than silently ending
        yield { type: 'delta', text: ' (The answer was cut short. The sources below have the rest.)' };
        yield { type: 'done', mode: 'model', provider: provider.name };
        return;
      }
      // Nothing written yet, so the next provider can answer cleanly
    }
  }

  yield { type: 'delta', text: extractive(hits, question) };
  yield { type: 'done', mode: 'fallback' };
}

/** Sources, numbered to match the citations in the answer. */
export function sourcesFor(hits: Hit[]) {
  return hits.map((h, i) => ({ n: i + 1, title: h.passage.title, url: h.passage.url }));
}

const FALLBACK_INTRO = 'The AI model is unavailable right now, so here is what the site says:';

/**
 * The no-model answer, so the visitor still gets something true and useful when every provider
 * is down: the sentences from the retrieved passages that best match the question, each cited.
 * If no sentence shares a word with the question, it falls back to the opening of the top passage.
 */
export function extractive(hits: Hit[], question = '', maxSentences = 3): string {
  const terms = new Set(tokenize(question));
  const candidates = hits.flatMap((h, i) =>
    h.passage.text
      .split(/\n+|(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 25 && s.length <= 320 && !s.endsWith('?'))
      .map((s, j) => {
        const words = tokenize(s);
        const overlap = new Set(words.filter((w) => terms.has(w))).size;
        // Retrieval already ranked the passages, so a sentence's word overlap is discounted by its
        // passage's rank; earlier sentences win exact ties
        return { text: s, n: i + 1, score: overlap / (1 + 0.25 * i) - j * 0.001, overlap };
      }),
  );
  const ranked = candidates.filter((c) => c.overlap > 0).sort((a, b) => b.score - a.score);
  // A sentence sharing a single common word ("work") is noise unless it sits next to the best match
  const anchor = ranked[0]?.n;
  const best = ranked
    .filter((c) => c.overlap >= 2 || c.n === anchor || terms.size === 1)
    .filter((c, i, all) => all.findIndex((d) => d.text === c.text) === i)
    .slice(0, maxSentences);

  if (!best.length) {
    const top = hits[0].passage.text;
    const opening = top.length > 360 ? `${top.slice(0, 360).replace(/\s+\S*$/, '')}...` : top;
    return `${FALLBACK_INTRO}\n\n${opening} [1]`;
  }
  return `${FALLBACK_INTRO}\n\n${best.map((c) => `${c.text.replace(/[^.!?]$/, '$&.')} [${c.n}]`).join('\n')}`;
}
