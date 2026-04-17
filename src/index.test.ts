// src/index.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runMonitor, type MonitorDeps } from "./index.js";
import { computeFingerprint } from "./fingerprint.js";

describe("runMonitor", () => {
  let mockDeps: MonitorDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDeps = {
      vercelSource: { fetchErrors: vi.fn().mockResolvedValue([]) },
      cloudflareSource: { fetchErrors: vi.fn().mockResolvedValue([]) },
      d1: {
        query: vi.fn().mockResolvedValue([{ id: 1 }]),
        execute: vi.fn().mockResolvedValue(undefined),
        batch: vi.fn().mockResolvedValue(undefined),
      },
      github: {
        createIssue: vi.fn().mockResolvedValue({ number: 1, html_url: "https://github.com/test", state: "open" }),
        commentOnIssue: vi.fn().mockResolvedValue(undefined),
        reopenIssue: vi.fn().mockResolvedValue(undefined),
        addLabels: vi.fn().mockResolvedValue(undefined),
        triggerWorkflowDispatch: vi.fn().mockResolvedValue(undefined),
      },
      classifier: {
        classify: vi.fn().mockResolvedValue([]),
      },
      config: {
        repos: [
          { name: "source-cooperative/source.coop", log_source: "vercel" as const, vercel_project_id: "prj_test", auto_fix: false },
          { name: "source-cooperative/data.source.coop", log_source: "cloudflare_workers" as const, cloudflare_script_name: "test", auto_fix: true },
        ],
        schedule: "0 */6 * * *",
        comment_cadence_days: 7,
        anthropic_model: "claude-sonnet-4-6",
        window_hours: 6,
      },
    };
  });

  it("fetches from all sources", async () => {
    await runMonitor(mockDeps);
    expect(mockDeps.vercelSource.fetchErrors).toHaveBeenCalledWith(6);
    expect(mockDeps.cloudflareSource.fetchErrors).toHaveBeenCalledWith(6);
  });

  it("creates issues for new errors", async () => {
    (mockDeps.vercelSource.fetchErrors as any).mockResolvedValueOnce([
      { message: "TypeError: x", stackLocation: "a.ts:1", httpStatus: 500, source: "source-cooperative/source.coop", releaseVersion: "v1", timestamp: Date.now(), dashboardUrl: null, rawLog: null },
    ]);
    (mockDeps.d1.query as any).mockResolvedValueOnce([]);
    (mockDeps.classifier.classify as any).mockResolvedValueOnce([
      { title: "TypeError", body: "Details", fingerprints: ["fp1"], repo: "source-cooperative/source.coop" },
    ]);

    await runMonitor(mockDeps);
    expect(mockDeps.github.createIssue).toHaveBeenCalled();
  });

  it("self-assigns when auto_fix is true", async () => {
    (mockDeps.cloudflareSource.fetchErrors as any).mockResolvedValueOnce([
      { message: "Error", stackLocation: null, httpStatus: 502, source: "source-cooperative/data.source.coop", releaseVersion: "v1", timestamp: Date.now(), dashboardUrl: null, rawLog: null },
    ]);
    (mockDeps.d1.query as any).mockResolvedValueOnce([]);
    (mockDeps.classifier.classify as any).mockResolvedValueOnce([
      { title: "Error", body: "Details", fingerprints: ["fp2"], repo: "source-cooperative/data.source.coop" },
    ]);

    await runMonitor(mockDeps);
    expect(mockDeps.github.addLabels).toHaveBeenCalled();
  });

  it("does not self-assign when auto_fix is false", async () => {
    (mockDeps.vercelSource.fetchErrors as any).mockResolvedValueOnce([
      { message: "Error", stackLocation: null, httpStatus: 500, source: "source-cooperative/source.coop", releaseVersion: "v1", timestamp: Date.now(), dashboardUrl: null, rawLog: null },
    ]);
    (mockDeps.d1.query as any).mockResolvedValueOnce([]);
    (mockDeps.classifier.classify as any).mockResolvedValueOnce([
      { title: "Error", body: "Details", fingerprints: ["fp3"], repo: "source-cooperative/source.coop" },
    ]);

    await runMonitor(mockDeps);
    expect(mockDeps.github.addLabels).not.toHaveBeenCalled();
  });

  it("reopens closed issues on new release version", async () => {
    const fp = computeFingerprint("TypeError: x", "a.ts:1", 500);
    (mockDeps.vercelSource.fetchErrors as any).mockResolvedValueOnce([
      { message: "TypeError: x", stackLocation: "a.ts:1", httpStatus: 500, source: "source-cooperative/source.coop", releaseVersion: "v2.0.0", timestamp: Date.now(), dashboardUrl: null, rawLog: null },
    ]);
    (mockDeps.d1.query as any).mockResolvedValueOnce([
      {
        fingerprint: fp,
        repo: "source-cooperative/source.coop",
        github_issue_number: 42,
        github_issue_state: "closed",
        release_versions: '["v1.0.0"]',
        last_commented_at: null,
      },
    ]);

    await runMonitor(mockDeps);
    expect(mockDeps.github.reopenIssue).toHaveBeenCalled();
    expect(mockDeps.github.commentOnIssue).toHaveBeenCalled();
  });

  it("comments weekly on open issues", async () => {
    const fp = computeFingerprint("TypeError: x", "a.ts:1", 500);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    (mockDeps.vercelSource.fetchErrors as any).mockResolvedValueOnce([
      { message: "TypeError: x", stackLocation: "a.ts:1", httpStatus: 500, source: "source-cooperative/source.coop", releaseVersion: "v1", timestamp: Date.now(), dashboardUrl: null, rawLog: null },
    ]);
    (mockDeps.d1.query as any).mockResolvedValueOnce([
      {
        fingerprint: fp,
        repo: "source-cooperative/source.coop",
        github_issue_number: 10,
        github_issue_state: "open",
        release_versions: '["v1"]',
        last_commented_at: eightDaysAgo,
      },
    ]);

    await runMonitor(mockDeps);
    expect(mockDeps.github.commentOnIssue).toHaveBeenCalled();
  });
});
