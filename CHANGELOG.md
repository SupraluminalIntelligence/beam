# Changelog

What changed in Beam, newest first. The app shows this under Settings › What's new. Add a line under Unreleased with any user-visible change; a release renames Unreleased to its version and date.

## Unreleased

- Simulations: studies are now one kind of simulation, and agents can make the other kind from anything they build. A simulation keeps immutable versions, each a snapshot of its files, the parameters the team varies (with units), its environment and its run command, so every result traces back to exactly what produced it. Agents save a version before running it, sweep a parameter across values, and compare versions' numbers and checks. A simulation's card in the chat shows its latest job, headline numbers with units and uncertainty, and the checks that need review, on the phone too, where you can approve its job. Its page (open it from the card or from Simulations in the sidebar) shows each version and what changed, lets you edit parameters as the next version and run it, and shows results: checks, numbers against references, plots over reference data, tables, and a comparison of versions with a plot against the swept parameter. Approve all of a sweep's waiting jobs at once from its Jobs tab.
- Agents can run physics tools in a built-in environment on your computer. Ask for a structural or thermal check and the agent opens a machine with the **fea** environment (FEniCSx, gmsh, pyvista) in Docker, tries commands against your thread's files in seconds, then submits the full run as a job. The job's numbers, checks, plots and 3D preview are published to the chat; files over 20 MB stay on your computer and are listed. The machine has no network and stops after 30 idle minutes. Needs Docker and a one-time `docker pull` of the environment, which the agent tells you. Cloud machines come later.
- PR automation: the CI chip on each open PR now opens CI monitoring with three switches. **Auto-fix CI & address comments** sends the thread's agent to fix failing checks (once per push, up to three tries) and new review comments, as a message from you. **Auto-merge when ready** merges on GitHub as you once checks pass, reviews allow it and no comments are open, and otherwise says what it is waiting for. **Settle thread on merge or close** settles the thread when the PR is done and no other PR there is open. Unresolved review comments show as a count beside CI and in the popover, and Ask to fix covers them too. Hovering a PR's number shows a card with its state, full title, author, age and size.
- Windows Settings can open PowerShell for Codex and Claude setup and sign in to the selected account. CLI discovery refreshes PATH after installation and resolves npm launchers to executable entry points. Remote machine setup commands are copied instead of running on the local desktop.

- Windows releases now join the macOS release before it becomes public. The release workflow verifies update checksums and exercises an installed Windows upgrade; clicking Install lands the runner's work, updates silently, and reopens Beam.

- Windows desktop: build a native x64 installer, open provider sign-in in PowerShell, and use native window controls. Closing or updating the app lets the runner finish landing work through a cross-platform shutdown channel. Windows CI builds and smoke-tests the packaged app; authenticated provider runs and signed release delivery still need end-to-end verification.

- Wind tunnel with your own model: New study › Wind tunnel · import a 3D model loads an STL or OBJ (up to 200,000 triangles), checks that it is watertight, and builds a tunnel, mesh and slices sized around it within the local cell budget. Set the file's units and quarter turns in the rail, then mesh and run as usual for drag, lift and streamlines. Agents can do the same from a file in the repo or one shared in chat. Import repairs the small seams, T-junctions and gaps that exported models often have, and says what it fixed.
- New study › Wind tunnel · Windsor body · WindsorML: a car-like test body from an open research dataset, ready to mesh and run, with the dataset's high-fidelity drag (Cd 0.3225) to compare against.
- When Beam refuses something an agent asked for, the agent now sees why (for example "Select this study explicitly before running it") instead of "Server Error", so it fixes the request rather than guessing that Beam is broken.
- Wind tunnel: put an Ahmed body, the standard car-like test shape, in a 3D study and see streamlines flow over it, the drag and lift coefficients over time, and how the drag compares with the wind-tunnel measurement. New study › Wind tunnel · Ahmed body · 25° sets up the classic case at 40 m/s.
- Settings › Models & accounts has a **From phone and apps** account per agent: the machine and account that run agents you start from your phone, the `beam` CLI or a Beam World, which have no machine of their own. With one signed-in account, Beam offers it. Approving an app that can start agents asks the same question.
- Beam Worlds: build your own world on Beam, whether a 2D or 3D space, a dashboard, a terminal feed or a world of sound. The `beam` CLI and `@beam/worlds` read your workspaces, chats, messages, agent runs, pull requests, presence and inbox live, as JSON or as events. With permissions you approve, a world can also post, react, answer agents, stop runs, say which chat you are in, and keep its own state (where you stand in it, say). Apps connect with a code you approve, and Settings › Connected apps lists and revokes them.
- 3D simulation studies: a box domain with spheres, boxes and cylinders, meshed with snappyHexMesh and solved laminar or with k-ω SST turbulence on up to four cores. Results play back on slice planes and body walls in a 3D view.
- Quitting or updating Beam no longer strands an agent's work. Runs in progress are stopped as if you pressed stop, and their edits are committed and pushed before the runner goes offline. Beam's window hides while this finishes, which takes up to a minute. A run that hadn't started yet waits for the next launch.

