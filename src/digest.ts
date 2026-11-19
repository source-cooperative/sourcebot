// src/digest.ts
//
// Weekly observability digest for the data proxy: gather a fixed set of facts
// from Cloudflare (alert history, Workers Issues, Analytics Engine, Workers
// Logs) and the repo's open issues, have Claude write a short review, and post
// it to Slack. It only suggests: it never files issues or changes monitors.
import { normalizeMessage } from "./fingerprint.js";

export interface DigestConfig {
  repo: string;
  script_name: string;
  analytics_dataset: string;
  days: number;
}

export interface DigestDeps {
  /** Cloudflare API call under /accounts/{id}. Returns the parsed JSON body. */
  cf(path: string, init?: { method?: string; body?: string; contentType?: string }): Promise<any>;
  accountId: string;
  listOpenIssues(repo: string): Promise<Array<{ number: number; title: string }>>;
  summarize(system: string, prompt: string): Promise<string>;
  post(text: string): Promise<void>;
  now(): number;
}

const SYSTEM_PROMPT = `You review a week of production observability for data.source.coop, Source Cooperative's Cloudflare Worker data proxy, and write a short digest for the team's #devops Slack channel.

Write Slack mrkdwn, not GitHub markdown: *bold*, _italic_, • bullets, links as <url|text>. Link issues as <https://github.com/REPO/issues/N|#N>. At most about 2,500 characters. No preamble.

Structure:
*Headline*: one or two sentences: was the week healthy, and what is the one thing to look at.
*Alerts*: each monitor that fired: how often, and whether it looks real (an incident visible in errors or latency) or noise (threshold or window too tight). Monitors that were silent need one line in total. Use the policy descriptions for what each one watches.
*Errors and latency*: the 5xx rate trend, which products/accounts drove errors, read p99 and its worst windows. Cite numbers.
*Noise*: the top WARN/ERROR log sources and Workers Issues. For each, the open issue that tracks it by number, or *untracked*. Ignore "Potential vulnerability scan" Issues unless their volume changed sharply.
*Suggested actions*: at most 5, most valuable first, each concrete (e.g. "file an issue for X", "raise M7's window to 30m"). These are suggestions for a human, not things you did.

If a data source says "unavailable", say so in one line and work with the rest. Do not invent numbers.`;

async function safe<T>(fn: () => Promise<T>): Promise<T | { unavailable: string }> {
  try {
    return await fn();
  } catch (e) {
    return { unavailable: String(e).slice(0, 300) };
  }
}

/** Rows from a SQL API response, whichever envelope it comes in. */
function rows(r: any): any[] {
  return r?.data ?? r?.result?.data ?? r?.result ?? [];
}

/** Collapse per-request detail so one log line's variants group together. */
export function normalizeLogMessage(message: string): string {
  return normalizeMessage(message)
    .replace(/request_id=[^,}\s]+/g, "request_id=…")
    .replace(/duration_ms=[\d.]+/g, "duration_ms=…")
    .replace(/(path=\/[^/\s,]+\/[^/\s,]+)\/[^\s,]*/g, "$1/…");
}

/** One entry per alert notification sent, preferring the webhook copy of each. */
function alertEvents(history: any[]): Array<{ policy: string; sent: string; state: string; value: string | null }> {
  const webhook = history.filter((h) => h.mechanism_type === "webhook");
  const chosen = webhook.length > 0 ? webhook : history;
  return chosen.map((h) => {
    const body = String(h.alert_body ?? "");
    return {
      policy: h.name,
      sent: h.sent,
      state: /Alert State: Resolved/.test(body) ? "resolved" : "firing",
      value: body.match(/Triggered Result: ([\d.]+)/)?.[1] ?? null,
    };
  });
}

