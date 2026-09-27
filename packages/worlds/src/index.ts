/**
 * @beam/worlds, the Beam Worlds SDK: build your own world on Beam. Read workspaces, chats, messages, runs,
 * changes, presence and your inbox as live resources; follow a workspace or a chat as events; act as the
 * person within the scopes they approved; derive what the plain apps show with the same reducer they use.
 * See docs/worlds.md.
 */
export { Beam, connect, convexTransport, DEFAULT_URL, plainError, type Transport, type Unsubscribe } from "./client.ts";
export { diffChat, diffWorkspace } from "./diff.ts";
export { authorKey, chatTimeline, openRequests, runView, type ActivityLine, type OpenRequest, type RunView, type TimelineRow, type TurnView } from "./views.ts";
export * from "@beam/contracts/worlds";
