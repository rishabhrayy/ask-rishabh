/** A source document before chunking: one page, or one section of a page. */
export type Doc = {
  /** Stable id, e.g. "home#work" */
  id: string;
  /** Page title or section heading shown to the reader */
  title: string;
  /** Public URL the passage can be read at, with an anchor when there is one */
  url: string;
  text: string;
};

/** A retrievable passage: a slice of a Doc small enough to put in a prompt. */
export type Passage = {
  id: string;
  docId: string;
  title: string;
  url: string;
  text: string;
};

export type Hit = { passage: Passage; score: number };

/** A chat-completions endpoint that speaks the OpenAI format (Groq, Gemini, OpenRouter...). */
export type Provider = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Reasoning models spend tokens before answering, so they need a bigger budget */
  maxTokens?: number;
  /** Extra request fields for this provider, e.g. { reasoning_effort: 'low' } */
  extraBody?: Record<string, unknown>;
};

/** What /api/ask streams back, one JSON object per line. */
export type AskEvent =
  | { type: 'sources'; sources: { n: number; title: string; url: string }[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; mode: 'model' | 'fallback' | 'refused'; provider?: string }
  | { type: 'error'; message: string };
