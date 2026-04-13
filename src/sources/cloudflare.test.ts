import { describe, it, expect, vi, beforeEach } from "vitest";
import { CloudflareSource } from "./cloudflare.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("CloudflareSource", () => {
  const source = new CloudflareSource({
    apiToken: "test-token",
    accountId: "test-account",
    scriptName: "data-source-coop",
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("fetches error events from Workers Observability API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          events: {
            events: [
              {
                "$metadata": {
                  id: "evt1",
                  error: "connection refused",
                  level: "error",
                  message: "Failed to fetch upstream",
                  service: "data-source-coop",
                  statusCode: 502,
                  startTime: Date.now() - 1000,
                },
                timestamp: Date.now() - 1000,
              },
            ],
          },
        },
      }),
    });

    const errors = await source.fetchErrors(6);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Failed to fetch upstream");
    expect(errors[0].httpStatus).toBe(502);
    expect(errors[0].source).toBe("source-cooperative/data.source.coop");
  });

  it("sends correct query with error filter", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, result: { events: { events: [] } } }),
    });

    await source.fetchErrors(6);

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.parameters.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "$metadata.level", operation: "eq", value: "error" }),
      ])
    );
  });
});
