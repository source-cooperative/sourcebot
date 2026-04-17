import type { RawError } from "./vercel.js";

interface CloudflareConfig {
  apiToken: string;
  accountId: string;
  scriptName: string;
  dashboardUrl?: string;
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
          queryId: "sourcebot-errors",
          timeframe: { from, to: now },
          view: "events",
          limit: 500,
          dry: true,
          parameters: {
            datasets: [],
            filters: [
              { key: "$metadata.level", operation: "eq", type: "string", value: "error" },
              { key: "$metadata.service", operation: "eq", type: "string", value: this.config.scriptName },
            ],
            filterCombination: "and",
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`CF Observability API error: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      result?: { events?: ObservabilityEvent[] | { events?: ObservabilityEvent[] } };
    };

    if (!data.success) {
      throw new Error(`CF Observability query failed: ${JSON.stringify(data)}`);
    }

    // The Observability telemetry/query response has shifted shape across versions;
    // `result.events` may be either the array directly or `{ events: [...] }`.
    const eventsField = data.result?.events;
    const events: ObservabilityEvent[] = Array.isArray(eventsField)
      ? eventsField
      : eventsField?.events ?? [];

    return events.map((event) => {
      const message = event.$metadata.message ?? event.$metadata.error ?? "Unknown error";
      const time = new Date(event.timestamp).toISOString();
      const rawLog = [
        `${time} [${event.$metadata.level}] ${event.$metadata.service}`,
        event.$metadata.statusCode ? `Status: ${event.$metadata.statusCode}` : null,
        event.$metadata.traceId ? `Trace: ${event.$metadata.traceId}` : null,
        "",
        message,
      ].filter(Boolean).join("\n");

      return {
        message,
        stackLocation: null,
        httpStatus: event.$metadata.statusCode ?? null,
        source: this.repoName,
        releaseVersion: "unknown",
        timestamp: event.timestamp,
        dashboardUrl: this.config.dashboardUrl ?? null,
        rawLog,
      };
    });
  }
}
