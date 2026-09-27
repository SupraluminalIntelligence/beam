import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import type { ChatActivity } from "../../../../convex/chats";

const LABEL: Record<ChatActivity | "settled", string> = {
  ask: "Waiting on you", work: "Working", bad: "Run failed", done: "Finished · unread", new: "New mention", idle: "", settled: "Settled",
};

/** Live status for every chat in a workspace. Updates as runs, jobs and your notifications change. */
export function useChatActivity(workspaceId: string | null | undefined): Record<string, ChatActivity> {
  return useQuery(api.chats.activity, workspaceId ? { workspaceId: workspaceId as Id<"workspaces"> } : "skip") ?? {};
}

/** The status square's class. Unread outcomes stop showing once you're looking at the chat. */
export function chatStatus(c: Doc<"chats">, activity: Record<string, ChatActivity>, viewing = false): ChatActivity | "settled" {
  const a = activity[c._id] ?? "idle";
  if (a === "ask" || a === "work") return a;
  if (a !== "idle" && !viewing) return a;
  return c.state && c.state !== "open" ? "settled" : "idle";
}

export const chatStatusLabel = (s: ChatActivity | "settled") => LABEL[s];
