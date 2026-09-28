import { useAction } from "convex/react";
import { useState, type ReactNode } from "react";
import { errorMessage } from "@beam/contracts";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { bridge } from "../bridge";
import { toast } from "./Toast";

/** A job output as compute.get returns it. Large outputs live in R2 and have no standing URL. */
export type JobOutput = { path: string; size: number; url: string | null; storage?: "convex" | "r2" };

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

/**
 * A download link for a job output. One in Convex storage links straight to its file; a large output
 * asks Convex for a 15-minute link when clicked, and downloads it (in the desktop app, in the browser).
 */
export function OutputLink({ jobId, output, className, children }: { jobId: Id<"computeJobs">; output: JobOutput; className?: string; children: ReactNode }) {
  const sign = useAction(api.compute.outputUrl);
  const [busy, setBusy] = useState(false);
  const name = output.path.split("/").at(-1);
  if (output.url) return <a className={className} href={output.url} target="_blank" rel="noreferrer" download={name}>{children}</a>;
  if (output.storage !== "r2") return <span className={className}>{children}</span>;
  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { url } = await sign({ id: jobId, path: output.path });
      // The link carries Content-Disposition: attachment, so the page stays where it is.
      const b = bridge();
      if (b) await b.openExternal(url); else window.location.assign(url);
    } catch (e) { toast(`Could not download ${name}: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };
  return <a className={className} href="#" aria-busy={busy} onClick={e => { e.preventDefault(); void open(); }}>{children}</a>;
}
