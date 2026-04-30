import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

interface ClassifierConfig {
  model: string;
}



export interface ErrorForClassification {
  fingerprint: string;
  message: string;
  stackLocation: string | null;
  httpStatus: number | null;
  source: string;
  releaseVersion: string;
  count: number;
}

export interface ClassifiedErrorGroup {
  title: string;
  body: string;
  fingerprints: string[];
  repo: string;
}

const SYSTEM_PROMPT =
  "You are an error triage bot for Source Cooperative. Analyze the errors the user provides, group related ones (same root cause), and write a GitHub issue for each group. Respond with ONLY a JSON array, no other text or markdown.";

export class ErrorClassifier {
  private model: string;

  constructor(config: ClassifierConfig) {
    this.model = config.model;
  }

  async classify(errors: ErrorForClassification[]): Promise<ClassifiedErrorGroup[]> {
    if (errors.length === 0) return [];

    const errorList = errors
      .map(
        (e, i) =>
          `Error ${i + 1}:
  Fingerprint: ${e.fingerprint}
  Message: ${e.message}
  Stack: ${e.stackLocation ?? "unknown"}
  HTTP Status: ${e.httpStatus ?? "N/A"}
  Repo: ${e.source}
  Release: ${e.releaseVersion}
  Occurrences (last window): ${e.count}`
      )
      .join("\n\n");

    const prompt = `${errorList}

Respond with a JSON array. Each element:
{
  "title": "[repo-short-name] Brief error description",
  "body": "Markdown issue body with: ## Error Summary, ## Details (occurrences, release version, sample stack trace), ## Probable Cause",
  "fingerprints": ["list", "of", "fingerprint", "ids", "in", "this", "group"],
  "repo": "owner/repo"
}

Respond with ONLY the JSON array, no other text.`;

    const options: Options = {
      model: this.model,
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: 1,
      tools: [],
      settingSources: [],
    };

    let resultText: string | null = null;
    for await (const message of query({ prompt, options })) {
      if (message.type === "result") {
        if (message.subtype !== "success") {
          throw new Error(`Classifier query failed: ${message.subtype}`);
        }
        resultText = message.result;
      }
    }

    if (resultText === null) {
      throw new Error("Classifier returned no result message");
    }

    // Strip markdown code fences if present
    let jsonText = resultText.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error(`Failed to parse classifier response as JSON: ${jsonText.slice(0, 200)}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`Classifier response is not an array: ${jsonText.slice(0, 200)}`);
    }

    for (const item of parsed) {
      if (!item.title || !item.body || !Array.isArray(item.fingerprints) || !item.repo) {
        throw new Error(`Invalid classified error group: ${JSON.stringify(item).slice(0, 200)}`);
      }
    }

    return parsed as ClassifiedErrorGroup[];
  }
}
