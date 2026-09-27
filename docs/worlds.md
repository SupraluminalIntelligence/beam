# Beam Worlds

Beam has two halves. The **engine** is workspaces, chats, people, agents, runs on real machines, approvals, branches and pull requests. A **world** is how a person sees and touches it. The desktop, web and phone apps are three plain ones. Beam Worlds lets anyone build another outside this repository, as a 2D or 3D space, a dashboard, a terminal feed, or just sound: a terminal feed, a review console, a kanban of chats, an office where agents sit at desks, a hamster office, a voice that reads approvals aloud.

A world decides how things look, or sound. It never decides what they are. Deleting a world changes nothing else. The idea and its principles are in [ideas/interaction-layers.md](ideas/interaction-layers.md).

Reads are free, writes are few. A world can see everything you can see. It can do a handful of things, each behind its own scope that you approve: post and react, answer agents, stop runs, say where you are, and keep its own state. It can never do more than you could in the plain apps.

## Connect

```sh
pnpm --filter @beam/cli beam login --name "Hamster office"                       # read-only
pnpm --filter @beam/cli beam login --name "Hamster office" --scopes chat:write,presence:write,world:state
pnpm --filter @beam/cli beam login --name "Hamster office" --write               # every scope
```

(There is no published package yet. From this repo, `pnpm --filter @beam/cli beam <command>` is `beam <command>`.) This prints a code and a link. Open the link while signed in to Beam, check what the app asks for, and approve. To change a token's scopes, log in again. The token is saved to `~/.beam/world.json` (mode 600). It acts as you: it sees exactly what you see, including private chats you are in, and nothing else. Revoke it any time in **Settings → Connected apps**, or with `beam logout`.

`BEAM_TOKEN` overrides the saved token, and `BEAM_CONVEX_URL` overrides the backend, so a world can run somewhere `beam login` never ran.

## Three ways in

| You are writing | Use |
|---|---|
| TypeScript or JavaScript, in a browser or Node | `@beam/worlds` (`packages/worlds`). Live subscriptions, events, and view models. |
| A shell script, or you want to look around | `beam get`, `beam sub`, `beam watch`. JSON out, one value per line for streams. |
| Anything else: Python, Godot, Unity, Swift, Rust | `beam serve`: the whole API as JSON lines over stdin and stdout. |

### SDK

