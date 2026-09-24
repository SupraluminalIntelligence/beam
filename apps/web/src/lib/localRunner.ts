import { useEffect, useState } from "react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { bridge } from "../bridge";

/** Machine identity comes from this desktop's child runner, never from an online-runner guess. */
export function useLocalRunner() {
  const [id, setId] = useState<Id<"runners"> | undefined>();
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try { const status = await bridge()?.runnerStatus(); if (alive) setId(status?.running && status.runnerId ? status.runnerId as Id<"runners"> : undefined); }
      catch { if (alive) setId(undefined); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return id;
}
