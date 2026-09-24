import { z } from "zod";

export const ResourceOperation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), path: z.string().max(4096).default(".") }),
  z.object({ kind: z.literal("read"), path: z.string().max(4096) }),
  z.object({ kind: z.literal("write"), path: z.string().max(4096), text: z.string().max(200_000), expectedHash: z.string().nullable() }),
  z.object({ kind: z.literal("command"), command: z.string().min(1).max(10000), install: z.boolean().default(false) }),
  z.object({ kind: z.literal("http"), path: z.string().max(8192), method: z.enum(["GET", "HEAD"]).default("GET"), offset: z.number().int().min(0).max(16_000_000).default(0) }),
]);
export type ResourceOperation = z.infer<typeof ResourceOperation>;
