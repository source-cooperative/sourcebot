# Sourcebot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an automated error monitoring bot that checks Vercel and Cloudflare Workers logs on a schedule, creates/manages GitHub Issues for errors, and can implement fixes via Claude Code when assigned to an issue.

**Architecture:** GitHub Actions workflows (cron for monitoring, reusable workflow for fixes). State in Cloudflare D1 via REST API. Anthropic API for error classification. GitHub App for issue/PR management.

**Tech Stack:** TypeScript (tsx), Anthropic SDK, GitHub App JWT auth, Cloudflare D1 REST API, Vercel REST API, CF Workers Observability API

---

## Prerequisites (Manual Steps)

Before implementation, these must be done by a human:

1. **Create Cloudflare D1 database** via dashboard or `wrangler d1 create sourcebot`
2. **Create GitHub App** named `sourcebot` with permissions: Issues (R/W), Pull Requests (R/W), Contents (R/W), Metadata (R). Subscribe to Issues events. Install on `source-cooperative` org.
3. **Configure GitHub Secrets** on `source-cooperative/sourcebot` repo:
   - `VERCEL_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`
   - `ANTHROPIC_API_KEY`, `SOURCEBOT_APP_ID`, `SOURCEBOT_APP_PRIVATE_KEY`
4. **Note the GitHub App installation ID** (from org settings → GitHub Apps → sourcebot → Configure → URL contains the installation ID)

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `config.yaml`
- Create: `schema.sql`

**Step 1: Initialize package.json**

```json
{
  "name": "sourcebot",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "monitor": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "yaml": "^2.7.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.1.0",
    "@types/node": "^22.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Create .gitignore**

```
node_modules/
dist/
.env
```

**Step 4: Create config.yaml**

```yaml
repos:
  - name: source-cooperative/source.coop
    log_source: vercel
    vercel_project_id: prj_uU5LXO7OUjHYb0nC1AKjTqQKW0Yj
    auto_fix: false

  - name: source-cooperative/data.source.coop
    log_source: cloudflare_workers
    cloudflare_script_name: data-source-coop
    auto_fix: true

schedule: "0 */6 * * *"
comment_cadence_days: 7
anthropic_model: claude-sonnet-4-6
```

**Step 5: Create schema.sql**

```sql
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT UNIQUE NOT NULL,
  repo TEXT NOT NULL,
  error_message TEXT NOT NULL,
  stack_location TEXT,
  http_status INTEGER,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  total_count INTEGER DEFAULT 1,
  window_count INTEGER DEFAULT 0,
  release_versions TEXT DEFAULT '[]',
  github_issue_number INTEGER,
  github_issue_state TEXT,
  last_commented_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  errors_found INTEGER DEFAULT 0,
  issues_created INTEGER DEFAULT 0,
  issues_commented INTEGER DEFAULT 0,
  issues_reopened INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',
  log TEXT
);

CREATE INDEX IF NOT EXISTS idx_errors_fingerprint ON errors(fingerprint);
CREATE INDEX IF NOT EXISTS idx_errors_repo ON errors(repo);
CREATE INDEX IF NOT EXISTS idx_errors_issue_state ON errors(github_issue_state);
```

**Step 6: Install dependencies**

Run: `npm install`

**Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore config.yaml schema.sql package-lock.json
git commit -m "chore: scaffold sourcebot project"
```

---

### Task 2: Configuration Loader

**Files:**
- Create: `src/config.ts`
- Create: `src/config.test.ts`

**Step 1: Write the failing test**

```typescript
// src/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig, type Config } from "./config.js";

describe("loadConfig", () => {
  it("parses config.yaml and returns typed config", () => {
    const config = loadConfig();
    expect(config.repos).toBeInstanceOf(Array);
    expect(config.repos.length).toBeGreaterThan(0);
    expect(config.repos[0]).toHaveProperty("name");
    expect(config.repos[0]).toHaveProperty("log_source");
    expect(config.comment_cadence_days).toBeTypeOf("number");
    expect(config.anthropic_model).toBeTypeOf("string");
  });

  it("validates repo config has required fields", () => {
    const config = loadConfig();
    for (const repo of config.repos) {
      expect(repo.name).toMatch(/^[\w-]+\/[\w.-]+$/);
      expect(["vercel", "cloudflare_workers"]).toContain(repo.log_source);
      expect(repo.auto_fix).toBeTypeOf("boolean");
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/config.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

export interface RepoConfig {
  name: string;
  log_source: "vercel" | "cloudflare_workers";
  vercel_project_id?: string;
  cloudflare_script_name?: string;
  auto_fix: boolean;
}

export interface Config {
  repos: RepoConfig[];
  schedule: string;
  comment_cadence_days: number;
  anthropic_model: string;
}

export function loadConfig(path?: string): Config {
  const configPath = path ?? resolve(process.cwd(), "config.yaml");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as Config;

  for (const repo of parsed.repos) {
    if (!repo.name || !repo.log_source) {
      throw new Error(`Invalid repo config: ${JSON.stringify(repo)}`);
    }
    if (repo.log_source === "vercel" && !repo.vercel_project_id) {
      throw new Error(`Vercel repo ${repo.name} missing vercel_project_id`);
    }
    if (repo.log_source === "cloudflare_workers" && !repo.cloudflare_script_name) {
      throw new Error(`CF repo ${repo.name} missing cloudflare_script_name`);
    }
  }

  return parsed;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add config loader with validation"
```

