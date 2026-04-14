// src/classifier.test.ts
import { describe, it, expect, vi } from "vitest";
import { ErrorClassifier, type ClassifiedErrorGroup } from "./classifier.js";

describe("ErrorClassifier", () => {
  it("calls Anthropic API and parses structured response", async () => {
    const mockCreate = vi.fn().mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            {
              title: "[source.coop] TypeError in API handler",
              body: "## Error Summary\nTypeError: Cannot read properties of undefined\n\n## Details\n- **Occurrences:** 15 in the last 6 hours\n- **Release:** v1.2.3\n- **Stack:** api/handler.ts:42\n\n## Probable Cause\nMissing null check on user input.",
              fingerprints: ["abc123"],
              repo: "source-cooperative/source.coop",
            },
          ] satisfies ClassifiedErrorGroup[]),
        },
      ],
    });

    const classifier = new ErrorClassifier({
      apiKey: "test-key",
      model: "claude-sonnet-4-6",
    });

    // Replace the client's create method
    (classifier as any).client = { messages: { create: mockCreate } };

    const groups = await classifier.classify([
      {
        fingerprint: "abc123",
        message: "TypeError: Cannot read properties of undefined",
        stackLocation: "api/handler.ts:42",
        httpStatus: 500,
        source: "source-cooperative/source.coop",
        releaseVersion: "v1.2.3",
        count: 15,
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].title).toContain("TypeError");
    expect(groups[0].fingerprints).toContain("abc123");
  });

  it("returns empty array for no errors", async () => {
    const classifier = new ErrorClassifier({
      apiKey: "test-key",
      model: "claude-sonnet-4-6",
    });

    const groups = await classifier.classify([]);
    expect(groups).toEqual([]);
  });
});
