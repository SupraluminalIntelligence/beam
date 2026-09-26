import type { RunEvent } from "@beam/contracts";
import { fold, timeline, type RunView } from "@beam/reducer";
import { useQuery } from "convex/react";
import { useMemo } from "react";
import { agentName, isLive, ownerOf } from "../lib/agents";
import { api, type Doc, type Id } from "../lib/convex";
import { useMe, usePeople } from "../lib/hooks";

export const STEP_LABEL: Record<string, string> = { bash: "run", read: "read", edit: "edit", write: "write", search: "find", web: "web", agent: "agent", plan: "plan", ask: "ask", beam: "beam" };
export const stepText = (kind: string, summary: string) => ["read", "edit", "write", "search", "web", "agent"].includes(kind) ? summary.replace(/^(Read|Edit|Write|Grep|Glob|List|Fetch|Search|Subagent · )\s*/, "") : summary;

export type Run = Doc<"runs"> & { runnerName: string };
type RepoLanding = { repo: string; branch: string; pushed: boolean; add: number; del: number; files: number; prUrl: string | null; compareUrl: string | null; error: string | null };
export const landingOf = (run: Run) => { const l = run.landing as null | { repos?: RepoLanding[]; error?: string | null }; return { repos: l?.repos ?? [], error: l?.error ?? null }; };

/** Everything a chat screen, its details page and its people sheet read, derived once. */
export function useChat(chatId: Id<"chats">) {
  const me = useMe();
  const chat = useQuery(api.chats.get, { chatId });
  const detail = useQuery(api.workspaces.detail, chat ? { workspaceId: chat.workspaceId } : "skip");
  const messages = useQuery(api.messages.list, { chatId });
  const runs = useQuery(api.runs.forChat, { chatId }) as Run[] | undefined;
  const events = useQuery(api.runs.eventsForChat, { chatId });
  const changes = useQuery(api.changes.forChat, { chatId });
  const presence = useQuery(api.presence.inWorkspace, chat ? { workspaceId: chat.workspaceId } : "skip");
  const machinesOnline = useQuery(api.runners.online, chat ? { workspaceId: chat.workspaceId } : "skip");
  const people = usePeople([...(detail?.members ?? []), ...(runs ?? []).map(ownerOf)]);
  const login = me?.githubLogin ?? "";

  return useMemo(() => {
    const views: Record<string, RunView> = {};
    for (const r of runs ?? []) views[r._id] = fold(r._id, ((events?.[r._id] ?? []) as RunEvent[]));
    const agentOfRun = (r: Run) => detail?.agents.find((a) => a._id === r.agentId) ?? null;
    const harnessOf = (r: Run) => agentOfRun(r)?.harness ?? "claude";
    const nameOfRun = (r: Run) => agentName(harnessOf(r), ownerOf(r), login, people.nameOf);
    const rows = messages && runs ? timeline(messages, runs, views) : [];
    const live = (runs ?? []).find((r) => isLive(r.state)) ?? null;
    const waiting = (runs ?? []).find((r) => isLive(r.state) && (views[r._id]?.requests.length ?? 0) > 0) ?? null;

    // Agents in this chat: one per harness and owner, latest run wins.
    const crew = new Map<string, { harness: string; owner: string; run: Run; name: string }>();
    for (const r of [...(runs ?? [])].sort((a, b) => a._creationTime - b._creationTime)) crew.set(`${harnessOf(r)}:${ownerOf(r)}`, { harness: harnessOf(r), owner: ownerOf(r), run: r, name: nameOfRun(r) });

    // Code: the open change, the files touched, and the machines holding a worktree.
    const open = (changes ?? []).filter((c) => c.state === "open").sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
    const files = new Map<string, { path: string; run: Run; pushed: boolean }>();
    for (const r of [...(runs ?? [])].sort((a, b) => a._creationTime - b._creationTime)) {
      const pushed = landingOf(r).repos.some((x) => x.pushed);
      for (const a of views[r._id]?.activity ?? []) if ((a.kind === "edit" || a.kind === "write") && a.ok !== false) { const path = stepText(a.kind, a.summary); files.set(path, { path, run: r, pushed }); }
    }
    const unpushed = [...files.values()].filter((f) => !f.pushed).length;
    const machines = new Map<string, { id: string; name: string; owner: string; online: boolean; runs: Run[] }>();
    for (const r of runs ?? []) {
      const m = machines.get(r.runnerId) ?? { id: r.runnerId, name: r.runnerName, owner: ownerOf(r), online: !!(machinesOnline ?? []).find((x) => x.id === r.runnerId), runs: [] };
      m.runs.push(r); machines.set(r.runnerId, m);
    }
    const branch = [...(runs ?? [])].reverse().find((r) => r.branch)?.branch ?? chat?.activeBranch ?? null;
    const here = (presence ?? []).filter((p) => p.chatId === chatId).map((p) => p.login);
    return { me, login, chat, detail, messages, runs, views, rows, live, waiting, crew: [...crew.values()], open, files: [...files.values()], unpushed, machines: [...machines.values()], branch, here, nameOfRun, harnessOf, agentOfRun, ...people };
  }, [me, login, chat, detail, messages, runs, events, changes, presence, machinesOnline, people, chatId]);
}
