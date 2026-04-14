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
