// src/d1.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { D1Client } from "./d1.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("D1Client", () => {
  const client = new D1Client({
    accountId: "test-account",
    databaseId: "test-db",
    apiToken: "test-token",
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("executes a query with params", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        result: [{ success: true, results: [{ id: 1 }], meta: {} }],
      }),
    });

    const result = await client.query("SELECT * FROM errors WHERE fingerprint = ?", ["abc"]);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/test-account/d1/database/test-db/query",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
        body: JSON.stringify({ sql: "SELECT * FROM errors WHERE fingerprint = ?", params: ["abc"] }),
      })
    );
    expect(result).toEqual([{ id: 1 }]);
  });

  it("throws on API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Invalid token",
    });

    await expect(client.query("SELECT 1")).rejects.toThrow("D1 API error: 401");
  });
});
