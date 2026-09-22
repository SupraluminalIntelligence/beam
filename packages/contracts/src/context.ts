import {z} from "zod";

export const ContextSourceInput=z.object({
  kind:z.enum(["link","note"]),
  title:z.string().trim().min(1).max(255),
  value:z.string().trim().min(1).max(20_000),
});
