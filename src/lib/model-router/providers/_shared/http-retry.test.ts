import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithRetry, parseRetryAfter } from "./http-retry";

const r = (status: number, body = "", headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });
const noSleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
afterEach(() => { vi.restoreAllMocks(); noSleep.mockClear(); });

describe("fetchWithRetry", () => {
  it("retries 503 then returns the successful response", async () => {
    const f = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(r(503, "high demand"))
      .mockResolvedValueOnce(r(503, "high demand"))
      .mockResolvedValueOnce(r(200, "ok"));
    const res = await fetchWithRetry("u", {}, { attempts: 4, sleep: noSleep });
    expect(res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last attempt and returns the error response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => r(503));
    const res = await fetchWithRetry("u", {}, { attempts: 3, sleep: noSleep });
    expect(res.status).toBe(503);
    expect(noSleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient errors or daily-quota 429s", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(r(400));
    expect((await fetchWithRetry("u", {}, { attempts: 4, sleep: noSleep })).status).toBe(400);
    f.mockResolvedValueOnce(r(429, '{"error":{"details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}'));
    expect((await fetchWithRetry("u", {}, { attempts: 4, sleep: noSleep })).status).toBe(429);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("honours Retry-After (capped) and retries network errors", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(r(429, "slow down", { "retry-after": "120" }))
      .mockResolvedValueOnce(r(200));
    const res = await fetchWithRetry("u", {}, { attempts: 4, sleep: noSleep, maxDelayMs: 30000 });
    expect(res.status).toBe(200);
    expect(noSleep.mock.calls[1][0]).toBe(30000);
  });

  it("parseRetryAfter handles seconds and HTTP-date", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
