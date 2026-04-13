// src/github.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GitHubClient } from "./github.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

// Generate a real RSA keypair for testing
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

describe("GitHubClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("creates an issue", async () => {
    // Mock installation token fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "ghs_test_token", expires_at: "2099-01-01T00:00:00Z" }),
    });

    // Mock issue creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 42, html_url: "https://github.com/org/repo/issues/42", state: "open" }),
    });

    const client = new GitHubClient({
      appId: "12345",
      privateKey: TEST_PRIVATE_KEY,
      installationId: "67890",
    });

    const issue = await client.createIssue("org/repo", {
      title: "Test error",
      body: "Error details",
      labels: ["sourcebot"],
    });

    expect(issue.number).toBe(42);
  });

  it("comments on an issue", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "ghs_test_token", expires_at: "2099-01-01T00:00:00Z" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1 }),
    });

    const client = new GitHubClient({
      appId: "12345",
      privateKey: TEST_PRIVATE_KEY,
      installationId: "67890",
    });

    await client.commentOnIssue("org/repo", 42, "Still seeing this error");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("reopens an issue", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "ghs_test_token", expires_at: "2099-01-01T00:00:00Z" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 42, state: "open" }),
    });

    const client = new GitHubClient({
      appId: "12345",
      privateKey: TEST_PRIVATE_KEY,
      installationId: "67890",
    });

    await client.reopenIssue("org/repo", 42);
    const call = mockFetch.mock.calls[1];
    expect(call[1].method).toBe("PATCH");
    expect(JSON.parse(call[1].body)).toEqual({ state: "open" });
  });

  it("caches installation token", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "ghs_test_token", expires_at: "2099-01-01T00:00:00Z" }),
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 1 }),
    });

    const client = new GitHubClient({
      appId: "12345",
      privateKey: TEST_PRIVATE_KEY,
      installationId: "67890",
    });

    await client.commentOnIssue("org/repo", 1, "a");
    await client.commentOnIssue("org/repo", 2, "b");

    // Only 1 token fetch + 2 API calls = 3 total
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
