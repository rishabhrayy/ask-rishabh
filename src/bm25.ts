import type { Hit, Passage } from './types.ts';

// Words that carry no meaning for matching. Kept short on purpose: "not", "no" and "without"
// stay, because they change what a question is asking.
const STOP = new Set(
  'a about all also an and any are as at be been but by can could did do does for from had has have he her him his how i in into is it its just me more my of on or our over she should so some tell than that the their them then there they this to us was we were what when where which who why will with would you your'.split(
    ' ',
  ),
);

/** Lowercase words and numbers, light plural folding, stop words removed. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize('NFKD').match(/[a-z0-9]+(?:[.'][a-z0-9]+)*/g) ?? [])
    .map((t) => t.replace(/'s$/, '').replace(/\./g, ''))
    .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
    .filter((t) => t && !STOP.has(t));
}

/**
 * Visitors ask in their own words ("where else did you work?") and the site uses its own
 * ("Track record and experience"). Each group maps the words people ask with to the words the
 * site uses for that topic. Applied to the question only, so the index stays untouched.
 */
const EXPANSIONS: [string, string][] = [
  ['work worked working job jobs employer employed employment career company companies experience role roles position', 'experience record role'],
  ['study studied studying degree education university uni college qualification qualified graduate school', 'master monash university degree computer science'],
  ['teach teaching taught tutor tutoring mentor mentoring lecture lecturer', 'mentor teaching associate student team'],
  ['hire hiring contact reach email available availability', 'email contact open role'],
  ['fun hobby hobbies weekend weekends outside free', 'photography camera weekend'],
];
const EXPAND = new Map<string, string[]>();
for (const [asked, site] of EXPANSIONS) for (const word of tokenize(asked)) EXPAND.set(word, tokenize(site));

/** The question's terms plus the site's words for the topics it asks about. */
export function expandQuery(query: string): string[] {
  const terms = tokenize(query);
  return [...new Set([...terms, ...terms.flatMap((t) => EXPAND.get(t) ?? [])])];
}

/** A serialisable BM25 index: it is built once at deploy time and shipped as JSON. */
export type Bm25Index = {
  k1: number;
  b: number;
  avgLen: number;
  /** term -> inverse document frequency */
  idf: Record<string, number>;
  /** per passage: term -> frequency, and length */
  docs: { tf: Record<string, number>; len: number }[];
};

export function buildBm25(passages: Passage[], k1 = 1.2, b = 0.75): Bm25Index {
  const docs = passages.map((p) => {
    // The title is part of what a passage is about, so it is indexed with the text
    const tokens = tokenize(`${p.title} ${p.text}`);
    const tf: Record<string, number> = {};
    for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
    return { tf, len: tokens.length };
  });
  const df: Record<string, number> = {};
  for (const d of docs) for (const t of Object.keys(d.tf)) df[t] = (df[t] ?? 0) + 1;
  const n = docs.length;
  const idf: Record<string, number> = {};
  for (const [t, f] of Object.entries(df)) idf[t] = Math.log(1 + (n - f + 0.5) / (f + 0.5));
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, n);
  return { k1, b, avgLen, idf, docs };
}

/** How much a passage's score grows when its title contains every word the question asked */
export const TITLE_BOOST = 0.6;

export function searchBm25(index: Bm25Index, passages: Passage[], query: string, k = 8): Hit[] {
  const asked = [...new Set(tokenize(query))];
  const terms = expandQuery(query);
  const { k1, b, avgLen, idf } = index;
  return index.docs
    .map((d, i) => {
      let score = 0;
      for (const t of terms) {
        const f = d.tf[t];
        if (!f) continue;
        score += (idf[t] ?? 0) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen)));
      }
      // A passage titled with what was asked about is about it, not just mentioning it:
      // "What is Outfit Picker?" should land on the Outfit Picker card, not a skills list
      // that names Outfit Picker three times
      if (score > 0 && asked.length) {
        const title = new Set(tokenize(passages[i].title));
        score *= 1 + TITLE_BOOST * (asked.filter((t) => title.has(t)).length / asked.length);
      }
      return { passage: passages[i], score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k);
}
