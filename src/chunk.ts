import type { Doc, Passage } from './types.ts';

/**
 * Splits documents into passages of roughly `maxChars` (about 350 tokens at the default),
 * packing whole paragraphs and only breaking inside one when it is too long on its own.
 * Each passage keeps its document's title and URL, so an answer can always cite where it came from.
 */
export function chunk(docs: Doc[], maxChars = 1400): Passage[] {
  const passages: Passage[] = [];
  for (const doc of docs) {
    const pieces = doc.text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .flatMap((p) => (p.length > maxChars ? splitSentences(p, maxChars) : [p]));

    let current = '';
    let n = 0;
    const flush = () => {
      if (!current) return;
      passages.push({ id: `${doc.id}::${n++}`, docId: doc.id, title: doc.title, url: doc.url, text: current });
      current = '';
    };
    for (const piece of pieces) {
      if (current && current.length + piece.length + 1 > maxChars) flush();
      current = current ? `${current}\n${piece}` : piece;
    }
    flush();
  }
  return passages;
}

function splitSentences(text: string, maxChars: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let current = '';
  for (const s of sentences.map((x) => x.trim())) {
    if (current && current.length + s.length + 1 > maxChars) {
      out.push(current);
      current = '';
    }
    current = current ? `${current} ${s}` : s;
  }
  if (current) out.push(current);
  return out;
}
