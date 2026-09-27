/**
 * The sentence behind an error from a Convex call. Beam's refusals arrive as ConvexErrors whose data is the
 * reason ("Select this study explicitly before running it"); anything else arrives wrapped in
 * "[CONVEX M(fn)] [Request ID: …] Server Error". Agents and Beam Worlds get the sentence, never the wrapping.
 */
export function errorMessage(e: unknown): string {
  const data = (e as { data?: unknown } | null)?.data;
  if (typeof data === "string") return data;
  const message = e instanceof Error ? e.message : String(e);
  return message.replace(/^\[CONVEX [^\]]*\]\s*(\[Request ID: [^\]]*\]\s*)?/, "").replace(/^.*Uncaught (Convex)?Error: /s, "").split("\n")[0] || message;
}
