// TODO: Import RawError from ./vercel.js once that module exists
// import type { RawError } from "./vercel.js";

export interface RawError {
  message: string;
  stackLocation: string | null;
  httpStatus: number | null;
  source: string;
  releaseVersion: string;
  timestamp: number;
}

interface CloudflareConfig {
  apiToken: string;
  accountId: string;
  scriptName: string;
}

interface ObservabilityEvent {
  $metadata: {
    id: string;
    error?: string;
    level: string;
    message?: string;
    service: string;
    statusCode?: number;
    startTime?: number;
    endTime?: number;
    traceId?: string;
  };
  timestamp: number;
}

export class CloudflareSource {
  private config: CloudflareConfig;
  private repoName = "source-cooperative/data.source.coop";

  constructor(config: CloudflareConfig) {
    this.config = config;
  }

  async fetchErrors(windowHours: number): Promise<RawError[]> {
    const now = Date.now();
    const from = now - windowHours * 60 * 60 * 1000;

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/workers/observability/telemetry/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          timeframe: { from, to: now },
          view: "events",
          parameters: {
            filters: [
              { key: "$metadata.level", operation: "eq", type: "string", value: "error" },
              { key: "$metadata.service", operation: "eq", type: "string", value: this.config.scriptName },
            ],
            filterCombination: "and",
            limit: 500,
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`CF Observability API error: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      result: { events: { events: ObservabilityEvent[] } };
    };

    if (!data.success) {
      throw new Error(`CF Observability query failed`);
    }

    return data.result.events.events.map((event) => ({
      message: event.$metadata.message ?? event.$metadata.error ?? "Unknown error",
      stackLocation: null,
      httpStatus: event.$metadata.statusCode ?? null,
      source: this.repoName,
      releaseVersion: "unknown",
      timestamp: event.timestamp,
    }));
  }
}
