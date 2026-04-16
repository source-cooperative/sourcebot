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
    addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void>;
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

  console.log(`Starting monitor run at ${now} (window: ${windowHours}h)`);

  await deps.d1.execute(
    "INSERT INTO runs (started_at, status) VALUES (?, 'running')",
    [now]
  );

  let errorsFound = 0;
  let issuesCreated = 0;
  let issuesCommented = 0;
  let issuesReopened = 0;

  try {
    console.log("Fetching errors from Vercel and Cloudflare Workers...");
    const [vercelErrors, cfErrors] = await Promise.all([
      deps.vercelSource.fetchErrors(windowHours),
      deps.cloudflareSource.fetchErrors(windowHours),
    ]);
    console.log(`  Vercel: ${vercelErrors.length} errors, Cloudflare: ${cfErrors.length} errors`);

    const allErrors = [...vercelErrors, ...cfErrors];
    errorsFound = allErrors.length;

    if (allErrors.length === 0) {
      console.log("No errors found. Run complete.");
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
    console.log(`Fingerprinted into ${errorsByFingerprint.size} unique errors, ${knownErrors.length} already known`);

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
          console.log(`  Regression: ${fp.slice(0, 8)} on ${newVersions.join(", ")} (issue #${known.github_issue_number})`);
          const comment = `\u26a0\ufe0f **Regression detected**\n\nThis error reappeared on release \`${newVersions.join(", ")}\` (${data.count} occurrences in the last ${windowHours} hours).\n\nEither the fix didn't address this case or there was a regression.`;
          await deps.github.reopenIssue(known.repo, known.github_issue_number);
          await deps.github.commentOnIssue(known.repo, known.github_issue_number, comment);
          issuesReopened++;

          const allVersions = [...knownVersions, ...newVersions];
          await deps.d1.execute(
            "UPDATE errors SET github_issue_state = 'open', release_versions = ?, last_seen_at = ?, total_count = total_count + ?, window_count = ?, updated_at = ? WHERE fingerprint = ?",
            [JSON.stringify(allVersions), now, data.count, data.count, now, fp]
          );
        } else {
          // Closed issue recurring on an already-known release — keep counts current
          await deps.d1.execute(
            "UPDATE errors SET last_seen_at = ?, total_count = total_count + ?, window_count = ?, updated_at = ? WHERE fingerprint = ?",
            [now, data.count, data.count, now, fp]
          );
        }
      } else if (known.github_issue_state === "open" && known.github_issue_number) {
        const lastCommented = known.last_commented_at ? new Date(known.last_commented_at) : new Date(0);
        const daysSinceComment = (Date.now() - lastCommented.getTime()) / (1000 * 60 * 60 * 24);

        if (daysSinceComment >= deps.config.comment_cadence_days) {
          console.log(`  Weekly comment: ${fp.slice(0, 8)} (issue #${known.github_issue_number}, ${data.count} occurrences)`);
          const comment = `\ud83d\udcca **Ongoing error report**\n\nThis error occurred ${data.count} times in the last ${windowHours} hours.\n\nRelease version(s): \`${Array.from(data.releaseVersions).join(", ")}\``;
          await deps.github.commentOnIssue(known.repo, known.github_issue_number, comment);
          issuesCommented++;

          await deps.d1.execute(
            "UPDATE errors SET last_commented_at = ?, last_seen_at = ?, total_count = total_count + ?, window_count = ?, updated_at = ? WHERE fingerprint = ?",
            [now, now, data.count, data.count, now, fp]
          );
        } else {
          await deps.d1.execute(
            "UPDATE errors SET last_seen_at = ?, total_count = total_count + ?, window_count = ?, updated_at = ? WHERE fingerprint = ?",
            [now, data.count, data.count, now, fp]
          );
        }
      }
    }

    if (newErrors.length > 0) {
      console.log(`Classifying ${newErrors.length} new errors via Anthropic...`);
      const groups = await deps.classifier.classify(newErrors);
      console.log(`  Grouped into ${groups.length} issues`);

      for (const group of groups) {
        const repoConfig = deps.config.repos.find((r) => r.name === group.repo);
        const issue = await deps.github.createIssue(group.repo, {
          title: group.title,
          body: group.body,
          labels: ["sourcebot"],
        });
        issuesCreated++;
        console.log(`  Created issue #${issue.number} in ${group.repo}: ${group.title}`);

        if (repoConfig?.auto_fix) {
          await deps.github.addLabels(group.repo, issue.number, ["sourcebot-fix"]);
        }

        for (const fp of group.fingerprints) {
          const data = errorsByFingerprint.get(fp);
          if (!data) continue;

          await deps.d1.execute(
            `INSERT INTO errors (fingerprint, repo, error_message, stack_location, http_status, first_seen_at, last_seen_at, total_count, window_count, release_versions, github_issue_number, github_issue_state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
            [
              fp,
              group.repo,
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

  await deps.d1.execute(
    "UPDATE runs SET completed_at = ?, status = 'completed', errors_found = ?, issues_created = ?, issues_commented = ?, issues_reopened = ? WHERE started_at = ?",
    [new Date().toISOString(), errorsFound, issuesCreated, issuesCommented, issuesReopened, now]
  );

  console.log(`Run complete: ${errorsFound} errors, ${issuesCreated} created, ${issuesCommented} commented, ${issuesReopened} reopened`);
}

// CLI entry point -- called by GitHub Actions
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
    appId: requireEnv("SC_DEV_BOT_APP_ID"),
    privateKey: requireEnv("SC_DEV_BOT_PRIVATE_KEY"),
    installationId: requireEnv("SC_DEV_BOT_INSTALLATION_ID"),
  });

  const vercelRepo = config.repos.find((r) => r.log_source === "vercel");
  const cfRepo = config.repos.find((r) => r.log_source === "cloudflare_workers");

  const vercelSource = new VercelSource({
    apiToken: requireEnv("VERCEL_API_TOKEN"),
    projectId: vercelRepo?.vercel_project_id ?? "",
    teamId: requireEnv("VERCEL_TEAM_ID"),
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

const isDirectRun = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Monitor failed:", err);
    process.exit(1);
  });
}
