# Compute plane: physics tools on allocated cloud compute

Status: accepted product decision, 27 Sep 2026. Not built. The full design with the architecture diagram is [design/beam-compute-plane.html](../../design/beam-compute-plane.html) (published: https://claude.ai/artifact/RrGPP4nvYqXTpixN3JmEWn). UI mockups for FEA, CFD, EM, molecular dynamics and battery results, compare, sweeps and the shared terminal: https://claude.ai/artifact/14QNjGmoLV1tC614r88E4q.

## Decision

Any agent in Beam can run physics tools on compute Beam allocates, iterate on a setup, and show the results in chat. Startups come first; they, and most students, want compute we allocate rather than bring their own cluster.

- **Agents keep using the engineer's own provider login.** An agent runs on the engineer's machine or on a cloud machine; on a cloud machine the engineer signs in there, and the login stays in that machine's profile. Beam never copies or stores it.
- **Generality comes from environments, not recipes.** Pinned OCI images of open-source tools, in built-in families with a shared base, plus custom environments teams bring. The existing OpenFOAM recipes become worked examples in the `cfd` environment instead of code paths in Beam.
- **Two speeds of compute.** A small cloud machine per chat where the agent runs commands in seconds, and durable jobs on bigger machines that need an approval showing cost. The approval card states the expected cost and the authorized limit ("expected $3–5, authorized up to $8"), never a promised maximum.
- **Modal is the serverless provider** for chat machines and jobs up to 8 cores and GPUs, as Sandboxes. Functions run only work that can restart or resume from a checkpoint, since Modal may preempt them. Whole-node EC2 runs 32- and 96-core machines; the spike showed MPI solves on Modal stop speeding up beyond about 8 processes. AWS Parallel Computing Service runs multi-node MPI later.
- **A new compute gateway** is the only component holding Beam's cloud credentials. It implements `ComputeExecutor` for each provider, meters usage, enforces budget caps and streams logs to Convex. Before it starts any cloud machine, chat machines included, it reserves the job's authorized spend against the workspace budget in one atomic step, and it stops the machine when the reservation runs out. It also writes each job's provenance itself (image digest, input and output hashes, command, machine, times, exit code), so nothing a job writes can mark its own results as validated.
- **Results are referenced by location**, not stored in Convex chat storage. The manifest names where each file lives; R2 is the default store, not a requirement, since Modal bills egress from 1 Oct 2026. Convex keeps the job record, the results manifest and small previews; viewers load previews with signed URLs.

## Vocabulary

One word per concept across Beam, in words engineers already use. **Run** stays reserved for agent runs, which the public Worlds API already names; nothing on the compute side is called a run. The code can keep its internal names (`simulationCases`, `computeJobs`); the UI and any new public API use these.

| Word | Meaning | Example |
| --- | --- | --- |
| Workspace | The team: members, repos, machines, budget. Stays "workspace": it is fixed in the Worlds API and CLI. | Acme Engineering |
| Chat | A conversation. It runs on a machine. "Thread" is a synonym in speech; the UI says chat, because a thread in Slack is a reply chain. | bracket-redesign |
| Machine | Where work runs: the engineer's own computer or a cloud machine, with a shape (cores, memory, GPU) and an environment. Cloud machines appear in Settings → Machines beside local ones. | a 96-core cloud machine |
| Environment | What is installed on a machine. Built-in environments are validated with benchmarks; custom ones come from a team's Dockerfile and are marked custom until they have benchmarks. | the fea environment |
| Simulation | The thing being investigated. It lives at workspace level and any chat can reference it; its card shows the same live state in every chat. | Bracket thermal cycling |
| Setup | Its inputs: files in git plus declared parameters with units. | fillet_radius = 4 mm |
| Version | A saved state of the setup. Results belong to a version. | v4 |
| Job | One attempt to compute a version, on a machine, in stages (mesh, solve, post). Intermediate artifacts like a mesh are cached by content hash. | job 7 |
| Results | What a version produced: Numbers, Plots, 3D, Tables, Checks, Files. | v4 results |
| Terminal | The shell on a chat's machine, shared by the agent and the engineer. | Terminal tab |
| Compare · Sweep | Results side by side · versions that differ only in parameters. | v3 vs v4 · fillet 3–6 mm |

Sentence test: Claude is working on a cloud machine with the fea environment. It saved v4 of the bracket simulation and submitted job 7 to a 96-core machine; Mira approved it from her phone.

## Why Modal

Compared on 27 Sep 2026 with Vercel Sandbox, E2B and fal:

| | Modal | Vercel Sandbox | E2B | fal |
| --- | --- | --- | --- | --- |
| Exec API for agents | yes | yes | yes | no, HTTP endpoints only |
| Largest machine | 64 cores (measured) | 8 vCPU on Pro, 32 on Enterprise | 8 vCPU on Hobby, more on Pro | 8 cores on CPU machines |
| GPUs | yes | no | no | yes |
| 1 h, 8 vCPU, 16 GB | $0.32 as a Function, $0.95 as a Sandbox | $1.36 | $0.66 | n/a |
| Free tier | $30 credit a month | 5 CPU-hours a month | $100 credit once | not assessed |

Modal is the only one that covers chat machines, jobs and GPUs with one image definition, and it has a TypeScript SDK. Restartable batch work can run as Functions, which cost a third as much per core-second as Sandboxes; everything else runs as a Sandbox, which Modal does not preempt. Vercel Sandbox is the fallback for chat machines. Lock-in stays low: providers sit behind `ComputeExecutor`, and environments are plain OCI images that also run under Docker and Apptainer.

## Machines

| Machine | Shape | Backed by |
| --- | --- | --- |
| chat machine | 4 cores, 16 GB, stops when idle | Modal Sandbox |
| 8-core | 8 cores, 32 GB | Modal Sandbox; Function when restartable |
| 32-core | 32 cores, 128 GB, whole node | EC2 (c7a or hpc7a) |
| 96-core | 96 cores, 768 GB, whole node | EC2 hpc7a |
| 1 GPU / 8 GPUs | L40S / H100 | Modal Sandbox; Function when restartable |
| cluster | N × 96-core with EFA | AWS PCS, later |

## Environments

Built-in environments share a base (gmsh, CadQuery/build123d, meshio, TetGen, pyvista, headless ParaView, numpy/scipy, Dakota, OpenMDAO, SALib) and come in separate families, because MPI and PETSc versions conflict across solvers: `cfd`, `fea`, `multiphysics`, `em`, `atomistic`, `chem-energy`, `systems`, `gpu-sci`. The design page lists the tools in each.

Every environment ships `/beam/env.md` and `env.json` (installed tools, a worked example per tool, known gotchas) and a `beam_out` helper that writes results in the standard layout. Built-in environments also carry a benchmark suite with known answers, run on every build and by an agent from a plain prompt; a family is *available* once its smoke tests pass and *validated* once agents reliably solve its benchmarks. Open-source tools only; commercial solvers need a customer's license server, and FluidX3D is excluded for its non-commercial license.

## Results

Every job writes `beam/out/manifest.json` plus the files it names. The kinds are closed and each has one generic view:

| UI name | Manifest kind | What it holds |
| --- | --- | --- |
| Numbers | `quantity` | A named value with unit, optional uncertainty and reference value |
| Plots | `series` | x against one or more y, with units; linear, log or polar |
| 3D | `field` | Surfaces, lines or points with arrays, over labelled steps (time, load step, frequency, mode) |
| Tables | `table` | Rows and columns; any column can be plotted |
| Checks | `check` | pass, review, fail or not evaluated, with value, criterion and stage |
| Files | `geometry`, `image`, `file` | CAD, pictures, raw solver output |

The browser never receives a volume: the environment turns fields into bounded surfaces, lines and points (about 25 MB, 500k triangles, 120 steps) and says when it subsampled. Full data stays in R2 as VTKHDF. Matching across versions uses output name plus unit, which is what makes Compare, overlays and sweeps work without per-physics code. The manifest only grows, like the Worlds API. Contracts: `packages/contracts/src/results.ts` (manifest, preview, plot and table files), `environments.ts` (`env.json`, digest-pinned images), `machines.ts` (the machine list) and `EnvironmentJobSpec` in `compute.ts`; tests parse real `beam_out` output.

## Agent tools

`environment_list`, `machine_open`, `machine_exec`, `machine_close`, `job_submit` and `results_read` are built (local machine; `apps/runner/src/compute/environmentTools.ts`), alongside the existing `get_job`, `list_jobs` and `cancel_job`. A local machine mounts the thread directory, so it needs no sync. Still to come: `machine_sync` (cloud machines), `job_estimate`, `view_publish`, `render_view`. They go through Convex like today's simulation tools, so approvals, chat membership and private-chat rules apply.

## Build order

1. Gateway with the Modal adapter, the built-in `fea` environment, and the machine tools, with budget reservations, metering and the kill path from the start (a Convex schema change). The milestone is one replayable study: an agent sets up the FEniCSx cantilever, runs a small case, promotes it to a batch job, publishes a report, and Beam replays it from the gateway's provenance record. It must survive a lost response, a laptop disconnect, a cancel, and edits made while approval is pending.
2. Results in the standard layout, generic 3D and plot views; move the OpenFOAM recipes into the `cfd` environment.
3. Stripe credits and workspace budget settings, before any outside startup uses it.
4. Whole-node EC2 for 96-core machines, custom environments, then more built-in environments as customers ask.
5. Later: AWS PCS, remote visualization, a bare-metal pool.

Spike results (27 Sep 2026, [environments/spike/REPORT.md](../../environments/spike/REPORT.md)): one image gives identical results locally and on Modal; Modal accepts at most 64 cores, starts a cached sandbox in 1.7 s and turns a command around in under 0.4 s; a 2M-unknown MPI solve on a 64-core Modal Function was fastest on 8 processes (41.6 s) and slower on 64 (72.6 s). EC2 scaling is the next measurement.

## Revisions

28 Sep 2026, after a design review, agreed by Apekshik and George: budget reservations and the kill path move into phase 1; Functions only for restartable work; results referenced by location with R2 optional; the first milestone is a replayable study rather than the provider catalog; approval cards show expected cost and the authorized limit. The AGENTS.md line reserving cloud providers for the gateway landed with the gateway.

## Open

- Pricing: compute at cost plus a margin, or bundled into a plan.
- Export control: some startup data falls under ITAR or EAR, which may mean US-only regions.
- Long jobs: answered by an approved "when this finishes, continue" step. An agent says at submission what it will do once a job or sweep ends; approving the job approves that, and Beam mentions the agent as the approver when the last job ends (convex/jobResume.ts).
- Simulations at workspace level replace today's rule that a study belongs to one chat.
