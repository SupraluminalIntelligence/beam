# Compute gateway

The one part of Beam that holds Beam's cloud credentials and starts machines on Beam's accounts. Design: [compute plane](../../docs/decisions/2026-09-27-compute-plane.md).

This first slice is the Modal executor. It implements `ComputeExecutor` (`packages/contracts/src/compute.ts`), the same interface the runner's local executor implements, so the existing reconcile loop can drive it unchanged.

| File | What |
| --- | --- |
| `src/modal.ts` | `ModalExecutor`: environment jobs on the `chat`, `8-core` and GPU machines, each in its own Modal Sandbox |
| `src/supervisor.ts` | The sandbox's entrypoint: waits for staged inputs, runs the command with its time limit, records log and exit code |
| `src/port.ts` | The few Modal SDK calls the executor uses, behind an interface the tests fake |
| `src/smoke.ts` | Runs the `fea` cantilever benchmark on Modal end to end |

## How a job runs

1. `submit` creates a sandbox named `beam-job-<jobId>` from the environment's image by digest, with no network, the machine's cores and memory, and a lifetime of launch window + job timeout + one hour to collect results. The handle is the sandbox ID.
2. It downloads each input from Convex storage, checks its SHA-256, writes it under `/work`, then writes `go`. If staging fails it writes the reason and `abort`, and the command never starts.
3. `inspect` reads the exit code and the last 16 KB of the log from the sandbox. The sandbox stays up after the command ends, so `readOutput` can collect `beam/out/…` from `/work`.
4. `release` terminates the sandbox once results are published; `cancel` terminates it early.

A launch whose outcome is uncertain is inspected, never replayed: a second `submit` for the same job returns the existing sandbox, and a sandbox that never received `go` exits after ten minutes.

## Try it

```sh
MODAL_TOKEN_ID=… MODAL_TOKEN_SECRET=… pnpm --filter @beam/gateway smoke          # chat machine, 4 cores
MODAL_TOKEN_ID=… MODAL_TOKEN_SECRET=… pnpm --filter @beam/gateway smoke 8-core
```

## Not yet

- The gateway process: registering with Convex, claiming jobs for cloud machines and running the reconcile loop with this executor. That needs Convex to route jobs by machine, which PR #40 is changing now.
- Modal Functions for batch jobs. They cost about a third of a Sandbox per core-second but can only be defined in Python, so every size runs as a Sandbox for now.
- EC2 whole nodes for the 32- and 96-core machines, metering and budget caps, results in R2.
