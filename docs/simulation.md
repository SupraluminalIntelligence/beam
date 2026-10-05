# Simulations

A simulation is something an agent built and ran in a chat, kept so the team can trust, rerun and vary it. Agents make them from files; there is no separate setup pane.

## How an agent makes one

1. **Open a machine.** `machine_open` starts the thread's machine with an environment (`fea`: FEniCSx, PETSc, gmsh, pyvista; `cfd`: OpenFOAM 2512, pyvista) and returns the environment's guide, `/beam/env.md`. `machine_exec` runs commands there in seconds, with the thread's directory at `/work` and no network: write a setup, mesh, run a coarse case, fix, repeat. While it does, Beam reads what the solvers write there (an OpenFOAM case's `log.<application>` files, `postProcessing/` function-object output such as `forceCoeffs` and `yPlus`, and `log.checkMesh`) and shows it live on the simulation's page. The first real work on the machine (a mesh, or a solver log) makes a draft simulation, named after the case's top folder; saving v1 turns that draft into the simulation.
2. **Save a version.** `save_version` snapshots the files (up to 64, 20 MB each), the parameters the team varies (with units), the environment's pinned image and the run command. A version never changes; editing parameters in the app saves the next one.
3. **Run it.** `run_version` submits the version as a job; `sweep` submits one job per value of a parameter. Unless the chat is in auto mode, each job waits for a person to approve it (the simulation's Jobs tab approves a sweep's jobs at once). This computer runs one job at a time; a job parallelises inside itself with MPI over `$BEAM_CORES`.
4. **Report.** The job writes results with `beam_out` (below), and the agent reads them back with `get_job` or `compare_versions` and reports the numbers with the checks that say how far to trust them.

## Results

A job's results are what its `beam/out/manifest.json` names, written by `beam_out` in Python:

- `out.quantity`: a number with its unit, uncertainty (a grid convergence index from `gci`) and a reference value.
- `out.check`: how far to trust it (pass, review, fail, not evaluated), such as mesh convergence or agreement with theory.
- `out.series`, `out.table`: plots and tables. A series is its own plot; `overlay="<series>"` draws it on another's plot with the same axes, such as reference data over a result.
- `out.field`: a 3D field on a tetrahedral mesh, drawn in the app (colour by any array, deform by a displacement, step through saved frames) with the full data for ParaView.
- `out.openfoam`, `out.scene`: a flow's walls, slices and streamlines, each of which can be shown, hidden or made see-through.
- `out.file`: any other file; pictures show under Figures.

Files over 20 MB go to the deployment's R2 storage when it is configured (see compute-and-tools.md), and stay on the machine otherwise.

## In the app

Every job belongs to a simulation. A version's job (`run_version`, `sweep`) belongs to its simulation; a one-off `job_submit` or `submit_job` belongs to the simulation the agent is working on, or to a draft made for it. Jobs are numbered within their simulation (v2 · job 3).

The simulation's card in its chat is one card updated in place: the agent's work on the machine, then a running job, then checked results. Live phases draw a history small (drag if the case reports it, else residuals) with the latest numbers. A job waiting for approval can be approved on the card. Its page has four tabs:

- **Results**: the latest of the machine's work, a running job, or a job's checked results: checks, numbers against references, plots over reference data, tables, figures and 3D views. While a local job runs, Beam reads its working directory the way it reads the machine, so its residuals and coefficients show live until its checked results replace them. **Showing** picks any of them.
- **Setup**: each version and what changed, its parameters (edit and save the next version), command, environment and files, and Run.
- **Jobs**: the simulation's jobs by what they need (needs you, running, queued, done), with approve, deny, cancel, the log, and results.
- **Compare**: versions' numbers side by side, and a sweep's results plotted against the swept parameter.

**This computer**, at the foot of the sidebar, is the one view across chats: what your computer is running, what is queued behind it, what is waiting for approval, and agents working on a chat's machine. Each line opens its simulation. Jobs from chats you can't see are counted, not shown.

## Studies (retired)

Beam used to set up a few fixed OpenFOAM studies (heated channel, cylinder wake, 2D fluid domain, parallel channels, 3D wind tunnel) in a Simulation pane. The pane and the agent tools for studies are gone: anything they did, an agent now builds in the cfd environment as an ordinary simulation. An existing study still opens as a simulation page with its jobs and results, read-only.
