// Transient-failure retry for LLM HTTP calls.
//
// Free tiers (Gemini especially) answer bursts with 503 "model is currently
// experiencing high demand" or short-window 429s. Surfacing those straight to
// the agent loop kills the whole task over a hiccup that a few seconds of
// waiting would fix. Retries happen BEFORE any stream byte is consumed, so
// they are invisible to the SSE parsers.

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface RetryOptions {
  /** Total attempts including the first one. */
  attempts?: number;
  /** First backoff in ms; doubles each retry (plus jitter). */
  baseDelayMs?: number;
  /** Upper bound for a single wait, including Retry-After. */
  maxDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal!.reason ?? new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Seconds or HTTP-date → ms; undefined when absent/unparseable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** A daily/project quota 429 will not clear in seconds — don't burn retries on it. */
async function isHardQuota(res: Response): Promise<boolean> {
  if (res.status !== 429) return false;
  try {
    const text = await res.clone().text();
    return /PerDay|per day|budget_exceeded|insufficient_quota|billing/i.test(text);
  } catch {
    return false;
  }
}

/** Unit tests mock fetch with canned error responses; don't make them sleep. */
const UNDER_TEST = typeof process !== "undefined" && !!process.env?.VITEST;

/**
 * fetch() with retry on transient HTTP statuses and network errors.
 * Returns the last Response (possibly non-ok) so callers keep their existing
 * error mapping; rethrows the last network error; aborts promptly.
 */
export async function fetchWithRetry(
  input: string,
  init: RequestInit & { signal?: AbortSignal },
  opts: RetryOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? (UNDER_TEST ? 1 : 4);
  const base = opts.baseDelayMs ?? 2000;
  const cap = opts.maxDelayMs ?? 30000;
  const sleep = opts.sleep ?? abortableSleep;
  const signal = init.signal;

  for (let i = 1; ; i++) {
    let res: Response | undefined;
    let netErr: unknown;
    try {
      res = await fetch(input, init);
    } catch (e) {
      if (signal?.aborted) throw e;
      netErr = e;
    }

    const last = i >= attempts;
    if (res) {
      if (res.ok || !RETRYABLE_STATUS.has(res.status) || last || (await isHardQuota(res))) return res;
    } else if (last) {
      throw netErr;
    }

    const backoff = base * 2 ** (i - 1) + Math.floor(Math.random() * 500);
    const hinted = res ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
    const wait = Math.min(cap, hinted ?? backoff);
    console.warn(`[llm] ${res ? `HTTP ${res.status}` : "network error"} — retry ${i}/${attempts - 1} in ${wait}ms`);
    await res?.body?.cancel().catch(() => {});
    await sleep(wait, signal);
  }
}
