import { describe, it, expect, vi, beforeEach } from "vitest";
import { CloudflareSource } from "./cloudflare.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

const now = Date.now();
const issue = (over: Record<string, unknown>) => ({
  id: "i1",
  service: "source-data-proxy",
  title: "HttpServerError · HTTP 520",
  type: "exception",
  status: "active",
  count: 42,
  firstObserved: now - 60_000,
  lastObserved: now - 1_000,
  ...over,
});
const page = (issues: unknown[]) => ({ ok: true, json: async () => ({ success: true, result: issues }) });

describe("CloudflareSource", () => {
  const source = new CloudflareSource({
    apiToken: "test-token",
    accountId: "test-account",
    scriptName: "source-data-proxy",
    issuesSince: new Date(now - 3_600_000).toISOString(),
  });

  beforeEach(() => mockFetch.mockReset());

  it("maps a Workers Issue to an error carrying its running total", async () => {
    mockFetch.mockResolvedValueOnce(page([issue({})]));
    const errors = await source.fetchErrors(6);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: "HttpServerError · HTTP 520",
      httpStatus: 520,
      count: 42,
      countIsTotal: true,
      source: "source-cooperative/data.source.coop",
    });
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toContain("/workers/observability/issues");
    expect(url.searchParams.get("service")).toBe("source-data-proxy");
  });

  it("skips scans, other services, stale groups and groups older than issuesSince", async () => {
    mockFetch.mockResolvedValueOnce(
      page([
        issue({ id: "scan", type: "security", title: "Potential vulnerability scan" }),
        issue({ id: "other", service: "something-else" }),
        issue({ id: "stale", lastObserved: now - 7 * 3_600_000 }),
        issue({ id: "old", firstObserved: now - 2 * 3_600_000 }),
        issue({ id: "keep", title: "[ERROR] backend STS transport error" }),
      ])
    );
    const errors = await source.fetchErrors(6);
    expect(errors.map((e) => e.message)).toEqual(["[ERROR] backend STS transport error"]);
    expect(errors[0].httpStatus).toBeNull();
  });

  it("pages until a short page", async () => {
    const full = Array.from({ length: 100 }, (_, n) => issue({ id: `i${n}`, title: `E${n}` }));
    mockFetch.mockResolvedValueOnce(page(full)).mockResolvedValueOnce(page([issue({ id: "last" })]));
    const errors = await source.fetchErrors(6);
    expect(errors).toHaveLength(101);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
