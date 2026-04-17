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

export function redactLog(text: string): string {
  return (
    text
      // Connection strings (postgres://user:pass@host) — before email/URL patterns
      .replace(/\w+:\/\/[^\s]*@[^\s]+/g, "<CONNECTION_STRING>")
      // JWT tokens (three base64 segments separated by dots)
      .replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<JWT>")
      // Authorization headers (whole value after Authorization:)
      .replace(/(Authorization:\s*)\S+(\s+\S+)?/gi, "$1<REDACTED>")
      // API keys / tokens in prose (e.g., "api_key: sk-123" but not query strings)
      .replace(/((?:api[_-]?key|secret|password|credential)[=:\s]+)\S+/gi, "$1<REDACTED>")
      // Email addresses
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "<EMAIL>")
      // IPv4 addresses
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<IP>")
      // IPv6 addresses (simplified)
      .replace(/\b[0-9a-f]{1,4}(:[0-9a-f]{1,4}){7}\b/gi, "<IP>")
      // UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
      // Hex strings 20+ chars (API keys, SHAs in non-commit contexts)
      .replace(/\b[0-9a-f]{20,}\b/gi, "<HEX>")
      // Query string values: ?key=value or &key=value — last to avoid clobbering above
      .replace(/([?&][^=&\s]+)=([^&\s]+)/g, "$1=<REDACTED>")
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
