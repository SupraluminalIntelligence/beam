# Tools pane and durable local compute

Open **Tools** in a chat header. The pane has Browser and Context under General, with Compute Jobs, CAD Viewer, and CFD Editor under Engineering. [CAD Viewer](cad-viewer.md) opens STEP/IGES/STL/OBJ models, chat attachments, and compute results. CFD Editor remains marked Coming next; this does not install an OpenFOAM editor.

The Context pane is described in [context and workspace sources](context-and-sources.md).

The pane has independent per-chat tabs, resizing, maximization, and an inline job card that opens the same durable job record. Closing a pane never cancels a job. Pane state is personal local UI state; jobs, inputs, logs, and results belong to the shared chat.

## Browser and T3 Code reuse

The desktop browser uses an Electron guest in its own persistent session, with no Beam preload or Node access. A host outside the pane retains pages when switching tools or hiding the pane. Back, forward, reload/stop, recently used pages, and local web server discovery are available. Closing the Browser tab releases its guest. Only the last URL is restored after an app restart, not an in-memory page/session history.

The web version uses a sandboxed iframe; sites can refuse embedding. Open externally in that case. Guest permission requests, popups, and automatic downloads are blocked in this first desktop integration; use the external browser for workflows needing those. Browser cookies and recent URLs stay local and are never sent as chat context automatically. Browser sessions share a separate browser cookie partition on the local desktop.

Discovery runs in the local runner CLI, invoked through the desktop bridge, even if no runner is paired. It parses local listeners and uses bounded HEAD probes to list successful HTML endpoints. It does not follow redirects or scan remote machines; HTTPS-only servers and servers requiring a redirect may need a manually entered URL. The current scanner uses lsof on macOS/Linux, with common-port probing as fallback.

T3 source was refreshed to `1de563c1`; [reuse inventory](../apps/web/src/vendor/t3code/README.md) identifies copied/adapted helpers and license locations. The full Ghostty/PTY terminal is a future integration. URLs in compute logs already use T3's terminal link matching to open Browser.

## Job lifecycle

`ProcessJobSpec` describes a versioned executable/argument list, immutable input asset references with job-relative paths, explicit output paths, and a deadline. Inputs are stored with size and SHA-256 metadata and verified before execution. A job receives a stable ID and an execution handle independent of any agent turn.

```
awaiting-approval → queued → preparing → running → publishing → succeeded
                                        ↘ failed / cancelled
```

Both the form and agent tools call the same Convex compute service. Agent tools are `submit_job`, `list_jobs`, `get_job`, and `cancel_job`. Plan mode cannot submit; ask/allow-list submissions wait for the requesting person to approve the command and snapshot. Auto mode can submit directly. Manual form submission is explicit authorization. Chat membership, private-chat access, runner ownership/sharing, and runner token checks apply at service boundaries.

`watchCompute` reconciles jobs separately from agent runs. One local job executes at a time per runner. The local executor launches a detached supervisor into a private directory under `~/.beam/compute/<jobId>/work`. It runs the installed executable directly without an implicit shell, records bounded logs/heartbeat/result receipts, enforces timeouts, and stops the process group on cancellation. Commands have the runner user's privileges; the working directory is not an OS sandbox. No dependencies are installed automatically.

The supervisor survives the submitting agent, runner, or app exiting. Reconnecting a runner recovers by job ID without replaying computation. Lost status/upload responses are retried; published outputs are deduplicated per path. Success is recorded only after every declared output has been published. App/runner shutdown does not cancel jobs. Cancellation requires a connected runner to acknowledge it.

This does **not** guarantee execution across host reboot or power loss. A stale/missing receipt is reported as failed/uncertain and never automatically replayed. A hard-killed supervisor can leave a process whose state needs manual inspection. A failed job must be explicitly submitted as a new job to retry it.

Current limits: native macOS/Linux local execution (Windows via a Linux/WSL runner), 24-hour deadline, 64 inputs, 20 MB per file, 100 MB total input, 16 result files, 48,000-character specification, and the latest 16,000 log characters. This is a foundation for small local jobs, not yet a large CFD data pipeline. Job/asset retention and storage garbage collection need an explicit future retention policy.

## Extending to compute servers / HPC

`ComputeExecutor` defines `submit`, `recover`, `inspect`, `cancel`, `cancelSubmission`, and `readOutput`. Submit must be idempotent for the Beam job ID and inspect must work after reconnect. Cancellation before a handle is saved persists a tombstone by Beam job ID so a racing submission cannot escape it. The durable job ID and artifact references stay the same when adding an executor; the current service advertises and validates only `local-process`.

A remote implementation must add target discovery/authentication and capabilities, resource requests (CPU/RAM/GPU/wall time), scheduler mappings (e.g. Slurm job IDs), durable leases/heartbeats, and resumable object-store staging. Large meshes and field results should move through object storage directly, with previews/metadata in Beam. Production remote targets also need quota, retention, and authorization policies. The contract provides a seam, not an implemented remote scheduler.

CAD/CFD editors can use the same pane shell to edit a case/model revision, snapshot it, submit a job, and open returned geometry/field artifacts. Kernel sessions and interactive visualization sessions should be separate resources from batch solver jobs. The UI remains an interface; compute runs at the selected target.

## Activation and validation

Deploy the Convex schema/functions, rebuild the web and desktop bundles, and restart the Beam runner to advertise local compute. **This repository currently uses one production Convex deployment for both dev and deploy**; `pnpm convex` also publishes there. Code generation alone does not activate functions. The new Browser guest requires restarting the desktop main/preload process.

Validation includes contract and authorization tests, local process tests for restart/cancel/timeout/snapshots, reconciliation tests for publication retry and handle recovery, T3 crash-recovery/URL helpers, desktop guest isolation, and server discovery tests. An isolated UI fixture was used to exercise the launcher, form, file preview, native browser navigation, live local server discovery, and preservation of an unsaved page input across pane closure. Fixtures do not create real chat jobs.
