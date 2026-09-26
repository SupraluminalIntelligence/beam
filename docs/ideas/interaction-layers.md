# Idea: one engine, any interface

Parked 26 Sep 2026. Exploratory; not designed.

## The idea

Beam has two halves that do not need to live together.

- **The engine** is the part that matters: workspaces, chats, who is where, agents, runs on real machines, approvals, branches and pull requests. It is the same no matter how anyone looks at it.
- **The interaction layer** is how a person sees and touches that engine. Today there are three: the desktop app, the web app and the phone app, all deliberately plain and brutalist.

Split them cleanly and expose the engine through a small, stable interface, a CLI with an SDK under it. Then anyone can build a new interaction layer without touching the engine's code: a 3D office, a pixel-art studio, a terminal dashboard, a voice assistant, a game. The plain interface stays the base. Everything else is optional and lives outside the core codebase, so novel UIs never tangle with the code that runs agents.

Think of it as a **UI harness**. An agent harness wraps a model so it can do work. A UI harness wraps the engine so a person can experience that work in whatever world suits them.

## What an interaction layer consumes

Mostly reads, plus a few actions:

- **State to render:** workspaces, chats, members, presence, agents and their run states, timelines, landed changes.
- **Live updates:** a subscription stream, so a layer reacts the moment an agent starts, stops to ask, or lands work.
- **A handful of actions:** send a message, mention an agent, answer an approval, react, and say where you are.

A layer describes how to visualize these things. It never decides what they are. The CLI streams the same events as JSON lines, so a layer can be written in any language and never needs to know about the backend.

## Optional primitives

The engine's own concepts stay minimal: a person is focused on one chat. Richer, layer-specific state rides alongside as optional primitives that layers may use or ignore:

- **Spatial position:** a room, coordinates, a facing direction.
- **Avatar state:** walking, sitting at a desk, away.
- **Layer identity:** which world a person is currently in.

The plain apps ignore all of it. A 3D world reads and writes it.

## Different worlds, same people

People do not have to be in the same interface to be together. Each layer supplies **mapping rules** that translate between its space and the engine's:

- If two people are in the same layer, they see each other exactly where they are.
- If they are in different layers, position falls back to the shared truth, which chat each person is in, and each world places that person according to its own rules.

So one person can be walking through a 3D office while another tends a garden, and each sees the other arrive in the same room, because they both opened the same chat.

## Sketches

- **An office.** A workspace is a floor, a chat is a room, walking in means focusing that chat. Agents sit at desks, visibly working. One raises a hand when it needs approval, and a box lands on the desk when a pull request lands.
- **An office of hamsters.** The same mapping in a different skin.
- **Somewhere that isn't an office at all.** A yard, a farm, a ship. Whatever makes managing a team of agents feel like play instead of work.
- **No visuals at all.** A terminal feed, a menu-bar counter of who is waiting on you, a voice that reads approvals out loud.

## Build your own

Because the interface is small and documented, a coding agent can be pointed at it and asked to build a new world: "make me an interaction layer where my agents are a kitchen brigade." Everyone becomes the architect of the working environment that suits them. The engine stays the foundation, and the buildings on top can be as strange as people like.

## Principles

1. **The engine never depends on a layer.** Layers are clients; deleting one changes nothing else.
2. **The base interface stays plain.** It is the reference, the fallback and the place new engine features land first.
3. **Reads are free, writes are few.** A layer can show everything but can only do what a person could do in the plain app.
4. **Optional means optional.** Primitives a layer adds must never be required by the engine or by other layers.
5. **Shared truth wins.** When layers disagree about where someone is, the chat they are in decides.

## Open questions

- **What the stable surface is:** which queries, events and actions, and how they are versioned so layers keep working as the engine changes.
- **Permissions:** tokens for third-party layers, read-only versus acting as you, revocation per layer.
- **Where optional primitives live:** a free-form field per layer, or a small shared schema for position and state.
- **Performance:** a 3D world wants many small position updates, while the engine wants few meaningful writes. Position may need its own lighter channel.
- **Discovery:** how people find, share and install layers others have built.
- **Relation to summaries:** a glanceable summary of a chat (see `chat-summaries.md`) is a natural speech bubble over a room.
