// src/classifier.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ErrorClassifier, type ClassifiedErrorGroup } from "./classifier.js";

const queryMock = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => queryMock(params),
}));

function mockResult(resultText: string) {
  queryMock.mockImplementationOnce(() =>
    (async function* () {
      yield { type: "result", subtype: "success", result: resultText };
    })()
  );
}

describe("ErrorClassifier", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("calls the agent SDK and parses structured response", async () => {
    const groups: ClassifiedErrorGroup[] = [
      {
        title: "[source.coop] TypeError in API handler",
        body: "## Error Summary\nTypeError: Cannot read properties of undefined\n\n## Details\n- **Occurrences:** 15 in the last 6 hours\n- **Release:** v1.2.3\n- **Stack:** api/handler.ts:42\n\n## Probable Cause\nMissing null check on user input.",
        fingerprints: ["abc123"],
        repo: "source-cooperative/source.coop",
      },
    ];
    mockResult(JSON.stringify(groups));

    const classifier = new ErrorClassifier({ model: "claude-sonnet-4-6" });

    const result = await classifier.classify([
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

    expect(result).toHaveLength(1);
    expect(result[0].title).toContain("TypeError");
    expect(result[0].fingerprints).toContain("abc123");
    expect(queryMock).toHaveBeenCalledOnce();
  });

  it("strips markdown code fences from the response", async () => {
    const groups: ClassifiedErrorGroup[] = [
      {
        title: "[repo] Error",
        body: "body",
        fingerprints: ["x"],
        repo: "owner/repo",
      },
    ];
    mockResult("```json\n" + JSON.stringify(groups) + "\n```");

    const classifier = new ErrorClassifier({ model: "claude-sonnet-4-6" });

    const result = await classifier.classify([
      {
        fingerprint: "x",
        message: "msg",
        stackLocation: null,
        httpStatus: null,
        source: "owner/repo",
        releaseVersion: "v1",
        count: 1,
      },
    ]);

    expect(result).toHaveLength(1);
  });

  it("returns empty array for no errors without calling the SDK", async () => {
    const classifier = new ErrorClassifier({ model: "claude-sonnet-4-6" });

    const result = await classifier.classify([]);
    expect(result).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
