export interface RawError {
  message: string;
  stackLocation: string | null;
  httpStatus: number | null;
  source: string;
  releaseVersion: string;
  timestamp: number;
}

interface VercelConfig {
  apiToken: string;
  projectId: string;
  teamId: string;
}

interface VercelDeployment {
  uid: string;
  meta?: { githubCommitSha?: string };
  created: number;
}

interface VercelLogEntry {
  level: string;
  message: string;
  responseStatusCode?: number;
  requestPath?: string;
  requestMethod?: string;
  source?: string;
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
    const errors: RawError[] = [];

    for (const deployment of deployments) {
      const logs = await this.fetchDeploymentLogs(deployment.uid);
      const commitSha = deployment.meta?.githubCommitSha ?? "unknown";

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
        });
      }
    }

    return errors;
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

  private extractStackLocation(message: string): string | null {
    const match = message.match(/at\s+(\S+)\s+\(([^)]+)\)/);
    if (match) return `${match[1]} (${match[2]})`;

    const fileMatch = message.match(/([^\s]+\.[jt]sx?:\d+:\d+)/);
    if (fileMatch) return fileMatch[1];

    return null;
  }
}
