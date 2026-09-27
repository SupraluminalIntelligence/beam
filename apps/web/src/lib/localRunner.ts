import { useEffect, useState } from "react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { bridge } from "../bridge";
import { convexUrl } from "./convexUrl";

type RunnerStatus = { id: Id<"runners"> | undefined; borrowed: boolean };

/**
 * Machine identity comes from this desktop's child runner, never from an online-runner guess. A dev window without
 * one borrows the runner paired on this Mac, if that runner belongs to this deployment.
 */
export function useRunnerStatus() {
  const [status, setStatus] = useState<RunnerStatus>({ id: undefined, borrowed: false });
  useEffect(() => {
    let alive = true;
    const set = (next: RunnerStatus) => { if (alive) setStatus(prev => prev.id === next.id && prev.borrowed === next.borrowed ? prev : next); };
    const refresh = async () => {
      try {
        const s = await bridge()?.runnerStatus();
        const sameDeployment = !s?.convexUrl || s.convexUrl === convexUrl;
        set({ id: s?.running && s.runnerId && sameDeployment ? s.runnerId as Id<"runners"> : undefined, borrowed: !!s?.borrowed });
      } catch { set({ id: undefined, borrowed: false }); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return status;
}

export const useLocalRunner = () => useRunnerStatus().id;