export async function gatherDigest(deps: DigestDeps, cfg: DigestConfig): Promise<Record<string, unknown>> {
  const end = deps.now();
  const start = end - cfg.days * 24 * 3600 * 1000;
  const startIso = new Date(start).toISOString();
  const aeStart = startIso.slice(0, 19).replace("T", " ");
  const ds = cfg.analytics_dataset;

  const ae = (sql: string) =>
    deps.cf("/analytics_engine/sql", { method: "POST", body: `${sql} FORMAT JSON`, contentType: "text/plain" }).then(rows);
  const logs = (sql: string) =>
    deps.cf("/analytics/sql", { method: "POST", body: JSON.stringify({ query: sql }) }).then(rows);
  const logWhere = `accountTag = '${deps.accountId}' AND scriptName = '${cfg.script_name}' AND timestamp >= '${startIso}'`;

  const [policies, alerts, issues, daily, readP99, readWindows, top5xx, topProducts, logLevels, logTop, openIssues] =
    await Promise.all([
      safe(async () =>
        ((await deps.cf("/alerting/v3/policies")).result ?? [])
          .filter((p: any) => String(p.name).startsWith("data-proxy"))
          .map((p: any) => ({ name: p.name, enabled: p.enabled, description: p.description }))
      ),
      safe(async () => {
        const all: any[] = [];
        for (let page = 1; page <= 5; page++) {
          const r = await deps.cf(`/alerting/v3/history?since=${encodeURIComponent(startIso)}&per_page=100&page=${page}`);
          const batch = r.result ?? [];
          all.push(...batch);
          if (batch.length < 100) break;
        }
        return alertEvents(all.filter((h) => String(h.name).startsWith("data-proxy")));
      }),
      safe(async () => {
        const r = await deps.cf(`/workers/observability/issues?service=${cfg.script_name}&perPage=100`);
        const list: any[] = Array.isArray(r.result) ? r.result : r.result?.issues ?? [];
        return list
          .filter((i) => i.lastObserved >= start)
          .map((i) => ({
            title: i.title,
            type: i.type,
            totalCount: i.count,
            firstSeen: new Date(i.firstObserved).toISOString(),
            lastSeen: new Date(i.lastObserved).toISOString(),
          }));
      }),
      safe(() =>
        ae(`SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval) AS requests, SUM(IF(double2 >= 500, _sample_interval, 0)) AS errors_5xx, SUM(IF(blob4 = 'PUT', _sample_interval, 0)) AS puts FROM ${ds} WHERE timestamp >= toDateTime('${aeStart}') GROUP BY day ORDER BY day`)
      ),
      safe(() =>
        ae(`SELECT toStartOfDay(timestamp) AS day, quantileWeighted(0.99)(double3, _sample_interval) AS read_p99_ms FROM ${ds} WHERE timestamp >= toDateTime('${aeStart}') AND (blob4 = 'GET' OR blob4 = 'HEAD') GROUP BY day ORDER BY day`)
      ),
      safe(async () =>
        (
          await ae(
            `SELECT toStartOfInterval(timestamp, INTERVAL '15' MINUTE) AS bucket, quantileWeighted(0.99)(double3, _sample_interval) AS read_p99_ms, SUM(_sample_interval) AS requests FROM ${ds} WHERE timestamp >= toDateTime('${aeStart}') AND (blob4 = 'GET' OR blob4 = 'HEAD') GROUP BY bucket`
          )
        )
          .filter((w: any) => Number(w.requests) >= 1000)
          .sort((a: any, b: any) => b.read_p99_ms - a.read_p99_ms)
          .slice(0, 8)
      ),
      safe(() =>
        ae(`SELECT blob1 AS account, blob2 AS product, blob4 AS method, double2 AS status, SUM(_sample_interval) AS requests FROM ${ds} WHERE timestamp >= toDateTime('${aeStart}') AND double2 >= 500 GROUP BY account, product, method, status ORDER BY requests DESC LIMIT 20`)
      ),
      safe(() =>
        ae(`SELECT blob1 AS account, blob2 AS product, SUM(_sample_interval) AS requests FROM ${ds} WHERE timestamp >= toDateTime('${aeStart}') GROUP BY account, product ORDER BY requests DESC LIMIT 10`)
      ),
      safe(() =>
        logs(`SELECT toStartOfDay(timestamp) AS day, level, COUNT(*) AS n FROM logs.workersLogs WHERE ${logWhere} GROUP BY day, level ORDER BY day LIMIT 100`)
      ),
      safe(async () => {
        const raw = await logs(
          `SELECT level, substring(message, 1, 200) AS msg, COUNT(*) AS n FROM logs.workersLogs WHERE ${logWhere} AND (level = 'warn' OR level = 'error') GROUP BY level, msg ORDER BY n DESC LIMIT 500`
        );
        const grouped = new Map<string, { level: string; message: string; count: number }>();
        for (const r of raw) {
          const message = normalizeLogMessage(String(r.msg));
          const key = `${r.level}|${message}`;
          const g = grouped.get(key) ?? { level: r.level, message, count: 0 };
          g.count += Number(r.n);
          grouped.set(key, g);
        }
        return [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, 20);
      }),
      safe(() => deps.listOpenIssues(cfg.repo)),
    ]);

  return {
    window: { from: startIso, to: new Date(end).toISOString(), days: cfg.days },
    repo: cfg.repo,
    monitors: policies,
    alertNotifications: alerts,
    workersIssues: issues,
    traffic: { daily, readP99Daily: readP99, worstReadWindows15m: readWindows, top5xx, topProducts },
    logs: { levelsByDay: logLevels, topWarnErrorSources: logTop },
    openIssues,
  };
}

