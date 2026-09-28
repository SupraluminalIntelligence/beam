# cfd environment

Fluid flow. Read this before writing a case.

## Installed

OpenFOAM 2512 from OpenCFD (openfoam.com, not the Foundation's openfoam.org): blockMesh, snappyHexMesh, checkMesh, icoFoam, simpleFoam, pimpleFoam, buoyant solvers, postProcess and function objects. Open MPI for parallel runs. A separate Python in `/opt/conda` with numpy, scipy, matplotlib, meshio, gmsh and pyvista/VTK. Exact Python versions: `/beam/packages.json`.

OpenFOAM's commands are on the PATH in login shells (`bash -l`), which is how machine_exec and jobs run. In a script that starts its own shell, run `source /usr/lib/openfoam/openfoam2512/etc/bashrc` first. Your working directory is `/work`; there is no network. `$BEAM_CORES` is the cores worth using: `decomposePar`, then `mpirun -n $BEAM_CORES <solver> -parallel`, then `reconstructPar`.

## Writing results

Import `from beam_out import out, gci` in Python after the solve. Parse what you need from the time directories (use `writeFormat ascii`) or function-object output, then record numbers with units (`out.quantity`), checks (`out.check`), plots (`out.series`) and tables (`out.table`), and call `out.write()`. Results go to `beam/out/`.

Every result needs checks: residuals or steady state, continuity errors, mesh sensitivity on at least three meshes (`gci`), and comparison with a correlation, a textbook value or a measurement where one exists. Say which assumptions (laminar, incompressible, isothermal, 2-D) were not checked.

## Worked example

`/beam/benchmarks/cavity.py`: a lid-driven cavity at Re 100 on three meshes, compared with Ghia, Ghia & Shin (1982), with a grid convergence index. It shows writing a case from Python, running blockMesh and icoFoam, reading fields with `postProcess -func writeCellCentres`, and writing every kind of result.

    python /beam/benchmarks/cavity.py

## Gotchas

- A 2-D case is one cell thick with `empty` front and back patches.
- Set `writeFormat ascii` in controlDict when Python will read the fields; binary fields need OpenFOAM's own tools.
- icoFoam and pimpleFoam are transient: check that the quantities you report stopped changing, not just that the run ended.
- Keep the Courant number below 1 for icoFoam: `deltaT` ≤ cell size / velocity.
- A point on a face between cells has two cell values; average the neighbours, as the example does at the centreline.
- `checkMesh` warnings on snapped meshes are common; read them, and report the ones that fail.
