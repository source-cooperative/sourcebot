import type { RawError } from "./vercel.js";
import { redactLog } from "../fingerprint.js";

interface CloudflareConfig {
  apiToken: string;
  accountId: string;
  scriptName: string;
  dashboardUrl?: string;
  /** Groups Cloudflare first saw before this are left alone: they predate sourcebot watching them. */
  issuesSince?: string;
}

/** One Workers Observability Issue: Cloudflare's own grouping of a recurring error. */
interface WorkersIssue {
  id: string;
  service: string;
  title: string;
  type: string;
  status: string;
  count: number;
  firstObserved: number;
  lastObserved: number;
}

const PER_PAGE = 100;
const MAX_PAGES = 10;

/**
 * Reads Cloudflare's Workers Observability Issues rather than raw ERROR events.
 * Cloudflare already groups every exception, 5xx and ERROR line into Issues, so
 * this sees every group no matter how many lines it logs, where a raw-event
 * query caps out at a few hundred lines that one noisy error can fill.
 *
 * Issues only carry a running total, so each error's `count` is that total
 * (`countIsTotal`), not a per-window count.
 */
export class CloudflareSource {
  private config: CloudflareConfig;
  private repoName = "source-cooperative/data.source.coop";

  constructor(config: CloudflareConfig) {
    this.config = config;
  }

  async fetchErrors(windowHours: number): Promise<RawError[]> {
    const from = Date.now() - windowHours * 60 * 60 * 1000;
    const since = this.config.issuesSince ? Date.parse(this.config.issuesSince) : 0;

    const issues: WorkersIssue[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = new URL(
        `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/workers/observability/issues`
      );
      url.searchParams.set("service", this.config.scriptName);
      url.searchParams.set("page", String(page));
      url.searchParams.set("perPage", String(PER_PAGE));
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.apiToken}` },
      });
      if (!response.ok) {
        throw new Error(`CF Workers Issues API error: ${response.status} ${await response.text()}`);
      }
      const data = (await response.json()) as {
        success: boolean;
        result?: WorkersIssue[] | { issues?: WorkersIssue[] };
      };
      if (!data.success) {
        throw new Error(`CF Workers Issues query failed: ${JSON.stringify(data).slice(0, 500)}`);
      }
      const batch = Array.isArray(data.result) ? data.result : data.result?.issues ?? [];
      issues.push(...batch);
      if (batch.length < PER_PAGE) break;
    }

    return issues
      .filter((i) => i.service === this.config.scriptName)
      // Vulnerability-scan detections are bots probing for /.env and the like,
      // not defects in the proxy.
      .filter((i) => i.type !== "security")
      .filter((i) => i.lastObserved >= from && i.firstObserved >= since)
      .map((i) => {
        const rawLog = [
          `Workers Issue ${i.id} (${i.type}, ${i.status}) on ${i.service}`,
          `First seen: ${new Date(i.firstObserved).toISOString()}`,
          `Last seen: ${new Date(i.lastObserved).toISOString()}`,
          `Occurrences: ${i.count}`,
          "",
          i.title,
        ].join("\n");
        const status = i.title.match(/\bHTTP (\d{3})\b/);
        return {
          message: i.title,
          stackLocation: null,
          httpStatus: status ? Number(status[1]) : null,
          source: this.repoName,
          releaseVersion: "unknown",
          timestamp: i.lastObserved,
          dashboardUrl: this.config.dashboardUrl ?? null,
          rawLog: redactLog(rawLog),
          count: i.count,
          countIsTotal: true,
        };
      });
  }
}
