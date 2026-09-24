# Simulation: runnable OpenFOAM studies

Open **Tools → Engineering → Simulation**. The local connector needs Docker running and this pinned OpenCFD image installed:

```sh
docker pull opencfd/openfoam-default:2512@sha256:33fb575aa9980d2bc42fd58c75ae698c489293ba30c991380fe3f899c622f319
```

Restart or re-probe the connector after installation (it also probes every five minutes). Beam never pulls an image as a side effect of submitting a job. The image supports Apple Silicon and x86-64. This is OpenCFD's 2512 distribution, not OpenFOAM Foundation 12.

## Studies in chat

When the installed tool schemas change, Beam starts a fresh Codex session using the shared chat context, so older chats receive the new capabilities. Unchanged schemas continue to resume normally.

A **study** is the saved setup; a **run** executes an immutable revision. Ask an agent to create a supported study in chat, or use the Simulation pane. Creation selects the study and adds one live card to the conversation. That card reflects subsequent mesh/run jobs and links to the setup, results, and job details; submitting a simulation no longer adds a separate job card every time.

The composer shows **Working on: [study] · rN**. Its picker lists this chat's studies and accessible workspace studies. Workspace entries reopen the originating chat; this first primitive does not attach a mutable study across multiple chats. Existing chat membership and private-chat permissions continue to govern access. Selecting a legacy sample gives it a card without changing its setup or running anything.

Each sent message records its study name, ID and saved revision. Agent dispatch binds to that message's study, including delayed router dispatch. While an agent is working, the UI cannot silently switch its working target; the agent can use `select_simulation` for an explicit requested change. At each initial message and follow-up, the runner supplies saved study context and recent job references. Agents read `list_simulations` before changes, update via `save_simulation` with the current revision, and reuse the existing study for parameter follow-ups. Concurrent stale writes fail instead of overwriting another edit.

Pane edits remain a local draft until Save, Mesh or Run. The composer explicitly labels unsaved edits; agents see saved settings. Clean panes refresh after an agent changes the setup. Dirty panes keep the draft and show a conflict instead of discarding it. All newly saved revisions are retained; older legacy revisions survive in their job snapshots. Results explicitly identify previous revisions after setup changes. Opening a result card targets its exact saved job.

## Agent-composed planar flow

Agents can now create a `geometry: "planar"` study through `validate_simulation` → `save_simulation` → `run_simulation`. This is a composable geometry definition, not a selected fixed recipe:

- The outer fluid domain is a simple polygon with a named boundary on every edge. Edge i joins vertex i to vertex i+1; the last edge closes the loop.
- Any arrangement of up to 24 circular or simple polygonal bodies is subtracted from that domain. Bodies have stable names and explicit no-slip wall surfaces. Circles are approximated by at least 32 straight segments, refined with mesh size (maximum 256).
- One named fluid region supplies explicit constant density and kinematic viscosity. A material label is descriptive; it does not fetch properties.
- Named boundaries support velocity inlets, fixed gauge-pressure outlets with backflow handling, walls and symmetry. Solver pressure is kinematic; boundary pressure and exported pressure are in Pa.
- Mesh size, initial velocity, duration in seconds and output frame count are explicit. The current physics is transient incompressible laminar isothermal flow using `pimpleFoam`. No turbulence, thermal transport, solid-region solve or 3D CAD preparation is implied by this path.

Validation rejects self-intersections, overlapping/touching bodies, bodies outside the domain, gaps below the geometric resolution check, missing/unused boundaries, invalid property values and excess resolution. The runner creates a constrained Delaunay triangulation of the actual domain and holes, extrudes it one cell deep with empty front/back boundaries, and requires OpenFOAM `checkMesh -allTopology -allGeometry` to pass before publishing a usable mesh. Narrow features or poorly shaped geometry can still fail quality checks: those are returned as job diagnostics, not silently ignored. The local budget is 12,000 cells and 100 saved times. Vorticity is a derived diagnostic: its `curl(U)` uses an explicit least-squares gradient, independently of the limited gradients used by the transport solver. Using the transport limiter for curl can suppress individual near-wall components and produce spurious dark patches. This correction applies to new runs; previously published results remain immutable.

The pane shows the declared geometry, editable body positions/vertices, fluid properties and boundary values, and the **actual generated mesh** (`mesh-view.json`). Results reuse the field player across arbitrary planar domains; excluded body interiors remain empty. Geometry/mesh/patch-type edits invalidate mesh reuse, while changes to inlet values, material properties or duration retain compatible meshes. Existing job snapshots remain immutable.

For example, ask an agent to construct three cylinders in an equilateral triangle, assign the exterior inlet/outlet and separate wall patches, validate, mesh, inspect the diagnostics, and run. The generator also accepts nonrectangular domains and polygonal obstacles. Mesh sensitivity, conservation diagnostics and physical validation remain separate work; successful execution is not proof of accuracy.

## Local mesh refinement and run comparison

