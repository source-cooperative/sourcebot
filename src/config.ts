import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

export interface RepoConfig {
  name: string;
  log_source: "vercel" | "cloudflare_workers";
  vercel_project_id?: string;
  cloudflare_script_name?: string;
  /** Workers Issues groups first seen before this ISO date are not filed. */
  cloudflare_issues_since?: string;
  dashboard_url?: string;
  auto_fix: boolean;
}

export interface Config {
  repos: RepoConfig[];
  /** Weekly observability digest posted to Slack (src/digest.ts). */
  digest?: { repo: string; script_name: string; analytics_dataset: string; days: number };
  schedule: string;
  comment_cadence_days: number;
  anthropic_model: string;
  window_hours: number;
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

  const envWindowHours = process.env.WINDOW_HOURS ? Number(process.env.WINDOW_HOURS) : undefined;
  parsed.window_hours = envWindowHours ?? parsed.window_hours ?? 6;

  return parsed;
}
