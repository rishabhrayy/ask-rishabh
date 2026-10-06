# ask-rishabh

[![CI](https://github.com/rishabhrayy/ask-rishabh/actions/workflows/ci.yml/badge.svg)](https://github.com/rishabhrayy/ask-rishabh/actions/workflows/ci.yml) [![Live](https://img.shields.io/badge/live-rishabhray.me-F0621A)](https://rishabhray.me/#ask) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The engine behind **"Ask about my work"** on [rishabhray.me](https://rishabhray.me/#ask): a small retrieval-augmented assistant that answers questions about my work from my site's own content, cites every claim, and keeps answering when the model does not.

It is built to be measured, not guessed at. Every change runs an evaluation in CI, and the build fails if retrieval or refusals get worse.

## How a question is answered

```text
question
  -> guard          length cap, private topics, prompt-injection patterns   (no model call)
  -> retrieve       BM25 keywords + embeddings, merged by reciprocal rank fusion
  -> nothing found? "I couldn't find that on the site"                         (no model call)
  -> answer         Groq, then Gemini if Groq fails before writing anything
  -> every model down? the best-matching sentences from the passages, cited
```

Each step has a defined failure mode, so the visitor never sees a blank error:

| If this fails | What happens |
|---|---|
| The question is private, off-limits or an injection attempt | A polite refusal from the guard, before any model is called |
| The site has nothing on it | "I couldn't find that on the site", and the contact address |
| The embedding call is slow or rate-limited | Keyword search alone (2.5 s budget) |
| The first model errors or is silent for 9 s | The next provider, as long as nothing was written yet |
| A model fails mid-answer | The answer is marked as cut short, and the sources are still shown |
| Every model is down | An extractive answer: the sentences that best match the question, each cited |

## Design choices

- **Only public content.** The site builds its index at deploy time from its own published pages, plus the guide answers in its content file. Nothing else is read, so the assistant can only know what a visitor could already see.
- **Hybrid retrieval with rank fusion.** Keywords catch exact names ("FIT5120", "NeighbourFit"); embeddings catch meaning ("what did he study" when the page says "Master of Artificial Intelligence"). Reciprocal rank fusion merges them without calibrating two incompatible score scales.
- **Citations or nothing.** The model is told to answer only from numbered passages and cite each claim; the UI links only the sources the answer actually cites.
- **No dependencies at runtime.** BM25, fusion, streaming and the rate limiter are a few hundred lines of TypeScript over `fetch`, so the whole engine is readable in one sitting.
- **Privacy.** Question text is never stored. The rate limiter keeps only a truncated hash of the visitor's IP, which expires with its 10-minute window.

## Evaluation

```bash
npm run eval               # retrieval and refusal metrics, no keys needed (runs in CI)
npm run eval -- --answers  # also checks that every model answer cites its claims (needs keys)
```

The question set ([`eval/site/questions.json`](eval/site/questions.json)) has 46 questions a recruiter or engineer might ask, each labelled with the passages that answer it, plus questions that must be refused: salary, age, relationships, instruction-override attempts, and off-topic trivia. It runs against a snapshot of the site's index ([`eval/site/index.json`](eval/site/index.json)), rebuilt with the current engine code on every run.

Keyword retrieval, 39 answerable questions:

| | Plain BM25 | + query expansion | + title boost |
|---|---|---|---|
| Hit@5 (a correct passage in the top 5) | 87.2% | 100% | 100% |
| Mean reciprocal rank | 0.655 | 0.799 | **0.915** |
| Must-refuse questions stopped before the model | 100% | 100% | 100% |

- **Query expansion** maps the words visitors use to the words the site uses ("where else did you work" also searches "experience" and "record"). It came from a real miss on the live site.
- **Title boost:** a passage whose title holds the question's words ranks above one that only mentions them, so "What is Outfit Picker?" lands on the Outfit Picker card, not a skills list naming it three times.

To be honest about it: both fixes were written after seeing these misses, so the right-hand columns are measured on questions that informed them. The next step is a held-out set of new questions, to see how much of the gain generalises. In production, embeddings are added on top (hybrid search), which is what answers "What did he study?" when the site only ever says "Master of Artificial Intelligence".

## Use it

```ts
import { ask, buildIndex, chunk } from 'ask-rishabh';

const index = buildIndex(chunk(docs)); // docs: { id, title, url, text }[]
for await (const event of ask('What is NeighbourFit?', { index, providers })) {
  // { type: 'sources' } then { type: 'delta', text } ... then { type: 'done', mode }
}
```

`providers` is any list of OpenAI-compatible chat endpoints (`{ name, baseUrl, apiKey, model }`), tried in order.

## Tests

```bash
npm test
```

26 tests: tokenising, chunking, keyword and vector retrieval, rank fusion, the guard (what it refuses and what it lets through), replacing em dashes, stripping a reasoning model's `<think>` block even when its tags are split across chunks, and the full flow with the network mocked: provider fallback, every provider down, private and off-topic questions never reaching a model, and embeddings failing back to keywords.

## What is next

1. **Measure hybrid retrieval** on the same questions and fill in the table.
2. **Fair Work assistant:** the same engine on Australian pay and conditions pages, with a 100-question test set and a comparison of BM25, embeddings, hybrid and a reranker.
3. **Fine-tune vs RAG:** a small model fine-tuned on the same questions, compared head to head, including what happens when pay rates change on 1 July.

## Licence

[MIT](LICENSE)