Planar studies accept an optional `refinements` array. `meshSize` remains the coarse background spacing. Every entry has a unique `name`, a target `size` in metres, and a `transition` distance over which spacing grows back to the background. The smallest overlapping request wins. Transition must be at least twice the background-minus-target size to avoid abrupt size changes.

- `kind: "body-distance"`, `body`, `distance`: target spacing in a band extending the given distance from a named body surface.
- `kind: "box"`, `min: [x,y]`, `max: [x,y]`: target spacing in an axis-aligned region, such as a downstream wake.

The runner subdivides candidate sampling cells and boundary segments according to this size field, then generates the constrained triangulation. This is static local refinement, not dynamic solver adaptation or wall-normal boundary layers. Sizes guide point spacing; they are not guarantees that every resulting triangle edge is shorter than the target. Geometry quality is still checked by `checkMesh`. Point, sampling and 12,000-cell budgets fail explicitly rather than silently weakening a request.

Setup and Mesh expose the same editable refinements. The checked mesh preview shows the actual cells. Run history displays the refinement settings from each immutable run, including older revisions. Any refinement change invalidates mesh reuse; old studies without refinements retain their existing mesh identity.

An agent should retain the baseline solve ID, read the saved study, add body bands and wake boxes, call `validate_simulation` to check the cell budget, save a revision, mesh, inspect quality, solve, and call `compare_simulation_runs`. That tool compares succeeded planar runs from the same study with unchanged geometry and physics. It reports cell count/quality, saved settings and area-weighted speed, pressure and kinetic-energy density at the latest common physical time, with time interpolation if necessary. It does not compare matching cell indices across different meshes. Domain statistics are not force coefficients or a mesh-convergence claim; drag, lift and shedding-frequency diagnostics remain unimplemented.

## Heated channel

1. **Setup** defines a planar channel, a constant-property fluid, inlet velocity and temperature, outlet gauge pressure, and no-slip walls. Walls can have a prescribed temperature or be adiabatic. Save gives the case a revision; Mesh and Run also save valid edits before submitting.
2. **Mesh** runs `blockMesh` and `checkMesh -allTopology -allGeometry` in an isolated job directory. It publishes the mesh snapshot plus measured cell count, skewness and non-orthogonality. A solver job can only use a succeeded mesh from the same case with matching dimensions and cell counts.
3. **Runs** executes `buoyantBoussinesqSimpleFoam` against that immutable mesh and the saved configuration. Buoyancy is disabled (`g = 0`, `beta = 0`); this is steady laminar forced flow with passive thermal transport. Live logs, cancellation and a completed residual history are available. Initial residual targets are pressure 1e-6 and velocity/temperature 1e-7. Hitting the iteration limit can produce valid output files without meeting convergence; the report distinguishes these states.
4. **Results** displays exported cell-centred speed, gauge pressure (kinematic pressure multiplied by the specified density), and temperature. The plot provides numeric cell readouts and an explicit scale. Pressure drop and outlet temperature are estimates from the first/last cell columns, not surface integrals or flow-weighted averages. Download `case.tar.gz` to inspect the native case in ParaView via `case.foam`.

This first recipe supports a single 2-D fluid region, Reynolds number up to 1500 based on twice channel height, and at most 12,800 cells. It does not yet prepare imported CAD, solve a solid thermal region, model turbulence, or calculate mass/thermal balances. Mesh sensitivity and physical validation are explicitly unassessed. A completed job or residual convergence is not evidence of an engineering-valid result.

## Cylinder wake · animated

In the rail, choose **New study → Cylinder wake · animated**, then **Mesh → Run → Results**. The default is a 10 mm cylinder at 0.1 m/s, Re 150, in a 20D × 8D domain. `blockMesh` generates 7,344 graded, body-fitted cells; `checkMesh` verifies them. `pimpleFoam` integrates incompressible, isothermal laminar flow for 100 advective units D/U (10 physical seconds by default). Viscosity is derived from U D / Re. The recipe bounds Re to 60–180; lower-Re cases can take longer to develop a visible wake.

The inlet is axial, the cylinder is no-slip, the outlet has fixed gauge pressure, and the far-field sides are symmetry boundaries. A declared 1% transverse initial velocity perturbation breaks numerical symmetry; no synthetic vortices or ongoing transverse forcing are added. Adaptive time stepping targets Courant 0.7, with a conservative first step. A completed transient reports end time and maximum Courant number, not steady-state convergence.

100 saved output times contain U, p and solver-computed vorticity. `fields.json` describes actual cell polygons, centres, times and ranges. `frames.bin` stores little-endian Float32 values in frame-major, cell-major `[Ux, Uy, p in Pa, omega-z in 1/s]` order (11.8 MB at the default resolution). Playback validates byte count and finite values, interpolates time snapshots and reconstructs a continuous display field using shared inverse-distance corner averages and linear interpolation within each convex cell (without separate cell-centre peaks), and supports pause, restart, scrubbing, and speed. The vorticity palette distinguishes opposite rotation; its explicit ±2U/D limits clip stronger near-wall values to reveal the wake. Numeric hover readouts use the original cell values and are unclipped. Display interpolation does not refine the solver mesh; coarse cells can still produce visible faceting. Speed and pressure use fixed ranges across all times. The view is cropped; the full domain is simulated. Repeating playback explicitly restarts the sequence; it does not fabricate a periodic final-to-first transition.

