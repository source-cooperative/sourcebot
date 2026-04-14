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

    const data = (await response.json()) as D1Response;
    if (!data.success) {
      throw new Error(`D1 batch failed: ${JSON.stringify(data)}`);
    }
  }
}