---

### Task 3: D1 Client

**Files:**
- Create: `src/d1.ts`
- Create: `src/d1.test.ts`

**Step 1: Write the failing test**

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/d1.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/d1.ts

interface D1Config {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

interface D1Response {
  success: boolean;
  result: Array<{
    success: boolean;
    results: Record<string, unknown>[];
    meta: Record<string, unknown>;
  }>;
}

export class D1Client {
  private baseUrl: string;
  private apiToken: string;

  constructor(config: D1Config) {
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}`;
    this.apiToken = config.apiToken;
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const response = await fetch(`${this.baseUrl}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params: params ?? [] }),
    });

    if (!response.ok) {
      throw new Error(`D1 API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as D1Response;
    if (!data.success || !data.result?.[0]?.success) {
      throw new Error(`D1 query failed: ${JSON.stringify(data)}`);
    }

    return data.result[0].results as T[];
  }

  async execute(sql: string, params?: unknown[]): Promise<void> {
    await this.query(sql, params);
  }

  async batch(queries: Array<{ sql: string; params?: unknown[] }>): Promise<void> {
    const response = await fetch(`${this.baseUrl}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(queries.map((q) => ({ sql: q.sql, params: q.params ?? [] }))),
    });

    if (!response.ok) {
      throw new Error(`D1 batch error: ${response.status} ${response.statusText}`);
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/d1.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/d1.ts src/d1.test.ts
git commit -m "feat: add D1 REST API client"
```

---

### Task 4: GitHub Client

**Files:**
- Create: `src/github.ts`
- Create: `src/github.test.ts`

This handles GitHub App authentication (JWT → installation token) and issue management (create, comment, reopen, assign).

**Step 1: Write the failing test**

```typescript
// src/github.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubClient } from "./github.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

// Minimal RSA private key for testing JWT generation (DO NOT use in production)
const TEST_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA2a2rwplBQLHhEGSr6s0N5a0oWOHCFNTnOSGs3H5TEFA+zMI5
YYNqLqjQMIDV5MNGJ+vHLoI7MwLBOp+3F/bwBwEtsFMbJPY0TXB/0PHdhGSOED4p
3mNH2EXAMPLE_ONLY_NOT_REAL_KEY
-----END RSA PRIVATE KEY-----`;

describe("GitHubClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("creates an issue", async () => {
    // Mock installation token fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "ghs_test_token", expires_at: "2026-01-01T00:00:00Z" }),
    });

    // Mock issue creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 42, html_url: "https://github.com/org/repo/issues/42" }),
    });

    const client = new GitHubClient({
      appId: "12345",
      privateKey: TEST_PRIVATE_KEY,
      installationId: "67890",
    });

    const issue = await client.createIssue("org/repo", {
      title: "Test error",
      body: "Error details",
      labels: ["sourcebot"],
    });

    expect(issue.number).toBe(42);
  });

  it("comments on an issue", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "ghs_test_token", expires_at: "2026-01-01T00:00:00Z" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1 }),
    });

    const client = new GitHubClient({
      appId: "12345",
      privateKey: TEST_PRIVATE_KEY,
      installationId: "67890",
    });

    await client.commentOnIssue("org/repo", 42, "Still seeing this error");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("reopens an issue", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "ghs_test_token", expires_at: "2026-01-01T00:00:00Z" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 42, state: "open" }),
    });

    const client = new GitHubClient({
      appId: "12345",
      privateKey: TEST_PRIVATE_KEY,
      installationId: "67890",
    });

    await client.reopenIssue("org/repo", 42);
    const call = mockFetch.mock.calls[1];
    expect(call[1].method).toBe("PATCH");
    expect(JSON.parse(call[1].body)).toEqual({ state: "open" });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/github.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Note: For JWT generation, use Node's built-in `crypto` module (no external dependency). The GitHub App auth flow is: create JWT with app ID + private key → exchange for installation access token → use token for API calls.

```typescript
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
      JSON.stringify({ iat: now - 60, exp: now + 600, iss: this.config.appId })
    ).toString("base64url");

    const key = createPrivateKey(this.config.privateKey);
    const sign = createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(key, "base64url");

    return `${header}.${payload}.${signature}`;
  }

  private async getInstallationToken(): Promise<string> {
    if (this.token && this.tokenExpiresAt && this.tokenExpiresAt > new Date()) {
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

  async assignIssue(repo: string, issueNumber: number, assignees: string[]): Promise<void> {
    await this.request("POST", `/repos/${repo}/issues/${issueNumber}/assignees`, { assignees });
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/github.test.ts`
Expected: Tests will fail because the test uses a fake RSA key. Update the test to mock `generateJwt` or generate a real test key. The simplest fix: mock the `getInstallationToken` method directly.

Revise the test to mock at the fetch level only (as written above). The fake private key will cause `createPrivateKey` to throw. Instead, refactor tests to bypass JWT generation:

```typescript
// In tests, replace the constructor approach with a factory that accepts a pre-set token:
// OR generate a real RSA keypair in beforeAll:
import { generateKeyPairSync } from "node:crypto";

const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});
```

Replace the fake key constant with the `generateKeyPairSync` call in `beforeAll`.

**Step 5: Run test to verify it passes**

Run: `npx vitest run src/github.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/github.ts src/github.test.ts
git commit -m "feat: add GitHub App client with issue management"
```

---

### Task 5: Vercel Log Source

**Files:**
- Create: `src/sources/vercel.ts`
- Create: `src/sources/vercel.test.ts`

The Vercel runtime logs API streams logs per-deployment. We need to: list recent deployments → fetch logs for each → filter for errors.

**Step 1: Write the failing test**

```typescript
// src/sources/vercel.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VercelSource } from "./vercel.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("VercelSource", () => {
  const source = new VercelSource({
    apiToken: "test-token",
    projectId: "prj_test",
    teamId: "team_test",
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("fetches deployments and filters error logs", async () => {
    // Mock list deployments
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        deployments: [
          { uid: "dep1", meta: { githubCommitSha: "abc123" }, created: Date.now() - 3600000 },
        ],
      }),
    });

    // Mock runtime logs (streaming response)
    const logLines = [
      JSON.stringify({ level: "error", message: "TypeError: Cannot read property", responseStatusCode: 500, timestampInMs: Date.now(), requestPath: "/api/test", source: "serverless" }),
      JSON.stringify({ level: "info", message: "Request completed", responseStatusCode: 200, timestampInMs: Date.now(), requestPath: "/api/ok", source: "serverless" }),
    ].join("\n");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => logLines,
    });

    const errors = await source.fetchErrors(6);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("TypeError");
    expect(errors[0].source).toBe("source-cooperative/source.coop");
    expect(errors[0].releaseVersion).toBe("abc123");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/sources/vercel.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/sources/vercel.ts

