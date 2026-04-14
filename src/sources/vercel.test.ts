import { describe, it, expect, vi, beforeEach } from "vitest";
import { VercelSource } from "./vercel.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("VercelSource", () => {
  const source = new VercelSource({
    apiToken: "test-token",
    projectId: "prj_test",
    teamId: "team_test",
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("fetches deployments and filters error logs", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        deployments: [
          { uid: "dep1", meta: { githubCommitSha: "abc123" }, created: Date.now() - 3600000 },
        ],
      }),
    });

    const logLines = [
      JSON.stringify({ level: "error", message: "TypeError: Cannot read property", responseStatusCode: 500, timestampInMs: Date.now(), requestPath: "/api/test", source: "serverless" }),
      JSON.stringify({ level: "info", message: "Request completed", responseStatusCode: 200, timestampInMs: Date.now(), requestPath: "/api/ok", source: "serverless" }),
    ].join("\n");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => logLines,
    });

    const errors = await source.fetchErrors(6);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("TypeError");
    expect(errors[0].source).toBe("source-cooperative/source.coop");
    expect(errors[0].releaseVersion).toBe("abc123");
  });
});
