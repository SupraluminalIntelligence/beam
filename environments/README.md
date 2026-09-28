# Environments

What gets installed on a machine: pinned OCI images of open-source tools, each with a guide and benchmarks.

| Environment | Tools | Benchmark |
| --- | --- | --- |
| `fea` | FEniCSx, PETSc/MUMPS, MPICH, gmsh, pyvista | Cantilever against Timoshenko beam theory |
| `cfd` | OpenFOAM 2512 (OpenCFD's image), pyvista | Lid-driven cavity at Re 100 against Ghia, Ghia & Shin (1982) |

Design: [compute plane](../docs/decisions/2026-09-27-compute-plane.md). First measurements: [spike/REPORT.md](spike/REPORT.md).

| Path | What |
| --- | --- |
| `base/environment.yml` | Packages every built-in environment shares (python, numpy, scipy, meshio, gmsh, pyvista/VTK) |
| `base/beam_out/` | Python helper that writes results: `beam/out/manifest.json` plus the files it names |
| `<env>/environment.yml` | The environment's own packages, solved together with the base |
| `<env>/lock/linux-{amd64,arm64}.txt` | Exact packages per architecture; the Dockerfile installs these |
| `<env>/env.md`, `env.json` | The guide an agent reads first, and the machine-readable description with benchmark commands |
| `<env>/benchmarks/` | Problems with known answers; CI fails if any of their checks does not pass |
| `tools/check_results.py` | Validates a results folder and exits non-zero on a failed check |
| `lock.sh` | Re-solves an environment and rewrites its lockfiles |

## Build and run locally

```sh
cd environments
docker buildx build --platform linux/arm64 --load -t beam-env-fea:dev -f fea/Dockerfile .
docker run --rm --shm-size=1g -v "$PWD/tools:/tools:ro" beam-env-fea:dev \
  bash -lc "mpirun -n 4 python /beam/benchmarks/cantilever.py && python /tools/check_results.py"
```

Change packages in `environment.yml`, run `./lock.sh <env>`, and commit both. Build for both `linux/arm64` (Macs) and `linux/amd64` (Modal, EC2); results agree to round-off.

## Publishing

`.github/workflows/environments.yml` builds each environment on native amd64 and arm64 runners, runs its benchmarks, and on `main` pushes `ghcr.io/supraluminalintelligence/beam-env-<env>:sha-<commit>` and `:latest`. Machines should reference images by digest.