export interface RawError {
  message: string;
  stackLocation: string | null;
  httpStatus: number | null;
  source: string; // repo name
  releaseVersion: string;
  timestamp: number;
}

interface VercelConfig {
  apiToken: string;
  projectId: string;
  teamId?: string;
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
    });
    if (this.config.teamId) params.set("teamId", this.config.teamId);

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
    const params = new URLSearchParams();
    if (this.config.teamId) params.set("teamId", this.config.teamId);

    const url = `https://api.vercel.com/v1/projects/${this.config.projectId}/deployments/${deploymentId}/runtime-logs${params.toString() ? "?" + params : ""}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.apiToken}` },
    });

    if (!response.ok) {
      throw new Error(`Vercel runtime logs API error: ${response.status}`);
    }

    // Streaming JSON — each line is a JSON object
    const text = await response.text();
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as VercelLogEntry);
  }

  private extractStackLocation(message: string): string | null {
    // Match common stack trace patterns: "at functionName (file.ts:line:col)"
    const match = message.match(/at\s+(\S+)\s+\(([^)]+)\)/);
    if (match) return `${match[1]} (${match[2]})`;

    // Match "file.ts:line:col" pattern
    const fileMatch = message.match(/([^\s]+\.[jt]sx?:\d+:\d+)/);
    if (fileMatch) return fileMatch[1];

    return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/sources/vercel.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/sources/vercel.ts src/sources/vercel.test.ts
git commit -m "feat: add Vercel log source"
```

---

### Task 6: Cloudflare Workers Log Source

**Files:**
- Create: `src/sources/cloudflare.ts`
- Create: `src/sources/cloudflare.test.ts`

Uses the Workers Observability API (`POST /telemetry/query`) to fetch error-level events.

**Step 1: Write the failing test**

```typescript
// src/sources/cloudflare.test.ts
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/sources/cloudflare.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/sources/cloudflare.ts
import type { RawError } from "./vercel.js";

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
      stackLocation: null, // CF Workers traces don't include JS stack traces in the same way
      httpStatus: event.$metadata.statusCode ?? null,
      source: this.repoName,
      releaseVersion: "unknown", // Will be enriched via deployment API in a future iteration
      timestamp: event.timestamp,
    }));
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/sources/cloudflare.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/sources/cloudflare.ts src/sources/cloudflare.test.ts
git commit -m "feat: add Cloudflare Workers log source"
```

---

### Task 7: Error Fingerprinting

**Files:**
- Create: `src/fingerprint.ts`
- Create: `src/fingerprint.test.ts`

**Step 1: Write the failing test**

```typescript
// src/fingerprint.test.ts
import { describe, it, expect } from "vitest";
import { computeFingerprint, normalizeMessage } from "./fingerprint.js";

describe("normalizeMessage", () => {
  it("strips UUIDs", () => {
    const msg = "Error for user 550e8400-e29b-41d4-a716-446655440000";
    expect(normalizeMessage(msg)).toBe("Error for user <UUID>");
  });

  it("strips ISO timestamps", () => {
    const msg = "Failed at 2026-04-13T10:30:00.000Z";
    expect(normalizeMessage(msg)).toBe("Failed at <TIMESTAMP>");
  });

  it("strips hex request IDs", () => {
    const msg = "Request abc123def456 failed";
    expect(normalizeMessage(msg)).toBe("Request <HEX_ID> failed");
  });

  it("strips numeric IDs", () => {
    const msg = "Record 123456 not found";
    expect(normalizeMessage(msg)).toBe("Record <NUM> not found");
  });
});

