export interface RawError {
  message: string;
  stackLocation: string | null;
  httpStatus: number | null;
  source: string;
  releaseVersion: string;
  timestamp: number;
  dashboardUrl: string | null;
  rawLog: string | null;
}

interface VercelConfig {
  apiToken: string;
  projectId: string;
  teamId: string;
  dashboardUrl?: string;
}

interface VercelDeployment {
  uid: string;
  meta?: { githubCommitSha?: string };
  created: number;
}

interface VercelLogEntry {
  level: "trace" | "debug" | "info" | "warning" | "error" | "fatal";
  message: string;
  messageTruncated: boolean;
  responseStatusCode: number;
  requestPath: string;
  requestMethod: string;
  source: "delimiter" | "edge-function" | "edge-middleware" | "serverless" | "request";
  domain: string;
  rowId: string;
  timestampInMs: number;
}

export class VercelSource {
  private config: VercelConfig;
  private repoName = "source-cooperative/source.coop";

  constructor(config: VercelConfig) {
    this.config = config;
  }

  async fetchErrors(windowHours: number): Promise<RawError[]> {
    const since = Date.now() - windowHours * 60 * 60 * 1000;
    const deployments = await this.listRecentDeployments(since);

    const results = await Promise.all(
      deployments.map(async (deployment) => {
        const logs = await this.fetchDeploymentLogs(deployment.uid);
        const commitSha = deployment.meta?.githubCommitSha ?? "unknown";
        const errors: RawError[] = [];

        for (const log of logs) {
          if (log.timestampInMs < since) continue;
          if (log.level !== "error" && (log.responseStatusCode ?? 200) < 500) continue;

          errors.push({
            message: log.message,
            stackLocation: this.extractStackLocation(log.message),
            httpStatus: log.responseStatusCode ?? null,
            source: this.repoName,
            releaseVersion: commitSha,
            timestamp: log.timestampInMs,
            dashboardUrl: this.buildDashboardUrl(log.timestampInMs),
            rawLog: this.formatRawLog(log),
          });
        }

        return errors;
      })
    );

    return results.flat();
  }

  private async listRecentDeployments(since: number): Promise<VercelDeployment[]> {
    const params = new URLSearchParams({
      projectId: this.config.projectId,
      since: since.toString(),
      limit: "20",
      state: "READY",
      teamId: this.config.teamId,
    });

    const response = await fetch(`https://api.vercel.com/v6/deployments?${params}`, {
      headers: { Authorization: `Bearer ${this.config.apiToken}` },
    });

    if (!response.ok) {
      throw new Error(`Vercel deployments API error: ${response.status}`);
    }

    const data = (await response.json()) as { deployments: VercelDeployment[] };
    return data.deployments;
  }

  private async fetchDeploymentLogs(deploymentId: string): Promise<VercelLogEntry[]> {
    const params = new URLSearchParams({ teamId: this.config.teamId });
    const url = `https://api.vercel.com/v1/projects/${this.config.projectId}/deployments/${deploymentId}/runtime-logs?${params}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.apiToken}` },
    });

    if (!response.ok) {
      throw new Error(`Vercel runtime logs API error: ${response.status}`);
    }

    // Vercel runtime-logs may return either a JSON array or NDJSON depending on
    // API version and Accept header. Handle both.
    const text = (await response.text()).trim();
    if (!text) return [];
    if (text.startsWith("[")) {
      return JSON.parse(text) as VercelLogEntry[];
    }
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as VercelLogEntry);
  }

  private formatRawLog(log: VercelLogEntry): string {
    const time = new Date(log.timestampInMs).toISOString();
    const lines = [
      `${time} [${log.level}] ${log.source}`,
      `${log.requestMethod} ${log.requestPath} → ${log.responseStatusCode}`,
      `Host: ${log.domain}`,
      "",
      log.message,
    ];
    return lines.join("\n");
  }

  private buildDashboardUrl(timestampMs: number): string | null {
    if (!this.config.dashboardUrl) return null;
    const margin = 60_000; // ±1 minute around the error
    const params = new URLSearchParams({
      timeline: "custom",
      startDate: String(timestampMs - margin),
      endDate: String(timestampMs + margin),
      levels: "error",
    });
    return `${this.config.dashboardUrl}?${params}`;
  }

  private extractStackLocation(message: string): string | null {
    const match = message.match(/at\s+(\S+)\s+\(([^)]+)\)/);
    if (match) return `${match[1]} (${match[2]})`;

    const fileMatch = message.match(/([^\s]+\.[jt]sx?:\d+:\d+)/);
    if (fileMatch) return fileMatch[1];

    return null;
  }
}
