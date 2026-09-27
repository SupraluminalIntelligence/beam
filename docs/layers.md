# Building on Beam: the layer API

Beam has two halves. The **engine** is workspaces, chats, people, agents, runs on real machines, approvals, branches and pull requests. An **interaction layer** is how a person sees and touches it. The desktop, web and phone apps are three plain layers. This API lets anyone build another one outside this repository: a terminal feed, a review console, a kanban of chats, an office where agents sit at desks, a hamster office, a voice that reads approvals aloud.

A layer decides how things look. It never decides what they are. Deleting a layer changes nothing else. The idea and its principles are in [ideas/interaction-layers.md](ideas/interaction-layers.md).

Version 1 is **read-only**. Actions (send, react, answer an agent, focus a chat) and per-layer state are next; see [What is not here yet](#what-is-not-here-yet).

## Connect

```sh
pnpm --filter @beam/cli beam login --name "Hamster office"
```

(There is no published package yet. From this repo, `pnpm --filter @beam/cli beam <command>` is `beam <command>`.) This prints a code and a link. Open the link while signed in to Beam, check what the app asks for, and approve. The token is saved to `~/.beam/layer.json` (mode 600). It acts as you: it sees exactly what you see, including private chats you are in, and nothing else. Revoke it any time in **Settings → Connected apps**, or with `beam logout`.

`BEAM_TOKEN` overrides the saved token, and `BEAM_CONVEX_URL` overrides the backend, so a layer can run somewhere `beam login` never ran.

## Three ways in

| You are writing | Use |
|---|---|
| TypeScript or JavaScript, in a browser or Node | `@beam/sdk` (`packages/sdk`). Live subscriptions, events, and view models. |
| A shell script, or you want to look around | `beam get`, `beam sub`, `beam watch`. JSON out, one value per line for streams. |
| Anything else: Python, Godot, Unity, Swift, Rust | `beam serve`: the whole API as JSON lines over stdin and stdout. |

### SDK

```ts
import { connect, chatTimeline } from "@beam/sdk";

const beam = connect({ token: process.env.BEAM_TOKEN! });
const [workspace] = await beam.get("workspaces.list");

// Everything happening in the workspace, as events.
beam.watchWorkspace(workspace.id, (e) => {
  if (e.type === "person.moved") walk(e.login, e.previous, e.chatId);
  if (e.type === "run.asking") raiseHand(e.run.agentId, e.run.chatId);
  if (e.type === "run.ended" && e.run.state === "landed") dropBoxOnDesk(e.run);
});

// One resource, live: called with the whole value each time it changes.
beam.subscribe("messages.list", { chatId }, (messages) => render(messages));
```

The SDK never imports Node, so it works in a browser page as well as a script.

### CLI

```sh
beam resources                                  # everything you can read, with arguments
beam get workspaces.list
beam get chats.list workspaceId=<id> --pretty
beam sub messages.list chatId=<id>              # a line per change
beam watch                                      # your workspace as events
beam watch --chat <chatId>                      # one chat: messages, streaming replies, tool steps, PRs
```

### `beam serve`

Spawn `beam serve` and talk JSON lines. The first line out is `{"ready":true,"api":1,"me":{…}}`.

```text
→ {"id":1,"op":"get","resource":"chats.list","args":{"workspaceId":"…"}}
← {"id":1,"value":[…]}
→ {"id":2,"op":"subscribe","resource":"messages.list","args":{"chatId":"…"}}
← {"id":2,"value":[…]}                      again on every change
→ {"id":3,"op":"watch","workspaceId":"…"}  or "chatId"
← {"id":3,"event":{"type":"workspace.snapshot",…}}
← {"id":3,"event":{"type":"person.moved",…}}
→ {"id":2,"op":"unsubscribe"}
← {"id":2,"done":true}
→ {"id":4,"op":"resources"}
← {"id":4,"value":{…}}
```

A failure answers `{"id":…,"error":"…"}`. In Python:

```python
import json, subprocess
beam = subprocess.Popen(["beam", "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
send = lambda m: (beam.stdin.write(json.dumps(m) + "\n"), beam.stdin.flush())
ready = json.loads(beam.stdout.readline())
send({"id": "w", "op": "watch", "workspaceId": WORKSPACE})
for line in beam.stdout:
    event = json.loads(line).get("event")
    if event and event["type"] == "run.asking":
        say(f"An agent in {event['run']['chatId']} needs you")
```

## Resources

Each resource is a live query. `get` reads it once, while `subscribe`, `sub` and the `subscribe` op send the whole value again whenever it changes. `beam resources` prints this list from the contract itself.

| Resource | Arguments | What |
|---|---|---|
| `me.get` | | Who the token acts for, and its scopes |
| `workspaces.list` | | Workspaces you are in |
| `workspaces.get` | `workspaceId` | A workspace with its members (name, avatar) and agents |
| `chats.list` | `workspaceId` | Chats you can see, most recent first |
| `chats.get` | `chatId` | One chat |
| `chats.activity` | `workspaceId` | Status per chat: `ask` (an agent waits on someone), `work`, `bad`, `done`, `new`. Idle chats are absent |
| `messages.list` | `chatId` | Every message, oldest first. An agent's reply (`kind: "report"`) grows while it streams |
| `runs.list` | `chatId` | Every agent run in a chat, with state, open questions, machine and model |
| `runs.active` | `workspaceId` | Live runs across the workspace, and each chat's latest ended run per outcome |
| `runs.events` | `runId` | One run's normalized events |
| `runs.eventsForChat` | `chatId` | Events for every run in a chat, keyed by run id |
| `changes.list` | `chatId` | Branches and PRs, with CI checks |
| `people.presence` | `workspaceId` | Who is here and which chat each has focused |
| `people.typing` | `chatId` | Who is typing |
| `inbox.list` | | Your latest notifications |

The shapes are zod schemas in [`packages/contracts/src/layer.ts`](../packages/contracts/src/layer.ts). Ids are opaque strings. Times are milliseconds since the epoch.

## Events

`watchWorkspace` and `watchChat` (and `beam watch`, and the `watch` op) turn live resources into events. A snapshot always comes first. Each event after it describes a change since the previous value.

| Workspace | Chat |
|---|---|
| `workspace.snapshot` | `chat.snapshot` |
| `chat.created`, `chat.updated`, `chat.removed` | `message.posted`, `message.updated` (a streaming reply, a reaction) |
| `chat.status` (`ask`, `work`, …, or `idle`) | `run.event` (a tool step, a turn, a question: see below) |
| `person.arrived`, `person.moved`, `person.left` | `run.started`, `run.changed`, `run.asking`, `run.answered`, `run.ended` |
| `run.started`, `run.changed`, `run.asking`, `run.answered`, `run.ended` | `change.opened`, `change.updated` (PR opened, CI finished, merged) |

Events are hints. The snapshot is the truth. After a reconnect, a new watch starts from a new snapshot, and there is nothing to replay. The differ is a pure function (`diffWorkspace`, `diffChat` in the SDK) if you would rather hold the state yourself.

`run.event` carries the engine's normalized run events: `turn.started`, `item.started` and `item.completed` (tool steps with a summary), `content.final`, `request.opened` and `request.resolved` (questions and approvals), `steer.received`, `status`, `error` and `turn.completed`. Every harness (Claude Code, Codex, omp) emits the same vocabulary.

## View models

The hard part of drawing Beam is working out what things mean, not fetching data. The SDK exports the same pure reducer the plain apps use, so every layer agrees with them:

- `runView(runId, events)`: reply text, turns, tool steps with timing, open questions, errors.
- `chatTimeline({ messages, runs, events })`: a chat as people read it. Human messages, agent replies and tool steps are merged into one list, with a status row per live run and a landing row per finished one.
- `openRequests({ runs, events })`: every question an agent is waiting on in a chat.

## Different worlds, same people

The shared truth of where someone is: the one chat they have focused (`people.presence`). Two people in different layers see each other through it. A 3D office puts Noah in the room for the chat he has open. A garden puts him by the matching bed. When layers disagree, the chat decides.

Richer, layer-specific state is coming with writes: a position, a pose, a column order. It will be namespaced per layer and never read by the engine. Until then, map everything from presence.

## Compatibility

- v1 only grows. Fields, resources, event types and enum values may be added. Nothing is renamed, removed or retyped. A breaking change would be `v2`, served alongside.
- **Ignore what you do not know.** Unknown fields, unknown event types and unknown enum values will appear. Skip them rather than failing. The SDK does not validate responses for this reason.
- `me.get` returns the token's scopes. Check for a scope before offering an action that needs it.

## Security

- Tokens are shown once and stored hashed. A token only works with `v1` functions. It cannot reach settings, invites, agent configuration, runner approval or anything else the plain apps can do.
- Everything private stays in the engine: local worktree paths, harness resume cursors, provider accounts and plan usage, GitHub tokens.
- A person you cannot see into (a private chat you are not in) reads as being nowhere.

## What is not here yet

In rough order:

1. **Actions**, each its own scope: send a message and mention an agent, react, answer a question or approval, focus a chat (presence), interrupt a run.
2. **Layer state**: small free-form state per layer, attached to you, a chat or a workspace: positions, poses, layouts.
3. **Files**: attachments and shared context.
4. **Machines**: which runners are online, so a layer knows whether an agent can start.
5. **Hosting**: a layer as a pane inside the Beam desktop app.

The phone app is the yardstick. When it can run on this API alone, most interfaces can. Today v1 covers its workspaces, chats, messages, runs and events, changes, presence and inbox. It does not yet cover files, machines, or the phone's personal settings (notification preferences, agent defaults), which may stay app-only.

## Working in this repo

| Path | What |
|---|---|
| `packages/contracts/src/layer.ts` | The contract: shapes, the resource catalog, event types |
| `convex/v1/` | The facade. Maps rows to contract shapes and strips private fields |
| `convex/layers.ts` | Device-code login, tokens, revocation |
| `packages/sdk` | Client, differ, view models |
| `apps/cli` | `beam` |

Adding a resource means adding a query in `convex/v1/`, a catalog entry and shape in `layer.ts`, and a line in the contract test in `convex/layers.test.ts`, which checks that every resource answers in its promised shape.