export async function runDigest(deps: DigestDeps, cfg: DigestConfig): Promise<string> {
  const facts = await gatherDigest(deps, cfg);
  const prompt = `Repository: ${cfg.repo}\n\nThe week's data as JSON:\n\n${JSON.stringify(facts, null, 1)}`;
  const text = await deps.summarize(SYSTEM_PROMPT, prompt);
  await deps.post(text);
  return text;
}

// CLI entry point -- called by GitHub Actions
async function main() {
  const { loadConfig } = await import("./config.js");
  const { GitHubClient } = await import("./github.js");
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const config = loadConfig();
  if (!config.digest) throw new Error("config.yaml has no digest section");
  const cfg = { ...config.digest, days: Number(process.env.DIGEST_DAYS || config.digest.days) };
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const webhook = process.env.SLACK_WEBHOOK_URL;

  const github = new GitHubClient({
    appId: requireEnv("SC_DEV_BOT_APP_ID"),
    privateKey: requireEnv("SC_DEV_BOT_PRIVATE_KEY"),
    installationId: requireEnv("SC_DEV_BOT_INSTALLATION_ID"),
  });

  const text = await runDigest(
    {
      accountId,
      now: () => Date.now(),
      async cf(path, init = {}) {
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
          method: init.method ?? "GET",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            ...(init.body ? { "Content-Type": init.contentType ?? "application/json" } : {}),
          },
          body: init.body,
        });
        if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
        return response.json();
      },
      listOpenIssues: (repo) => github.listOpenIssues(repo),
      async summarize(systemPrompt, prompt) {
        let result: string | null = null;
        for await (const message of query({
          prompt,
          options: { model: config.anthropic_model, systemPrompt, maxTurns: 1, tools: [], settingSources: [] },
        })) {
          if (message.type === "result") {
            if (message.subtype !== "success") throw new Error(`Digest query failed: ${message.subtype}`);
            result = message.result;
          }
        }
        if (!result) throw new Error("Digest query returned no result");
        return result.trim();
      },
      async post(text) {
        if (!webhook) {
          console.log("SLACK_WEBHOOK_URL not set; not posting.");
          return;
        }
        const response = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!response.ok) throw new Error(`Slack webhook: ${response.status} ${await response.text()}`);
      },
    },
    cfg
  );
  console.log(text);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const isDirectRun = process.argv[1]?.endsWith("digest.ts") || process.argv[1]?.endsWith("digest.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Digest failed:", err);
    process.exit(1);
  });
}
