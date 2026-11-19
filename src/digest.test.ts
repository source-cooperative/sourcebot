import { describe, it, expect, vi } from "vitest";
import { runDigest, normalizeLogMessage, type DigestDeps } from "./digest.js";

const cfg = {
  repo: "source-cooperative/data.source.coop",
  script_name: "source-data-proxy",
  analytics_dataset: "source_data_proxy_production",
  days: 7,
};
const NOW = Date.parse("2026-11-19T12:00:00Z");

function deps(over: Partial<DigestDeps> = {}): DigestDeps {
  return {
    accountId: "acct",
    now: () => NOW,
    cf: vi.fn(async (path: string, init?: { body?: string }) => {
      if (path.startsWith("/alerting/v3/policies"))
        return { result: [{ name: "data-proxy: M7 Latency", enabled: true, description: "p99 > 5 s" }, { name: "other", enabled: true }] };
      if (path.startsWith("/alerting/v3/history"))
        return {
          result: [
            { name: "data-proxy: M7 Latency", sent: "2026-11-17T19:58:00Z", mechanism_type: "webhook", alert_body: "Notification Policy: data-proxy: M7 Latency\nTriggered Result: 9414" },
            { name: "data-proxy: M7 Latency", sent: "2026-11-17T19:58:00Z", mechanism_type: "email", alert_body: "{}" },
            { name: "data-proxy: M7 Latency", sent: "2026-11-17T20:13:00Z", mechanism_type: "webhook", alert_body: "Alert State: Resolved\nTriggered Result: 1571" },
          ],
        };
      if (path.startsWith("/workers/observability/issues"))
        return { result: [{ title: "HttpServerError · HTTP 520", type: "exception", count: 9754, firstObserved: NOW - 9e8, lastObserved: NOW - 1000 }, { title: "old", count: 1, firstObserved: 0, lastObserved: 0 }] };
      if (path === "/analytics/sql") {
        if (init?.body?.includes("substring(message"))
          return {
            data: [
              { level: "warn", msg: "[WARN] request failed { request_id=aaa, duration_ms=37.0, path=/ftw/benchmark-data/a/b.webp }", n: 10 },
              { level: "warn", msg: "[WARN] request failed { request_id=bbb, duration_ms=12.0, path=/ftw/benchmark-data/c.webp }", n: 5 },
            ],
          };
        return { data: [{ day: "2026-11-18", level: "warn", n: 40000 }] };
      }
      if (path === "/analytics_engine/sql") {
        if (init?.body?.includes("AS bucket"))
          return { data: [{ bucket: "a", read_p99_ms: 9000, requests: "10" }, { bucket: "b", read_p99_ms: 3600, requests: "400000" }] };
        return { data: [{ day: "2026-11-18", requests: "30000000" }] };
      }
      throw new Error(`unexpected ${path}`);
    }),
    listOpenIssues: vi.fn(async () => [{ number: 206, title: "Streamed PUTs intermittently 520" }]),
    summarize: vi.fn(async () => "*Headline*: fine."),
    post: vi.fn(async () => undefined),
    ...over,
  };
}

function facts(d: DigestDeps): any {
  const prompt = (d.summarize as any).mock.calls[0][1] as string;
  return JSON.parse(prompt.slice(prompt.indexOf("{")));
}

describe("runDigest", () => {
  it("gathers the week's data, has it summarized, and posts the summary", async () => {
    const d = deps();
    const text = await runDigest(d, cfg);
    expect(text).toBe("*Headline*: fine.");
    expect(d.post).toHaveBeenCalledWith("*Headline*: fine.");

    const f = facts(d);
    expect(f.window.from).toBe("2026-11-12T12:00:00.000Z");
    expect(f.monitors).toEqual([{ name: "data-proxy: M7 Latency", enabled: true, description: "p99 > 5 s" }]);
    // One event per notification: the webhook copy, not the duplicate email.
    expect(f.alertNotifications).toEqual([
      { policy: "data-proxy: M7 Latency", sent: "2026-11-17T19:58:00Z", state: "firing", value: "9414" },
      { policy: "data-proxy: M7 Latency", sent: "2026-11-17T20:13:00Z", state: "resolved", value: "1571" },
    ]);
    expect(f.workersIssues.map((i: any) => i.title)).toEqual(["HttpServerError · HTTP 520"]);
    // Windows with too little traffic to mean anything are dropped.
    expect(f.traffic.worstReadWindows15m).toEqual([{ bucket: "b", read_p99_ms: 3600, requests: "400000" }]);
    expect(f.logs.topWarnErrorSources).toEqual([
      { level: "warn", message: "[WARN] request failed { request_id=…, duration_ms=…, path=/ftw/benchmark-data/… }", count: 15 },
    ]);
    expect(f.openIssues).toEqual([{ number: 206, title: "Streamed PUTs intermittently 520" }]);

    const sql = (d.cf as any).mock.calls.filter((c: any[]) => c[0] === "/analytics_engine/sql").map((c: any[]) => c[1].body);
    expect(sql.every((s: string) => s.includes("FROM source_data_proxy_production") && s.endsWith("FORMAT JSON"))).toBe(true);
  });

  it("reports a failing source as unavailable instead of failing the digest", async () => {
    const d = deps({ listOpenIssues: vi.fn(async () => { throw new Error("403 Forbidden"); }) });
    await runDigest(d, cfg);
    expect(facts(d).openIssues.unavailable).toContain("403 Forbidden");
    expect(d.post).toHaveBeenCalled();
  });
});

describe("normalizeLogMessage", () => {
  it("keeps the account and product of a path but drops per-request detail", () => {
    expect(normalizeLogMessage("status=503, duration_ms=36.0, path=/a/b/c/d.tif, request_id=x1")).toBe(
      "status=503, duration_ms=…, path=/a/b/…, request_id=…"
    );
  });
});
