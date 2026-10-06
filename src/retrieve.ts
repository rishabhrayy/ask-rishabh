import { buildBm25, searchBm25, type Bm25Index } from './bm25.ts';
import type { Hit, Passage } from './types.ts';

/** Everything retrieval needs, built at deploy time and shipped as one JSON file. */
export type SearchIndex = {
  version: 1;
  builtAt: string;
  passages: Passage[];
  bm25: Bm25Index;
  /** Optional: one unit-length embedding per passage, same order as `passages` */
  embeddings?: { model: string; vectors: number[][] };
};

export function buildIndex(passages: Passage[], embeddings?: SearchIndex['embeddings']): SearchIndex {
  return { version: 1, builtAt: new Date().toISOString(), passages, bm25: buildBm25(passages), embeddings };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function searchDense(index: SearchIndex, queryVector: number[], k = 8): Hit[] {
  const vectors = index.embeddings?.vectors;
  if (!vectors) return [];
  return vectors
    .map((v, i) => ({ passage: index.passages[i], score: cosine(v, queryVector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * Reciprocal rank fusion: each list votes 1 / (k + rank) for its passages. It needs no score
 * calibration between BM25 and cosine similarity, which live on completely different scales.
 */
export function fuse(lists: Hit[][], k = 60, limit = 8): Hit[] {
  const scores = new Map<string, { passage: Passage; score: number }>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const entry = scores.get(hit.passage.id) ?? { passage: hit.passage, score: 0 };
      entry.score += 1 / (k + rank + 1);
      scores.set(hit.passage.id, entry);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Hybrid search: keywords catch exact names ("FIT5120", "NeighbourFit"), embeddings catch meaning
 * ("what does he do when an API goes down"). With no query vector it is plain BM25, so retrieval
 * still works when the embedding service is unavailable.
 */
export function retrieve(index: SearchIndex, query: string, queryVector?: number[] | null, k = 5): Hit[] {
  const keyword = searchBm25(index.bm25, index.passages, query, 10);
  if (!queryVector || !index.embeddings) return keyword.slice(0, k);
  return fuse([keyword, searchDense(index, queryVector, 10)], 60, k);
}