describe("computeFingerprint", () => {
  it("returns consistent hash for same error", () => {
    const fp1 = computeFingerprint("TypeError: x is undefined", "app.ts:42:10", 500);
    const fp2 = computeFingerprint("TypeError: x is undefined", "app.ts:42:10", 500);
    expect(fp1).toBe(fp2);
  });

  it("returns different hash for different errors", () => {
    const fp1 = computeFingerprint("TypeError: x is undefined", "app.ts:42:10", 500);
    const fp2 = computeFingerprint("RangeError: out of bounds", "lib.ts:10:5", 500);
    expect(fp1).not.toBe(fp2);
  });

  it("normalizes variable parts before hashing", () => {
    const fp1 = computeFingerprint(
      "Error for user 550e8400-e29b-41d4-a716-446655440000",
      "api.ts:10:1",
      500
    );
    const fp2 = computeFingerprint(
      "Error for user 99999999-aaaa-bbbb-cccc-dddddddddddd",
      "api.ts:10:1",
      500
    );
    expect(fp1).toBe(fp2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/fingerprint.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/fingerprint.ts
import { createHash } from "node:crypto";

export function normalizeMessage(message: string): string {
  return (
    message
      // Strip UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
      // Strip ISO timestamps
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\d]*Z?/g, "<TIMESTAMP>")
      // Strip hex IDs (12+ chars)
      .replace(/\b[0-9a-f]{12,}\b/gi, "<HEX_ID>")
      // Strip pure numeric IDs (4+ digits)
      .replace(/\b\d{4,}\b/g, "<NUM>")
  );
}

export function computeFingerprint(
  message: string,
  stackLocation: string | null,
  httpStatus: number | null
): string {
  const normalized = normalizeMessage(message);
  const input = `${normalized}|${stackLocation ?? ""}|${httpStatus ?? ""}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/fingerprint.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/fingerprint.ts src/fingerprint.test.ts
git commit -m "feat: add error fingerprinting with message normalization"
```

---

### Task 8: Error Classifier (Anthropic API)

**Files:**
- Create: `src/classifier.ts`
- Create: `src/classifier.test.ts`

Batches new errors and sends them to Claude for classification, grouping, and issue drafting.

**Step 1: Write the failing test**

```typescript
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
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/classifier.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/classifier.ts
import Anthropic from "@anthropic-ai/sdk";

interface ClassifierConfig {
  apiKey: string;
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

export class ErrorClassifier {
  private client: Anthropic;
  private model: string;

  constructor(config: ClassifierConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
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

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `You are an error triage bot for Source Cooperative. Analyze these errors, group related ones (same root cause), and write a GitHub issue for each group.

${errorList}

Respond with a JSON array. Each element:
{
  "title": "[repo-short-name] Brief error description",
  "body": "Markdown issue body with: ## Error Summary, ## Details (occurrences, release version, sample stack trace), ## Probable Cause",
  "fingerprints": ["list", "of", "fingerprint", "ids", "in", "this", "group"],
  "repo": "owner/repo"
}

Respond with ONLY the JSON array, no other text.`,
        },
      ],
    });

    const text = response.content[0];
    if (text.type !== "text") {
      throw new Error("Unexpected Anthropic response type");
    }

    return JSON.parse(text.text) as ClassifiedErrorGroup[];
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/classifier.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/classifier.ts src/classifier.test.ts
git commit -m "feat: add Anthropic-powered error classifier"
```

---

### Task 9: Monitor Orchestrator (Main Entry Point)

**Files:**
- Create: `src/index.ts`
- Create: `src/index.test.ts`

This is the main script that ties everything together: fetch errors → fingerprint → query D1 → classify new ones → create/update/reopen issues → update D1.

**Step 1: Write the failing test**

```typescript
// src/index.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runMonitor, type MonitorDeps } from "./index.js";

describe("runMonitor", () => {
  const mockDeps: MonitorDeps = {
    vercelSource: { fetchErrors: vi.fn().mockResolvedValue([]) },
    cloudflareSource: { fetchErrors: vi.fn().mockResolvedValue([]) },
    d1: {
      query: vi.fn().mockResolvedValue([]),
      execute: vi.fn().mockResolvedValue(undefined),
      batch: vi.fn().mockResolvedValue(undefined),
    },
    github: {
      createIssue: vi.fn().mockResolvedValue({ number: 1, html_url: "https://github.com/test", state: "open" }),
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
      reopenIssue: vi.fn().mockResolvedValue(undefined),
      assignIssue: vi.fn().mockResolvedValue(undefined),
      triggerWorkflowDispatch: vi.fn().mockResolvedValue(undefined),
    },
    classifier: {
      classify: vi.fn().mockResolvedValue([]),
    },
    config: {
      repos: [
        { name: "source-cooperative/source.coop", log_source: "vercel" as const, vercel_project_id: "prj_test", auto_fix: false },
        { name: "source-cooperative/data.source.coop", log_source: "cloudflare_workers" as const, cloudflare_script_name: "test", auto_fix: true },
      ],
      schedule: "0 */6 * * *",
      comment_cadence_days: 7,
      anthropic_model: "claude-sonnet-4-6",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches from all sources", async () => {
    await runMonitor(mockDeps);
    expect(mockDeps.vercelSource.fetchErrors).toHaveBeenCalledWith(6);
    expect(mockDeps.cloudflareSource.fetchErrors).toHaveBeenCalledWith(6);
  });

  it("creates issues for new errors", async () => {
    (mockDeps.vercelSource.fetchErrors as any).mockResolvedValueOnce([
      { message: "TypeError: x", stackLocation: "a.ts:1", httpStatus: 500, source: "source-cooperative/source.coop", releaseVersion: "v1", timestamp: Date.now() },
    ]);
    (mockDeps.d1.query as any).mockResolvedValue([]); // no known errors
    (mockDeps.classifier.classify as any).mockResolvedValueOnce([
      { title: "TypeError", body: "Details", fingerprints: ["fp1"], repo: "source-cooperative/source.coop" },
    ]);

    await runMonitor(mockDeps);
    expect(mockDeps.github.createIssue).toHaveBeenCalled();
  });

  it("self-assigns when auto_fix is true", async () => {
    (mockDeps.cloudflareSource.fetchErrors as any).mockResolvedValueOnce([
      { message: "Error", stackLocation: null, httpStatus: 502, source: "source-cooperative/data.source.coop", releaseVersion: "v1", timestamp: Date.now() },
    ]);
    (mockDeps.d1.query as any).mockResolvedValue([]);
    (mockDeps.classifier.classify as any).mockResolvedValueOnce([
      { title: "Error", body: "Details", fingerprints: ["fp2"], repo: "source-cooperative/data.source.coop" },
    ]);

    await runMonitor(mockDeps);
    expect(mockDeps.github.assignIssue).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/index.ts
import { computeFingerprint } from "./fingerprint.js";
import type { RawError } from "./sources/vercel.js";
import type { Config } from "./config.js";

export interface MonitorDeps {
  vercelSource: { fetchErrors(hours: number): Promise<RawError[]> };
  cloudflareSource: { fetchErrors(hours: number): Promise<RawError[]> };
  d1: {
    query<T>(sql: string, params?: unknown[]): Promise<T[]>;
    execute(sql: string, params?: unknown[]): Promise<void>;
    batch(queries: Array<{ sql: string; params?: unknown[] }>): Promise<void>;
  };
  github: {
    createIssue(repo: string, options: { title: string; body: string; labels?: string[]; assignees?: string[] }): Promise<{ number: number; html_url: string; state: string }>;
    commentOnIssue(repo: string, issueNumber: number, body: string): Promise<void>;
    reopenIssue(repo: string, issueNumber: number): Promise<void>;
    assignIssue(repo: string, issueNumber: number, assignees: string[]): Promise<void>;
    triggerWorkflowDispatch(repo: string, workflowId: string, ref: string, inputs: Record<string, string>): Promise<void>;
  };
  classifier: {
    classify(errors: Array<{
      fingerprint: string;
      message: string;
      stackLocation: string | null;
      httpStatus: number | null;
      source: string;
      releaseVersion: string;
      count: number;
    }>): Promise<Array<{ title: string; body: string; fingerprints: string[]; repo: string }>>;
  };
  config: Config;
}

interface ErrorRecord {
  fingerprint: string;
  repo: string;
  github_issue_number: number | null;
  github_issue_state: string | null;
  release_versions: string;
  last_commented_at: string | null;
}

export async function runMonitor(deps: MonitorDeps): Promise<void> {
  const windowHours = 6;
  const now = new Date().toISOString();

  // Record run start
  await deps.d1.execute("INSERT INTO runs (started_at, status) VALUES (?, 'running')", [now]);

  let errorsFound = 0;
  let issuesCreated = 0;
  let issuesCommented = 0;
  let issuesReopened = 0;

  try {
    // 1. Fetch errors from all sources
    const [vercelErrors, cfErrors] = await Promise.all([
      deps.vercelSource.fetchErrors(windowHours),
      deps.cloudflareSource.fetchErrors(windowHours),
    ]);

    const allErrors = [...vercelErrors, ...cfErrors];
    errorsFound = allErrors.length;

    if (allErrors.length === 0) {
      await deps.d1.execute(
        "UPDATE runs SET completed_at = ?, status = 'completed', errors_found = 0 WHERE started_at = ?",
        [new Date().toISOString(), now]
      );
      return;
    }

    // 2. Compute fingerprints and aggregate
    const errorsByFingerprint = new Map<
      string,
      { error: RawError; count: number; fingerprint: string; releaseVersions: Set<string> }
    >();

    for (const error of allErrors) {
      const fp = computeFingerprint(error.message, error.stackLocation, error.httpStatus);
      const existing = errorsByFingerprint.get(fp);
      if (existing) {
        existing.count++;
        existing.releaseVersions.add(error.releaseVersion);
      } else {
        errorsByFingerprint.set(fp, {
          error,
          count: 1,
          fingerprint: fp,
          releaseVersions: new Set([error.releaseVersion]),
        });
      }
    }

    // 3. Query D1 for known errors
    const fingerprints = Array.from(errorsByFingerprint.keys());
    const placeholders = fingerprints.map(() => "?").join(",");
    const knownErrors = fingerprints.length > 0
      ? await deps.d1.query<ErrorRecord>(
          `SELECT fingerprint, repo, github_issue_number, github_issue_state, release_versions, last_commented_at FROM errors WHERE fingerprint IN (${placeholders})`,
          fingerprints
        )
      : [];

    const knownMap = new Map(knownErrors.map((e) => [e.fingerprint, e]));

    // 4. Separate new vs known errors
    const newErrors: Array<{
      fingerprint: string;
      message: string;
      stackLocation: string | null;
      httpStatus: number | null;
      source: string;
      releaseVersion: string;
      count: number;
    }> = [];

    for (const [fp, data] of errorsByFingerprint) {
      const known = knownMap.get(fp);

      if (!known) {
        // New error
        newErrors.push({
          fingerprint: fp,
          message: data.error.message,
          stackLocation: data.error.stackLocation,
          httpStatus: data.error.httpStatus,
          source: data.error.source,
          releaseVersion: Array.from(data.releaseVersions).join(", "),
          count: data.count,
        });
      } else if (known.github_issue_state === "closed") {
        // Check for regression (new release version)
        const knownVersions = JSON.parse(known.release_versions) as string[];
        const newVersions = Array.from(data.releaseVersions).filter((v) => !knownVersions.includes(v));

        if (newVersions.length > 0 && known.github_issue_number) {
          // Regression — reopen
          const comment = `⚠️ **Regression detected**\n\nThis error reappeared on release \`${newVersions.join(", ")}\` (${data.count} occurrences in the last ${windowHours} hours).\n\nEither the fix didn't address this case or there was a regression.`;
          await deps.github.reopenIssue(known.repo, known.github_issue_number);
          await deps.github.commentOnIssue(known.repo, known.github_issue_number, comment);
          issuesReopened++;

          // Update D1
          const allVersions = [...knownVersions, ...newVersions];
          await deps.d1.execute(
            "UPDATE errors SET github_issue_state = 'open', release_versions = ?, last_seen_at = ?, total_count = total_count + ?, window_count = ?, updated_at = ? WHERE fingerprint = ?",
            [JSON.stringify(allVersions), now, data.count, data.count, now, fp]
          );
        }
      } else if (known.github_issue_state === "open" && known.github_issue_number) {
        // Known open issue — comment if cadence allows
        const lastCommented = known.last_commented_at ? new Date(known.last_commented_at) : new Date(0);
        const daysSinceComment = (Date.now() - lastCommented.getTime()) / (1000 * 60 * 60 * 24);

        if (daysSinceComment >= deps.config.comment_cadence_days) {
          const comment = `📊 **Ongoing error report**\n\nThis error occurred ${data.count} times in the last ${windowHours} hours.\n\nRelease version(s): \`${Array.from(data.releaseVersions).join(", ")}\``;
          await deps.github.commentOnIssue(known.repo, known.github_issue_number, comment);
          issuesCommented++;

          await deps.d1.execute(
            "UPDATE errors SET last_commented_at = ?, last_seen_at = ?, total_count = total_count + ?, window_count = ?, updated_at = ? WHERE fingerprint = ?",
            [now, now, data.count, data.count, now, fp]
          );
        } else {
          // Just update counts silently
          await deps.d1.execute(
            "UPDATE errors SET last_seen_at = ?, total_count = total_count + ?, window_count = ?, updated_at = ? WHERE fingerprint = ?",
            [now, data.count, data.count, now, fp]
          );
        }
      }
    }

    // 5. Classify new errors and create issues
    if (newErrors.length > 0) {
      const groups = await deps.classifier.classify(newErrors);

      for (const group of groups) {
        const repoConfig = deps.config.repos.find((r) => r.name === group.repo);
        const issue = await deps.github.createIssue(group.repo, {
          title: group.title,
          body: group.body,
          labels: ["sourcebot"],
        });
        issuesCreated++;

        // Auto-assign if configured
        if (repoConfig?.auto_fix) {
          await deps.github.assignIssue(group.repo, issue.number, ["sourcebot[bot]"]);
        }

        // Record in D1
        for (const fp of group.fingerprints) {
          const data = errorsByFingerprint.get(fp);
          if (!data) continue;

          await deps.d1.execute(
            `INSERT INTO errors (fingerprint, repo, error_message, stack_location, http_status, first_seen_at, last_seen_at, total_count, window_count, release_versions, github_issue_number, github_issue_state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
            [
              fp,
              data.error.source,
              data.error.message,
              data.error.stackLocation,
              data.error.httpStatus,
              now,
              now,
              data.count,
              data.count,
              JSON.stringify(Array.from(data.releaseVersions)),
              issue.number,
              now,
              now,
            ]
          );
        }
      }
    }
  } catch (error) {
    await deps.d1.execute(
      "UPDATE runs SET completed_at = ?, status = 'failed', errors_found = ?, issues_created = ?, issues_commented = ?, issues_reopened = ?, log = ? WHERE started_at = ?",
      [new Date().toISOString(), errorsFound, issuesCreated, issuesCommented, issuesReopened, String(error), now]
    );
    throw error;
  }

  // Record run completion
  await deps.d1.execute(
    "UPDATE runs SET completed_at = ?, status = 'completed', errors_found = ?, issues_created = ?, issues_commented = ?, issues_reopened = ? WHERE started_at = ?",
    [new Date().toISOString(), errorsFound, issuesCreated, issuesCommented, issuesReopened, now]
  );
}
```

**Step 4: Add CLI entry point at the bottom of index.ts**

Append to `src/index.ts`:

```typescript
// CLI entry point — called by GitHub Actions
async function main() {
  const { loadConfig } = await import("./config.js");
  const { D1Client } = await import("./d1.js");
  const { GitHubClient } = await import("./github.js");
  const { VercelSource } = await import("./sources/vercel.js");
  const { CloudflareSource } = await import("./sources/cloudflare.js");
  const { ErrorClassifier } = await import("./classifier.js");

  const config = loadConfig();

  const d1 = new D1Client({
    accountId: requireEnv("CLOUDFLARE_ACCOUNT_ID"),
    databaseId: requireEnv("D1_DATABASE_ID"),
    apiToken: requireEnv("CLOUDFLARE_API_TOKEN"),
  });

  const github = new GitHubClient({
    appId: requireEnv("SOURCEBOT_APP_ID"),
    privateKey: requireEnv("SOURCEBOT_APP_PRIVATE_KEY"),
    installationId: requireEnv("SOURCEBOT_INSTALLATION_ID"),
  });

  const vercelRepo = config.repos.find((r) => r.log_source === "vercel");
  const cfRepo = config.repos.find((r) => r.log_source === "cloudflare_workers");

  const vercelSource = new VercelSource({
    apiToken: requireEnv("VERCEL_API_TOKEN"),
    projectId: vercelRepo?.vercel_project_id ?? "",
    teamId: process.env.VERCEL_TEAM_ID,
  });

  const cloudflareSource = new CloudflareSource({
    apiToken: requireEnv("CLOUDFLARE_API_TOKEN"),
    accountId: requireEnv("CLOUDFLARE_ACCOUNT_ID"),
    scriptName: cfRepo?.cloudflare_script_name ?? "",
  });

  const classifier = new ErrorClassifier({
    apiKey: requireEnv("ANTHROPIC_API_KEY"),
    model: config.anthropic_model,
  });

  await runMonitor({ vercelSource, cloudflareSource, d1, github, classifier, config });
  console.log("Monitor run completed successfully.");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Only run when executed directly (not imported for tests)
const isDirectRun = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Monitor failed:", err);
    process.exit(1);
  });
}
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: add monitor orchestrator with triage logic"
```

---

### Task 10: Monitor GitHub Actions Workflow

**Files:**
- Create: `.github/workflows/monitor.yml`

**Step 1: Write the workflow**

```yaml
# .github/workflows/monitor.yml
name: Sourcebot Monitor

on:
  schedule:
    - cron: "0 */6 * * *"
  workflow_dispatch:

jobs:
  monitor:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout sourcebot
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Initialize D1 schema (idempotent)
        run: |
          curl -s -X POST \
            "https://api.cloudflare.com/client/v4/accounts/${{ secrets.CLOUDFLARE_ACCOUNT_ID }}/d1/database/${{ secrets.D1_DATABASE_ID }}/query" \
            -H "Authorization: Bearer ${{ secrets.CLOUDFLARE_API_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d "{\"sql\": \"$(cat schema.sql | tr '\n' ' ')\"}"

      - name: Run monitor
        run: npx tsx src/index.ts
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          D1_DATABASE_ID: ${{ secrets.D1_DATABASE_ID }}
          VERCEL_API_TOKEN: ${{ secrets.VERCEL_API_TOKEN }}
          VERCEL_TEAM_ID: ${{ secrets.VERCEL_TEAM_ID }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          SOURCEBOT_APP_ID: ${{ secrets.SOURCEBOT_APP_ID }}
          SOURCEBOT_APP_PRIVATE_KEY: ${{ secrets.SOURCEBOT_APP_PRIVATE_KEY }}
          SOURCEBOT_INSTALLATION_ID: ${{ secrets.SOURCEBOT_INSTALLATION_ID }}
```

**Step 2: Commit**

```bash
git add .github/workflows/monitor.yml
git commit -m "feat: add monitor GitHub Actions workflow"
```

---

### Task 11: Fix Reusable Workflow

**Files:**
- Create: `.github/workflows/fix.yml`

This is the reusable workflow called by target repos when an issue is assigned to sourcebot.

**Step 1: Write the workflow**

```yaml
# .github/workflows/fix.yml
name: Sourcebot Fix

on:
  workflow_call:
    secrets:
      ANTHROPIC_API_KEY:
        required: true
      SOURCEBOT_APP_ID:
        required: true
      SOURCEBOT_APP_PRIVATE_KEY:
        required: true

jobs:
  fix:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Generate GitHub App token
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.SOURCEBOT_APP_ID }}
          private-key: ${{ secrets.SOURCEBOT_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}

      - name: Checkout target repo
        uses: actions/checkout@v4
        with:
          token: ${{ steps.app-token.outputs.token }}

      - name: Read PR template
        id: pr-template
        run: |
          if [ -f .github/pull_request_template.md ]; then
            echo "template<<TEMPLATE_EOF" >> "$GITHUB_OUTPUT"
            cat .github/pull_request_template.md >> "$GITHUB_OUTPUT"
            echo "TEMPLATE_EOF" >> "$GITHUB_OUTPUT"
          else
            echo "template=No PR template found. Use a standard format with: What, How, Testing sections." >> "$GITHUB_OUTPUT"
          fi

      - name: Run Claude Code to fix issue
        uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_token: ${{ steps.app-token.outputs.token }}
          prompt: |
            You are sourcebot, an automated error-fixing bot for Source Cooperative.

            An issue has been assigned to you for fixing. Read the issue carefully, understand the error, find the relevant code, implement a fix, and open a PR.

            Issue #${{ github.event.issue.number }}: ${{ github.event.issue.title }}

            Issue body:
            ${{ github.event.issue.body }}

            When creating the PR:
            1. Create a branch named `sourcebot/fix-${{ github.event.issue.number }}`
            2. Use this PR template and fill in every section:

            ${{ steps.pr-template.outputs.template }}

            3. Reference the issue: "Fixes #${{ github.event.issue.number }}"
            4. Request review from: ${{ github.event.sender.login }}

            Important:
            - Run existing tests to verify your fix doesn't break anything
            - If the repo has linting, run it
            - Keep changes minimal and focused on the error
```

**Step 2: Commit**

```bash
git add .github/workflows/fix.yml
git commit -m "feat: add reusable fix workflow for Claude Code"
```

---

### Task 12: Target Repo Caller Workflows

**Files:**
- Create: caller workflow for `source.coop`
- Create: caller workflow for `data.source.coop`

These are thin workflows that go in each target repo. They fire on issue assignment and call the reusable fix workflow in sourcebot.

**Step 1: Create the caller workflow for source.coop**

File: `/Users/alukach/github/source-cooperative/source.coop/.github/workflows/sourcebot-fix.yml`

```yaml
name: Sourcebot Fix
on:
  issues:
    types: [assigned]
jobs:
  fix:
    if: github.event.assignee.login == 'sourcebot[bot]'
    uses: source-cooperative/sourcebot/.github/workflows/fix.yml@main
    secrets: inherit
```

**Step 2: Create the caller workflow for data.source.coop**

File: `/Users/alukach/github/source-cooperative/data.source.coop/.github/workflows/sourcebot-fix.yml`

```yaml
name: Sourcebot Fix
on:
  issues:
    types: [assigned]
jobs:
  fix:
    if: github.event.assignee.login == 'sourcebot[bot]'
    uses: source-cooperative/sourcebot/.github/workflows/fix.yml@main
    secrets: inherit
```

**Step 3: Commit in each repo**

These need to be committed in their respective repos, not in sourcebot:

```bash
# In source.coop repo
cd /Users/alukach/github/source-cooperative/source.coop
git add .github/workflows/sourcebot-fix.yml
git commit -m "feat: add sourcebot fix workflow caller"

# In data.source.coop repo
cd /Users/alukach/github/source-cooperative/data.source.coop
git add .github/workflows/sourcebot-fix.yml
git commit -m "feat: add sourcebot fix workflow caller"
```

---

### Task 13: CI Workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Step 1: Write the CI workflow**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx vitest run
```

**Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "feat: add CI workflow"
```

---

### Task 14: D1 Schema Initialization Script

**Files:**
- Create: `scripts/init-d1.sh`

A convenience script to initialize the D1 database schema from the command line (for first-time setup).

**Step 1: Write the script**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Initialize the D1 database schema for sourcebot.
# Requires: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID env vars.

: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${D1_DATABASE_ID:?Set D1_DATABASE_ID}"

SCHEMA=$(cat "$(dirname "$0")/../schema.sql")

# D1 REST API doesn't support multi-statement queries, so split by semicolons
echo "$SCHEMA" | while IFS=';' read -r stmt; do
  stmt=$(echo "$stmt" | xargs)  # trim whitespace
  [ -z "$stmt" ] && continue

  echo "Executing: ${stmt:0:60}..."
  curl -s -X POST \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"sql\": \"${stmt}\"}" | jq '.success'
done

echo "D1 schema initialized."
```

**Step 2: Make executable and commit**

```bash
chmod +x scripts/init-d1.sh
git add scripts/init-d1.sh
git commit -m "feat: add D1 schema initialization script"
```

---

## Summary

| Task | What it builds | Key files |
|------|---------------|-----------|
| 1 | Project scaffolding | `package.json`, `tsconfig.json`, `config.yaml`, `schema.sql` |
| 2 | Config loader | `src/config.ts` |
| 3 | D1 REST client | `src/d1.ts` |
| 4 | GitHub App client | `src/github.ts` |
| 5 | Vercel log source | `src/sources/vercel.ts` |
| 6 | CF Workers log source | `src/sources/cloudflare.ts` |
| 7 | Error fingerprinting | `src/fingerprint.ts` |
| 8 | Anthropic classifier | `src/classifier.ts` |
| 9 | Monitor orchestrator | `src/index.ts` |
| 10 | Monitor workflow | `.github/workflows/monitor.yml` |
| 11 | Fix reusable workflow | `.github/workflows/fix.yml` |
| 12 | Target repo callers | `sourcebot-fix.yml` in each target repo |
| 13 | CI workflow | `.github/workflows/ci.yml` |
| 14 | D1 init script | `scripts/init-d1.sh` |
