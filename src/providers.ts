import type { Provider } from './types.ts';

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * Streams a chat completion from any OpenAI-compatible endpoint (Groq, Gemini's compatibility
 * endpoint, OpenRouter...). Yields text as it arrives. Throws if the request fails or no text
 * arrives within `firstTokenMs`, so the caller can move on to the next provider.
 */
export async function* streamChat(
  provider: Provider,
  messages: Message[],
  { firstTokenMs = 9000, signal }: { firstTokenMs?: number; signal?: AbortSignal } = {},
): AsyncGenerator<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, firstTokenMs);
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        messages,
        stream: true,
        temperature: 0.2,
        max_tokens: provider.maxTokens ?? 600,
      }),
    });
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`${provider.name} ${res.status}: ${detail}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const strip = thinkStripper();
    let buffer = '';
    let started = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const data = line.replace(/^data:\s*/, '').trim();
        if (!data || data === '[DONE]' || !line.startsWith('data:')) continue;
        let delta = '';
        try {
          delta = JSON.parse(data).choices?.[0]?.delta?.content ?? '';
        } catch {
          continue;
        }
        const text = strip(delta);
        if (!text) continue;
        if (!started) {
          started = true;
          clearTimeout(timer); // the first-token deadline is met; let the answer finish
        }
        yield text;
      }
    }
    if (!started) throw new Error(`${provider.name}: empty reply`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** Reasoning models may stream "<think>...</think>" before the answer. Visitors should not see it. */
export function thinkStripper() {
  let inThink = false;
  let pending = '';
  let emitted = false;
  const strip = (chunk: string): string => {
    pending += chunk;
    let out = '';
    for (;;) {
      if (inThink) {
        const end = pending.indexOf('</think>');
        if (end === -1) {
          pending = pending.slice(-8); // keep a tail in case the tag is split across chunks
          return out;
        }
        pending = pending.slice(end + 8);
        inThink = false;
      } else {
        const start = pending.indexOf('<think>');
        if (start === -1) {
          // hold back a possible partial "<think" at the end
          const safe = pending.length - partialTagLength(pending);
          out += pending.slice(0, safe);
          pending = pending.slice(safe);
          return out;
        }
        out += pending.slice(0, start);
        pending = pending.slice(start + 7);
        inThink = true;
      }
    }
  };
  // Whitespace left over after a stripped think block should not open the answer
  return (chunk: string): string => {
    let text = strip(chunk);
    if (!emitted) text = text.replace(/^\s+/, '');
    if (text) emitted = true;
    return text;
  };
}

function partialTagLength(s: string): number {
  const tag = '<think>';
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(-n))) return n;
  return 0;
}

/** Embeds texts with an OpenAI-compatible /embeddings endpoint and returns unit-length vectors. */
export async function embed(provider: Provider, texts: string[], { timeoutMs = 15000 } = {}): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 96) {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ model: provider.model, input: texts.slice(i, i + 96) }),
    });
    if (!res.ok) throw new Error(`${provider.name} embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    for (const d of json.data.sort((a, b) => a.index - b.index)) out.push(normalise(d.embedding));
  }
  return out;
}

function normalise(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => Number((x / n).toFixed(5)));
}
