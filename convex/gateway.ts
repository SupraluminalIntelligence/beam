/**
 * The compute gateway (apps/gateway) authenticates with one service token. Convex keeps only its SHA-256,
 * in the BEAM_GATEWAY_TOKEN_SHA256 environment variable; without it, no cloud job can be claimed.
 */
export async function isGatewayToken(token: string) {
  const expected = process.env.BEAM_GATEWAY_TOKEN_SHA256?.trim().toLowerCase();
  if (!expected || token.length < 32) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hex = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
  let diff = hex.length ^ expected.length;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
  return diff === 0;
}
