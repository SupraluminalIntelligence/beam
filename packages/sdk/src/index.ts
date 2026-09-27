/**
 * @beam/sdk: build your own interface on Beam. Read workspaces, chats, messages, runs, changes, presence and
 * your inbox as live resources; follow a workspace or a chat as events; derive what the plain apps show
 * with the same reducer they use. See docs/layers.md.
 */
export { Beam, connect, convexTransport, DEFAULT_URL, type Transport, type Unsubscribe } from "./client.ts";
export { diffChat, diffWorkspace } from "./diff.ts";
export { authorKey, chatTimeline, openRequests, runView, type ActivityLine, type OpenRequest, type RunView, type TimelineRow, type TurnView } from "./views.ts";
export * from "@beam/contracts/layer";
