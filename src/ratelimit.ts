/**
 * Fixed-window rate limit on Upstash Redis over its REST API (no SDK needed).
 * Only a hash of the visitor's IP is stored, and it expires with the window.
 * If Upstash is not configured or unreachable, requests are allowed: a broken limiter
 * should not take the assistant down with it.
 */
export async function rateLimit(
  ip: string,
  { url, token, limit = 10, windowSeconds = 600 }: { url?: string; token?: string; limit?: number; windowSeconds?: number },
): Promise<{ allowed: boolean; remaining: number }> {
  if (!url || !token) return { allowed: true, remaining: limit };
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `ask:${await sha256(ip)}:${window}`;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      signal: AbortSignal.timeout(1500),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, String(windowSeconds)],
      ]),
    });
    if (!res.ok) return { allowed: true, remaining: limit };
    const [{ result: count }] = (await res.json()) as { result: number }[];
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  } catch {
    return { allowed: true, remaining: limit };
  }
}

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ask-rishabh:${text}`));
  return [...new Uint8Array(bytes)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
