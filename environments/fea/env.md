# fea environment

Structures and heat in solids. Read this before writing a setup.

## Installed

FEniCSx (dolfinx 0.11, basix, ufl), PETSc 3.25 with MUMPS, MPICH 5, gmsh 4.15, meshio, pyvista 0.49 on VTK 9.7 (off-screen), numpy, scipy, matplotlib. Exact versions: `/beam/packages.json`.

Python is `/opt/conda/bin/python`. Run in parallel with `mpirun -n <cores> python script.py`; `nproc` reports the cores this machine has.

## Writing results

Import `from beam_out import out, gci`. Record numbers with units (`out.quantity`), checks (`out.check`), plots (`out.series`), tables (`out.table`) and 3D fields on tetrahedral meshes (`out.field`), then call `out.write()`. Only MPI rank 0 writes. Results go to `beam/out/` under the working directory; Beam reads `beam/out/manifest.json`.

Every number needs a unit. Every result an engineer might trust needs a check that says why, or says it was not evaluated.

## Worked example

`/beam/benchmarks/cantilever.py`: a clamped steel beam under a tip load, solved on three meshes, compared with Timoshenko beam theory, with a grid convergence index. It shows meshing a box, a clamped boundary, a traction on a tagged face, a direct and an iterative solver, point probes, and writing every kind of result.

    mpirun -n 4 python /beam/benchmarks/cantilever.py

## Gotchas

- Use quadratic (P2) elements for stress. Linear tetrahedra lock in bending and under-report deflection and stress.
- Stress at a re-entrant corner or at a clamped edge does not converge with refinement; it is a singularity. Report stress away from it, or say that the peak is mesh-dependent.
- `LinearProblem` needs `petsc_options_prefix`, and each problem in one process needs a different prefix.
- MUMPS (`pc_type: lu`) is robust up to a few hundred thousand unknowns. Beyond that use `ksp_type: cg` with `pc_type: gamg` and set the rigid-body near-null space, as the example does.
- In parallel, evaluate a point on every rank over the cells it owns. A point on an element face touches several cells; average them, or a discontinuous field gives a different value for each partition.
- MPI uses MPICH's `ofi` transport (`MPIR_CVAR_CH4_NETMOD=ofi`). The default UCX transport prints `UCX ERROR scandir(/sys/class/net)` inside Modal's sandbox; the message is harmless, but it reads like a failure.
- The image sets `OMP_NUM_THREADS=1` and `OPENBLAS_NUM_THREADS=1`: parallelism comes from MPI processes. Raising them while running several MPI processes oversubscribes the cores and can make a solve many times slower.
