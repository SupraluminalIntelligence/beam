# Idea: glanceable summaries of other people's chats

Parked 26 Sep 2026. Not designed yet; Apekshik wants to work out the UI.

## The itch

Beam shares everything. Every chat in a workspace is readable by everyone in it, and presence already shows who is focused where. But reading someone else's chat means scrolling through arguments, tool steps and diffs. Most of the time you only want the gist:

- what feature or fix this chat is about
- where it stands: exploring, an agent is building, waiting on someone, landed
- what is still open or undecided
- what landed, as a PR, a branch, or files

"Noah is in *Tracker page: run history*" becomes "Noah and his Codex are adding per-experiment run history to the tracker. Table is built and pushed as #212; still deciding whether seeds show by default."

## What already exists to build on

- **Presence** (`convex/presence.ts`): who is focused on which chat, per workspace.
- **Messages, runs and events** (`convex/messages.ts`, `convex/runs.ts`): the raw material for a summary, already folded for display by `packages/reducer`.
- **Changes** (`convex/changes.ts`): branch, PR number, adds, deletes and file counts per chat.
- **A model call from the backend** (`convex/router.ts`): the message router already calls a small fast model through OpenRouter, with provider fallbacks. A summarizer could share that plumbing.

## Open questions

1. **When is a summary made?** On demand when someone asks, after every landed run, or after a chat goes quiet for a while. Cost and staleness pull in opposite directions.
2. **Whose words?** Summaries should say who wants what without putting words in anyone's mouth. Quote decisions, paraphrase discussion.
3. **Private chats.** Never summarized for anyone but their members.
4. **Where it shows.**
   - Phone: a line under a chat row, a long-press preview, or a "what's happening" section on the workspace page.
   - Desktop: a hover card on the sidebar row, or on a teammate's presence avatar.
5. **Freshness.** Show how old the summary is, and what changed since you last looked.
6. **Can it be wrong?** Mark it as a summary, link to the messages it came from, and let the chat's people correct it.

## Relation to other work

- Fits the phone app's progressive disclosure: the row says what needs you, the summary says what is going on, the chat has everything.
- Could feed notifications later, as a digest of what teammates did while you were away.
