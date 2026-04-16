// src/github.ts
import { createPrivateKey, createSign } from "node:crypto";

interface GitHubClientConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

interface IssueOptions {
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
}

interface Issue {
  number: number;
  html_url: string;
  state: string;
}

export class GitHubClient {
  private config: GitHubClientConfig;
  private token: string | null = null;
  private tokenExpiresAt: Date | null = null;

  constructor(config: GitHubClientConfig) {
    this.config = config;
  }

  private generateJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.config.appId })
    ).toString("base64url");

    const key = createPrivateKey(this.config.privateKey);
    const sign = createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(key, "base64url");

    return `${header}.${payload}.${signature}`;
  }

  private async getInstallationToken(): Promise<string> {
    const skewMs = 60_000;
    if (this.token && this.tokenExpiresAt && this.tokenExpiresAt.getTime() - skewMs > Date.now()) {
      return this.token;
    }

    const jwt = this.generateJwt();
    const response = await fetch(
      `https://api.github.com/app/installations/${this.config.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub App token error: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as { token: string; expires_at: string };
    this.token = data.token;
    this.tokenExpiresAt = new Date(data.expires_at);
    return this.token;
  }

  private async request(method: string, url: string, body?: unknown): Promise<unknown> {
    const token = await this.getInstallationToken();
    const response = await fetch(`https://api.github.com${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }

  async createIssue(repo: string, options: IssueOptions): Promise<Issue> {
    return (await this.request("POST", `/repos/${repo}/issues`, {
      title: options.title,
      body: options.body,
      labels: options.labels ?? ["sourcebot"],
      assignees: options.assignees,
    })) as Issue;
  }

  async commentOnIssue(repo: string, issueNumber: number, body: string): Promise<void> {
    await this.request("POST", `/repos/${repo}/issues/${issueNumber}/comments`, { body });
  }

  async reopenIssue(repo: string, issueNumber: number): Promise<void> {
    await this.request("PATCH", `/repos/${repo}/issues/${issueNumber}`, { state: "open" });
  }

  async addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void> {
    await this.request("POST", `/repos/${repo}/issues/${issueNumber}/labels`, { labels });
  }

  async triggerWorkflowDispatch(
    repo: string,
    workflowId: string,
    ref: string,
    inputs: Record<string, string>
  ): Promise<void> {
    await this.request("POST", `/repos/${repo}/actions/workflows/${workflowId}/dispatches`, {
      ref,
      inputs,
    });
  }
}