## 0.1.10 — 2026-09-26

- Chats show live status in the sidebar, tabs and ⌘K: pulsing blue while an agent or job runs, half amber when an agent is waiting on you, green when a run finished and you haven't looked, ✕ when it failed, and a blue outline when someone mentions you.
- Parallel-channel studies: two to four heated or unheated channels between an inlet and an outlet manifold, solved transient with buoyancy in the real orientation (stacked, or vertical with flow up or down). Results show how the flow divides between channels over time, each channel's exit temperature, the hottest heated wall against the boiling point, and how much of the heat has left the outlet. The default is the two-channel HFE-7100 device from Masrouri and Yagoobi (IJHMT 2026) without its EHD pumps: on real OpenFOAM the heated lower channel draws 57% of the flow at 5 s, within half a point on three meshes, and its walls pass 61 °C after about 2 s. Setup checks flag buoyancy, convection rolls in channels heated from below, boiling walls and a run too short to reach steady state. Agents set up and run the same study.
- Heated channels can take a uniform heat flux on both walls instead of a fixed temperature, for chips and heaters. Set the flux in W/cm² and the fluid's conductivity. Setup checks estimate the hottest wall before running, and Results report the actual maximum wall temperature and its margin to the boiling point, with Nu against the developed 8.235. On a real solve the outlet temperature matches the energy balance to 1e-5.
- Mesh-independence studies for the heated channel: solve one setup on three meshes and Results shows each quantity's grid convergence index, observed order and extrapolated value (Celik et al. 2008). Agents run the same study with `mesh_convergence`. On real solves f·Re extrapolates to 96.03 against the exact 96.
- Heated-channel results report what a heat-transfer engineer checks: flow-weighted bulk outlet temperature, mass and thermal balances from the solver's own face fluxes, f·Re against 96, and a local Nusselt number plot against the developed 7.54. Verified on real OpenFOAM solves: balances close to 1e-5 or better, f·Re lands within 1% of 96, and Nu reaches 7.77 at the end of a 1 mm HFE-7100 channel.
- Heated-channel studies check their own assumptions before anything runs: gravity off (Richardson number), single phase (boiling point), viscosity units and entry lengths. The checks update as you edit Setup, show on the study card and in the Results checks, and agents see them too. Set the fluid's expansion coefficient and boiling point to turn on the first two.

## 0.1.9 — 2026-09-26

- PRs from Beam look like any other PR: ready for review instead of draft, titled and described by the agent that did the work, and committed under your own git name so GitHub shows your avatar. Commits fall back to Beam only on a machine with no git identity.

## 0.1.8 — 2026-09-26

- Open PRs sit above the composer with a state icon, number, branch, size and live CI. Click CI to see which checks failed, open their logs, or ask the agent to fix them. Click the branch to copy it or open it on GitHub. A pushed branch without a PR gets a Create PR button. In the chat, each run leaves a one-line record of where it pushed.
- Invalid or inaccessible repo names no longer lock a thread while attaching a repo.
- Beam for iPhone: read chats, answer agents, approve, react and steer from your phone, with push notifications for your inbox.
- Usage & limits: see how much of each plan window your Claude Code and Codex accounts have used, and when each resets. Numbers refresh on every probe and while agents run.
- The account menu shows whether your machine is ready, your tightest usage window, and quick links into Settings.
- Pause desktop notifications for an hour or until tomorrow. The inbox keeps collecting.
- Settings groups its pages into You, Workspaces and Beam. Folder sharing moved to Machines; Shortcuts lists every shortcut.
- What's new: this changelog, inside the app.

## 0.1.7 — 2026-09-26

- Settings is a rail of pages: General, Models & accounts, Machines, Notifications, and a page per workspace with its repos, members and agents.
- Model, effort and account are personal and follow you across workspaces; permissions and context stay shared per workspace agent.
- Opus 5.5 for Claude Code.
- The desktop runner restarts when it exits, and Beam says so when it's down.
- Study moved to the chat header; the composer toolbar holds the agent and its account.
- Runs always land, even when the harness fails mid-conversation, and stranded runs stay visible.

## 0.1.4 — 2026-09-23

- Beam's source is public under the MIT license, with a contribution guide.

## 0.1.0 — 2026-09-21

- Tools pane beside the chat: browser preview, context sources, file attachments, compute jobs and a CAD viewer.
- Notifications with an inbox, typing status, and a chronological timeline of replies and tool activity.
- Permissions in the composer and a context menu on every chat.
- Personal model and effort per harness, run attribution, and Codex sessions.
- A new look and app icon.

## 0.0.5 — 2026-09-03

- Signed, notarized Mac builds that update themselves.
- Live timers and waiting notes on long runs; runs can no longer hang a thread.
- Approval shortcuts: ⌘↵ allow, ⌘⇧↵ always allow, ⌘⌫ deny.
- Invite picker lists people already on Beam.
- Resizable sidebar, pinned agents, and chats that are open or settled.
