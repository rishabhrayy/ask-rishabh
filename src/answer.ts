import { expandQuery, tokenize } from './bm25.ts';
import { guard } from './guard.ts';
import { BLOCKED_REPLY, outputFilter } from './outputguard.ts';
import { buildMessages, makeCanary } from './prompt.ts';
import { embed, isTransient, streamChat } from './providers.ts';
import { retrieve, type SearchIndex } from './retrieve.ts';
import { smallTalk } from './smalltalk.ts';
import type { AskEvent, Hit, Provider } from './types.ts';

export type AskOptions = {
  index: SearchIndex;
  /** Tried in order; the next one is used only if the previous fails before writing anything */
  providers: Provider[];
  /** Embeds the question for hybrid search; skipped (keyword search only) if absent or slow */
  embedder?: Provider | null;
  k?: number;
  signal?: AbortSignal;
  /** Time for the whole answer across providers before falling back (default 30 s) */
  budgetMs?: number;
  /** Called when a provider or the embedder fails, with no question text, so it is safe to log */
  onError?: (stage: string, error: Error) => void;
  /**
   * Passage ids used when search finds nothing, e.g. an intro and an overview. Vague questions
   * ("what else do you do?") share no words with any page, but are still about the subject;
   * the model gets the overview and decides. Without them, such questions get "not found".
   */
  overviewIds?: string[];
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
    yield { type: 'done', mode: 'refused', reason: checked.reason };
    return;
  }
  const question = checked.question;

  // Greetings, thanks, "help", "start over", "ummm": answered instantly, no search or model
  const chat = smallTalk(question);
  if (chat) {
    yield { type: 'delta', text: chat.reply };
    yield { type: 'done', mode: 'smalltalk', reason: chat.kind };
    return;
  }

  let queryVector: number[] | null = null;
  if (opts.embedder && opts.index.embeddings) {
    try {
      [queryVector] = await embed(opts.embedder, [question], { timeoutMs: 2500 });
    } catch (error) {
      queryVector = null; // keyword search alone is still a good answer
      opts.onError?.(`embed:${opts.embedder.name}`, error as Error);
    }
  }

  let hits = retrieve(opts.index, question, queryVector, opts.k ?? 5);
  // Nothing matched: fall back to the overview passages and let the model judge relevance.
  // With no model available, the extractive answer then simply links those sections.
  if (!hits.length && opts.overviewIds?.length) {
    hits = opts.overviewIds
      .flatMap((id) => opts.index.passages.filter((p) => p.docId === id).slice(0, 1))
      .map((passage) => ({ passage, score: 0 }));
  }
  if (!hits.length) {
    yield { type: 'delta', text: NOT_FOUND };
    yield { type: 'done', mode: 'refused', reason: 'not_found' };
    return;
  }
  yield { type: 'sources', sources: sourcesFor(hits) };

  // A fresh canary per request: it can only appear in an answer if the prompt is leaking
  const canary = makeCanary();
  const messages = buildMessages(question, hits, canary);
  // The whole answer has a time budget: a visitor should get the fallback within it rather
  // than wait through every provider's full timeout one after another
  const start = Date.now();
  const budget = opts.budgetMs ?? 30000;
  const remaining = () => budget - (Date.now() - start);

  for (const provider of opts.providers) {
    // One quick retry on the same provider for a rate limit, overload or timeout
    for (let attempt = 0; attempt < 2 && remaining() > 2000; attempt++) {
      let wrote = false;
      // Every answer passes the output check: a leak or markup replaces it before it is shown
      const filter = outputFilter(canary);
      try {
        const maxWaitMs = Math.min(20000, remaining());
        for await (const text of streamChat(provider, messages, { signal: opts.signal, maxWaitMs })) {
          wrote = true;
          const safe = filter.push(text);
          if (safe === null) break;
          if (safe) yield { type: 'delta', text: safe };
        }
        const tail = filter.flush();
        if (tail === null) {
          const verdict = filter.verdict;
          yield { type: 'replace', text: BLOCKED_REPLY };
          yield { type: 'done', mode: 'blocked', provider: provider.name, reason: verdict.ok ? undefined : verdict.reason };
          return;
        }
        if (tail) yield { type: 'delta', text: tail };
        yield { type: 'done', mode: 'model', provider: provider.name };
        return;
      } catch (error) {
        opts.onError?.(`chat:${provider.name}${attempt ? ':retry' : ''}`, error as Error);
        if (wrote) {
          // The answer was cut off mid-way: show what passed the check, and say so
          const tail = filter.flush();
          if (tail) yield { type: 'delta', text: tail };
          yield { type: 'delta', text: ' (The answer was cut short. The sources below have the rest.)' };
          yield { type: 'done', mode: 'model', provider: provider.name };
          return;
        }
        if (!isTransient(error as Error) || opts.signal?.aborted) break; // not worth retrying here
        await new Promise((r) => setTimeout(r, 400));
      }
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
 * When no sentence is a strong match, it points to the closest sections instead of quoting
 * something that only shares a word with the question.
 */
export function extractive(hits: Hit[], question = '', maxSentences = 3): string {
  const asked = new Set(tokenize(question));
  const terms = new Set(expandQuery(question));
  const candidates = hits.flatMap((h, i) => {
    // A sentence inherits its passage's title: on the Outfit Picker card, "A local-first PWA
    // wardrobe" is about Outfit Picker even though it never repeats the name
    const title = tokenize(h.passage.title);
    return h.passage.text
      .split(/\n+|(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 25 && s.length <= 320 && !s.endsWith('?'))
      .map((s, j) => {
        const words = new Set([...title, ...tokenize(s)]);
        // The question's own words count one each; the expansion's words ("experience" for
        // "work") count once in total, so they can lift a sentence but never outvote the question
        const own = [...asked].filter((w) => words.has(w)).length;
        const expanded = [...terms].some((w) => !asked.has(w) && words.has(w)) ? 1 : 0;
        const overlap = own + expanded;
        // Retrieval already ranked the passages, so a sentence's word overlap is discounted by its
        // passage's rank; earlier sentences win exact ties
        return { text: s, n: i + 1, score: overlap / (1 + 0.25 * i) - j * 0.001, overlap };
      });
  });
  const ranked = candidates.filter((c) => c.overlap > 0).sort((a, b) => b.score - a.score);
  // A sentence sharing a single common word ("work") is noise unless it sits next to the best match
  const anchor = ranked[0]?.n;
  const best = ranked
    .filter((c) => c.overlap >= 2 || c.n === anchor || terms.size === 1)
    .filter((c, i, all) => all.findIndex((d) => d.text === c.text) === i)
    .slice(0, maxSentences);

  // Strong: the best sentence shares two of the question's words, or its only word, or it comes
  // from the passage retrieval ranked first. Anything weaker gets section links, not a quote.
  const strong =
    best.length > 0 && (best[0].overlap >= Math.min(2, Math.max(1, asked.size)) || best[0].n === 1);
  if (!strong) {
    const sections = hits
      .slice(0, 3)
      .map((h, i) => ({ title: h.passage.title, n: i + 1 }))
      .filter((s, i, all) => all.findIndex((t) => t.title === s.title) === i)
      .map((s) => `${s.title} [${s.n}]`);
    return `The AI model is unavailable right now, and no single sentence on the site answers that directly. The closest sections are ${sections.join(', ')}.`;
  }
  return `${FALLBACK_INTRO}\n\n${best.map((c) => `${c.text.replace(/[^.!?]$/, '$&.')} [${c.n}]`).join('\n')}`;
}
