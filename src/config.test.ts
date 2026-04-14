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
