# Compute gateway

The one part of Beam that holds Beam's cloud credentials and starts machines on Beam's accounts. Design: [compute plane](../../docs/decisions/2026-09-27-compute-plane.md).

It claims cloud jobs from Convex with its own service token and drives each one through the same reconcile step the runner uses for local jobs (`packages/compute`), with `ModalExecutor` in place of the local executor.

| File | What |
| --- | --- |
| `src/main.ts` | The gateway process: connects to Convex and watches for cloud jobs |
| `src/watch.ts` | Claims queued cloud jobs and reconciles several at once, one pass per job at a time |
| `src/modal.ts` | `ModalExecutor`: environment jobs on the `chat`, `8-core` and GPU machines, each in its own Modal Sandbox |
| `src/supervisor.ts` | The sandbox's entrypoint: waits for staged inputs, runs the command with its time limit, records log and exit code |
| `src/port.ts` | The few Modal SDK calls the executor uses, behind an interface the tests fake (`src/fake.ts`) |
| `src/smoke.ts` | Runs the `fea` cantilever benchmark on Modal end to end, without Convex |

## How a job runs

1. An agent or engineer submits an environment job for a cloud machine. Convex prices it from the machine's rate (`cloudCentsPerHour` in `packages/contracts/src/machines.ts`, Modal's Sandbox list prices at cost) and its authorized amount: the machine's whole capped life, launch window + job timeout + collection window. When the job is queued (at submission, or at approval), that amount is reserved against the workspace's compute budget in the same transaction, so concurrent approvals cannot overdraw it (`convex/computeBudget.ts`).
2. The gateway claims it and `submit` creates a sandbox named `beam-job-<jobId>` from the environment's image by digest, with no network and hard CPU and memory limits. The handle is the sandbox ID. An image Modal cannot pull or build fails the job; a create call Modal does not answer is retried. The gateway holds at most 16 machines at once (claimed jobs count until released).
3. It downloads each input from Convex storage, checks its SHA-256, writes it under `/work` along with `beam/parameters.json` when the job has parameters, then writes `go`. The command runs through the same job script as local environment jobs. A download that fails without an answer or with a server error is retried on the next pass. If staging fails it writes the reason and `abort`, and the command never starts. A write Modal does not answer is never followed by `abort`, since it may have landed: the next pass inspects the sandbox and resumes staging only if neither receipt is there. Cancelling a job while it stages terminates the sandbox at once.
4. Each pass `inspect`s the exit code and the last 16 KB of the log, and reports to Convex, which meters the machine's time from when the gateway launched it (or, for a machine recovered after a restart, from the start of its launch window) until the gateway confirms it stopped. A job that reaches its authorized amount is marked for cancellation and stopped on the next pass. A call to Modal that gets no answer leaves the job as it is for the next pass; only a known outcome ends it.
5. When the command ends, the sandbox stays up so `readOutput` can collect `beam/out/…` from `/work`, publishing each file as it is read (up to 128; a file over 20 MB is listed as not kept). Once the outcome is recorded, `release` terminates the sandbox and the gateway tells Convex, which settles the job: metered spend moves to the workspace total and the rest of the reservation is released. A failed release is retried on the next pass, with the reservation still held.

A launch whose outcome is uncertain is inspected, never replayed: a second `submit` for the same job returns the existing sandbox, and a sandbox that never received `go` exits after five minutes. If the gateway is down, Modal still stops every sandbox at the end of its capped life, which the reservation already covers.

Provenance comes from Beam's records, not the job's: `compute.get` returns the pinned image, command, machine, input and output hashes Convex computed on upload, times and exit code.

## Run it

```sh
# once: a random token for the gateway, and its SHA-256 in the Convex deployment
TOKEN=$(openssl rand -hex 32)
npx convex env set BEAM_GATEWAY_TOKEN_SHA256 $(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)

CONVEX_URL=… BEAM_GATEWAY_TOKEN=$TOKEN MODAL_TOKEN_ID=… MODAL_TOKEN_SECRET=… pnpm --filter @beam/gateway start
```

A workspace needs a compute budget before it can queue cloud jobs; its creator sets one with `computeBudget.setAllowance` (no UI yet).

Without Convex, the smoke test runs one job straight through the executor:

```sh
MODAL_TOKEN_ID=… MODAL_TOKEN_SECRET=… pnpm --filter @beam/gateway smoke          # chat machine, 4 cores
MODAL_TOKEN_ID=… MODAL_TOKEN_SECRET=… pnpm --filter @beam/gateway smoke 8-core
```

## Not yet

- Somewhere to host the gateway process, and a budget setting in the app.
- Approval cards that show expected cost beside the authorized amount; agent tools that pick a cloud machine.
- The chat machine as an interactive cloud machine (`machine_open`, `machine_exec`); today `chat` runs batch jobs.
- Modal Functions for restartable batch jobs. They cost about a third of a Sandbox per core-second but may be preempted, and can only be defined in Python.
- EC2 whole nodes for the 32- and 96-core machines, and results in R2.