```ts
import { connect, chatTimeline } from "@beam/worlds";

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

// Acting as you, when the token has the scope.
await beam.send(chatId, "@claude can you add a retry here?");
await beam.respond(runId, requestId, "allow");
await beam.focus(workspace.id, chatId, "hamster-office");  // walking into a room is focusing its chat
const place = beam.placer(workspace.id, "hamster-office");   // throttled: call it every frame
place({ x: 12.5, y: 3, facing: "north", pose: "walking" });
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
beam watch --world hamster-office               # the workspace, plus that world's own state

beam actions                                    # everything you can do, with its scope
beam send <chatId> "@codex review this"
beam respond <runId> <requestId> allow
beam focus <workspaceId> <chatId> --world hamster-office
beam do worlds.set workspaceId=<id> world=hamster-office scope=person data='{"x":3,"y":4}'
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
← {"id":4,"value":{"resources":{…},"actions":{…}}}
→ {"id":5,"op":"do","action":"messages.send","args":{"chatId":"…","text":"@claude go"}}
← {"id":5,"value":{"id":"…","kind":"dispatch","runner":"Mac mini"}}
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
| `worlds.state` | `workspaceId`, `world` | A world's own state: one entry per person, per chat, and one for the workspace |

## Actions

Each action needs its scope. A token without it gets `this token may not <scope>`. `me.get` lists a token's scopes, so offer only what it can do. `beam actions` prints this list from the contract.

| Action | Scope | Arguments | What |
|---|---|---|---|
| `messages.send` | `chat:write` | `chatId`, `text`, `mention?`, `runId?` | Post as you. The first `@handle` of an agent in the chat starts it, or joins your live run with it, exactly as in the composer. `mention` picks the agent explicitly. `runId` steers that live run |
| `messages.react` | `chat:write` | `messageId`, `emoji` | Toggle your reaction |
| `runs.respond` | `run:respond` | `runId`, `requestId`, `decision` | Answer an agent's open question or approval. The first answer wins |
| `runs.interrupt` | `run:interrupt` | `runId` | Stop a live run. Its work is still committed and pushed |
| `people.focus` | `presence:write` | `workspaceId`, `chatId?`, `world?` | Say which chat you are in (none without `chatId`), and from which world |
| `worlds.set` | `world:state` | `workspaceId`, `world`, `scope`, `chatId?`, `data` | Save this world's state for you (`person`), a chat, or the workspace. `null` removes it |

Agents started from a world run where they would from your phone: on your default account for that agent, set in **Settings → Models & accounts**. Without one, `messages.send` says so.

The shapes are zod schemas in [`packages/contracts/src/worlds.ts`](../packages/contracts/src/worlds.ts). Ids are opaque strings. Times are milliseconds since the epoch.

## Events

`watchWorkspace` and `watchChat` (and `beam watch`, and the `watch` op) turn live resources into events. A snapshot always comes first. Each event after it describes a change since the previous value.

| Workspace | Chat |
|---|---|
| `workspace.snapshot` | `chat.snapshot` |
| `chat.created`, `chat.updated`, `chat.removed` | `message.posted`, `message.updated` (a streaming reply, a reaction) |
| `chat.status` (`ask`, `work`, …, or `idle`) | `run.event` (a tool step, a turn, a question: see below) |
| `person.arrived`, `person.moved`, `person.left` (each with the `world` they are in) | `run.started`, `run.changed`, `run.asking`, `run.answered`, `run.ended` |
| `run.started`, `run.changed`, `run.asking`, `run.answered`, `run.ended` | `change.opened`, `change.updated` (PR opened, CI finished, merged) |
| `world.person`, `world.chat`, `world.workspace` (when watching with a world) | |

Events are hints. The snapshot is the truth. After a reconnect, a new watch starts from a new snapshot, and there is nothing to replay. The differ is a pure function (`diffWorkspace`, `diffChat` in the SDK) if you would rather hold the state yourself.

`run.event` carries the engine's normalized run events: `turn.started`, `item.started` and `item.completed` (tool steps with a summary), `content.final`, `request.opened` and `request.resolved` (questions and approvals), `steer.received`, `status`, `error` and `turn.completed`. Every harness (Claude Code, Codex, omp) emits the same vocabulary.

## View models

The hard part of drawing Beam is working out what things mean, not fetching data. The SDK exports the same pure reducer the plain apps use, so every world agrees with them:

- `runView(runId, events)`: reply text, turns, tool steps with timing, open questions, errors.
- `chatTimeline({ messages, runs, events })`: a chat as people read it. Human messages, agent replies and tool steps are merged into one list, with a status row per live run and a landing row per finished one.
- `openRequests({ runs, events })`: every question an agent is waiting on in a chat.

## Different worlds, same people

The shared truth of where someone is: the one chat they have focused (`people.presence`). Walking into a room in a 3D office is `people.focus` on that room's chat. Every interface writes the same field, and the last one wins.

Each world also keeps its own state with `worlds.set`, namespaced by a world id you pick (`hamster-office`: lowercase, digits and dashes). The engine never reads it. Other worlds can read it but have no reason to.

- **person**: yours alone, such as where you stand, which way you face, or whether you are sitting at a desk. Only you write it, and everyone in the workspace can read it.
- **chat**: shared by a chat's people, such as how its room is furnished. Anyone who can see the chat can write it.
- **workspace**: one per workspace, such as the floor plan. Any member can write it.

Each entry is at most 4 KB, and each can be written at most ten times a second. For anything that changes every frame, use `placer()` in the SDK. It sends about four writes a second and always ends on the latest value. Send intent (a destination, a pose), not frames, and animate locally.

Mapping rules decide what two people see:

- **Same world.** Presence says `world: "hamster-office"` for both, so read each other's `person` state and draw each other exactly where they are.
- **Different worlds.** Fall back to the chat. Noah is in the Tracker chat from a garden, so your office puts him in the Tracker room by its own rules. The garden puts you by the Tracker bed.
- **Plain apps** report `world: null`: that person is in the chat, not in any world. Show them however your world shows visitors.

Person state is readable by the whole workspace, so do not put anything in it you would not show everyone. In particular, never write which private chat someone is in.

## Compatibility

- v1 only grows. Fields, resources, event types and enum values may be added. Nothing is renamed, removed or retyped. A breaking change would be `v2`, served alongside.
- **Ignore what you do not know.** Unknown fields, unknown event types and unknown enum values will appear. Skip them rather than failing. The SDK does not validate responses for this reason.
- `me.get` returns the token's scopes. Check for a scope before offering an action that needs it.

## Security

- Tokens are shown once and stored hashed. A token only works with `v1` functions, and each write needs a scope the person approved after reading what it allows. No scope reaches settings, invites, agent configuration, machines or runner approval.
- Answering an approval (`run:respond`) and starting agents (`chat:write` with an `@mention`) act with the person's authority on their machines and accounts. Ask only for what the world needs.
- Everything private stays in the engine: local worktree paths, harness resume cursors, provider accounts and plan usage, GitHub tokens.
- A person you cannot see into (a private chat you are not in) reads as being nowhere.

## What is not here yet

In rough order:

1. **Files**: attachments and shared context, to read and to send.
2. **Machines and accounts**: which runners are online and which account an agent would use, so a world can say before sending whether an agent can start.
3. **Chats**: create, rename and settle them (`chat:manage`).
4. **Marking read**: clear inbox items and chat status from a world.
5. **A lighter channel for motion**, if a world needs more than intent-level updates.
6. **Hosting**: a world as a pane inside the Beam desktop app.

The phone app is the yardstick. When it can run on this API alone, most interfaces can. Today v1 covers its workspaces, chats, messages (reading and sending), reactions, runs and events, answering agents, changes, presence and inbox. It does not yet cover files, machines, marking read, or the phone's personal settings (notification preferences, agent defaults), which may stay app-only.

## Working in this repo

| Path | What |
|---|---|
| `packages/contracts/src/worlds.ts` | The contract: shapes, scopes, the resource and action catalogs, event types |
| `convex/v1/` | The facade. Maps rows to contract shapes and strips private fields |
| `convex/layers.ts` | Device-code login, app tokens, revocation (named before the feature was) |
| `packages/worlds` | Client, differ, view models |
| `apps/cli` | `beam` |

Adding a resource means adding a query in `convex/v1/`, a catalog entry and shape in `worlds.ts`, and a line in the contract test in `convex/layers.test.ts`, which checks that every resource answers in its promised shape. Adding an action means a mutation in `convex/v1/` that calls `requireLayer(ctx, token, scope)` and then the same helper the plain app's mutation uses (`sendAs`, `respondAs`, `focusAs`…), so there is one path for both. It also needs an `ACTIONS` entry and, if it needs a new scope, a line in `SCOPES` saying in plain words what approving it allows.