The native archive includes the final time and original case dictionaries; the separate playback files contain the time series. This is a coarse flow demonstration, not a validated drag, lift or shedding-frequency prediction. Mesh/domain sensitivity, conservation diagnostics and arbitrary CAD-to-fluid-domain preparation are still outstanding. The default solve takes roughly two minutes on the development Mac with the two-CPU Docker limit; hardware and load affect runtime.

## Execution and durability

The web UI never launches processes. It and the agent tools (`list_simulations`, `validate_simulation`, `save_simulation`, `run_simulation`) use the same authenticated case/job API. Concurrent case edits use revision checks. Each job stores a complete immutable recipe and pinned image reference; solve jobs link the exact mesh asset. Edits never mutate earlier jobs. Retries reuse a request key.

The local executor translates the reserved `beam:openfoam` manifest into a detached supervised worker. Its container has only the job directory mounted, no network, 2 CPUs, 2 GB RAM and a 256-process limit. Explicit inputs are checksum verified; explicit outputs are uploaded to the existing authenticated chat storage. Closing the pane or ending an agent turn does not cancel a job. Connector reconnection resumes reporting from receipts without resubmission. Cancel and timeout remove the associated Docker container. A lost supervisor is treated as an uncertain failed execution, never silently replayed; inspect the machine if Docker was unavailable during cleanup.

Cases and artifacts are backend resources; runner handles and filesystem paths are execution details. A future remote executor can stage those inputs, submit to a durable server or scheduler, return a scheduler handle and implement inspect/cancel/readOutput. That remote backend is not implemented yet. The case schema contains versioned channel, cylinder and composable planar flow definitions; imported 3D CAD preparation remains separate work.

## Verification

```sh
pnpm test:backend
pnpm --filter @beam/runner test
BEAM_TEST_OPENFOAM=1 pnpm --filter @beam/runner exec vitest run src/compute/openfoam.test.ts
pnpm --filter @beam/web build
```

The opt-in test uses the real pinned runtime through the detached executor. It verifies mesh generation, checks, immutable mesh transfer, convergence, finite and bounded temperature fields, a near-parabolic developed velocity profile, a downloadable case archive, and a transient cylinder solve whose downstream cross-flow alternates sign across saved times. It also checks playback addressing, finite binary values and cancellation. It does not install Docker or download an image.

## Prescribed pitching motion

Planar studies can now prescribe the rotation of one body. In **Setup → Motion**, choose the body, pivot (metres), mean rotation, amplitude (degrees) and frequency (Hz). Agents set the same optional `motion` object:

```json
{"kind":"pitch","body":"foil","pivot":[0,0],"meanAngleDegrees":5,"amplitudeDegrees":10,"frequencyHz":1}
```

The rotation relative to the supplied geometry is `mean + amplitude * sin(2π * frequency * t)`. An already tilted polygon retains its original tilt, so do not also supply that angle as the mean rotation. Positive angles rotate counterclockwise about +z. The starting mesh includes the mean rotation; time-dependent motion is relative to that reference.

Mesh and Run use the normal durable job system. OpenFOAM's `dynamicMotionSolverFvMesh` with `displacementLaplacian` deforms the fluid mesh around a `solidBodyMotionDisplacement` patch; `movingWallVelocity` supplies the physical wall velocity. A stationary polygon moved only in the viewer is not used. Mesh topology stays fixed. The runner checks every saved mesh using `checkMesh`, rejects inverted or collapsed saved cells, and exports solver-written vertex positions in `geometry.bin`. Results interpolate both fields and mesh coordinates between the same saved times. Setup and Mesh show the starting pose; the body moves in computed Results. Run comparison weights cells using their moving areas at the common time.

Current limits: one pitching body, amplitude >0 and ≤20°, at least 16 saved frames per cycle and at most 100 saved frames. Its wall patch must be exclusive. A conservative full rotation envelope must clear the outer domain and other bodies by at least one background cell. This clearance check does not guarantee mesh quality; reduce amplitude or improve the initial mesh if the moving-mesh checks fail. Mesh refinement deforms with the initial mesh; it is not dynamic adaptive refinement. Motion changes require a new mesh. Translation, continuous rotation, multiple independently moving bodies, free six-degree-of-freedom dynamics, structural deformation, 3D and overset meshes are not implemented.

Try: “Create a separate pitching-foil study with a 20 mm chord in a spacious 2D domain, U = 0.1 m/s, density = 1000 kg/m³ and kinematic viscosity = 1e-5 m²/s. Pitch about its quarter-chord point with mean rotation 5°, amplitude 5° and frequency 1 Hz. Use 60 saved frames over 3 seconds. Validate, mesh, inspect quality, then solve and show the moving results. State assumptions and keep my existing study unchanged.”
