/* Adapted from T3 Code, revision 1de563c1. Copyright (c) 2026 T3 Tools Inc.
 * MIT licensed; see LICENSE in this directory. */
// URL normalization adapted from packages/shared/src/preview.ts; no Effect dependency.
const LOOPBACK_PREFIX_PATTERN = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i;
export function normalizePreviewUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 8192 || /[\x00-\x20]/.test(trimmed)) throw new Error("Enter a valid HTTP or HTTPS URL");
  const useHttp = LOOPBACK_PREFIX_PATTERN.test(trimmed);
  const candidate = trimmed.includes("://") ? trimmed : `${useHttp ? "http" : "https"}://${trimmed}`;
  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("Enter an HTTP or HTTPS URL without credentials");
  return parsed.href;
}
