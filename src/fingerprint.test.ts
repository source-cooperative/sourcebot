import { describe, it, expect } from "vitest";
import { computeFingerprint, normalizeMessage, redactLog } from "./fingerprint.js";

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

describe("redactLog", () => {
  it("redacts query string values", () => {
    expect(redactLog("GET /api/search?token=abc123&q=hello")).toBe(
      "GET /api/search?token=<REDACTED>&q=<REDACTED>"
    );
  });

  it("redacts email addresses", () => {
    expect(redactLog("User user@example.com not found")).toBe("User <EMAIL> not found");
  });

  it("redacts IPv4 addresses", () => {
    expect(redactLog("Connection from 192.168.1.100 refused")).toBe(
      "Connection from <IP> refused"
    );
  });

  it("redacts JWT tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123_signature";
    expect(redactLog(`Bearer ${jwt}`)).toContain("<JWT>");
  });

  it("redacts connection strings", () => {
    expect(redactLog("postgres://admin:secret@db.host.com:5432/mydb")).toBe("<CONNECTION_STRING>");
  });

  it("redacts Authorization headers", () => {
    expect(redactLog("Authorization: Bearer sk-ant-12345")).toBe("Authorization: <REDACTED>");
  });

  it("redacts UUIDs", () => {
    expect(redactLog("session 550e8400-e29b-41d4-a716-446655440000")).toBe("session <UUID>");
  });

  it("preserves non-sensitive content", () => {
    expect(redactLog("TypeError: Cannot read property 'map' of undefined")).toBe(
      "TypeError: Cannot read property 'map' of undefined"
    );
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
