# Spike: one environment image, local Docker and Modal

27 Sep 2026. Question: can one image run the same physics locally and on Modal, fast enough for an agent's working loop, and where does Modal stop being the right machine? Design: [compute plane](../../docs/decisions/2026-09-27-compute-plane.md).

**Answer: yes, with one boundary.** The `fea` image gives identical results on an M3 Pro and on Modal's x86, starts in about 2 s on Modal once cached, and turns a command around in under 0.4 s. Modal accepts at most 64 cores, and MPI solves on Modal stop getting faster beyond about 8 processes. Large CPU solves belong on whole-node machines (EC2), as the design already assumed.

## What was built

- `environments/fea`: FEniCSx 0.11, PETSc 3.25 with MUMPS, MPICH 5, gmsh 4.15, pyvista 0.49 / VTK 9.7, on micromamba over Ubuntu 24.04. One solve of `base/environment.yml` + `fea/environment.yml`, frozen per architecture in `fea/lock/` (`./lock.sh fea` regenerates). 4.5 GB. Builds in 65–100 s on an M3 Pro; amd64 under emulation 137 s.
- `environments/base/beam_out`: writes `beam/out/manifest.json` with numbers (units, references, uncertainty), checks, plots, tables and 3D fields (full VTU plus a surface preview as Float32/Uint32 buffers), rank 0 only.
- `environments/fea/benchmarks/cantilever.py`: a clamped steel beam under a 1 kN tip load, three meshes, compared with Timoshenko beam theory, with a grid convergence index.
- Published multi-arch and public: `ghcr.io/supraluminalintelligence/beam-env-fea@sha256:52b46d54c99ce66680ced634a6fca2aa900d118b6089f2df0324184ed940ec0b`. The spike ran from an identical copy under `ghcr.io/apekshik/` while the org still disallowed public packages.

## Results

The benchmark passes everywhere: tip deflection −0.71% from beam theory (the clamp is stiffer than the theory's assumption), mid-span stress +0.05%, GCI 0.04% at observed order 1.8–2.1.

| | Local Docker, M3 Pro (arm64) | Modal (x86) |
| --- | --- | --- |
| First start | 1 s | 101 s once, while Modal imports the image; 1.6 s after |
| New sandbox to first command | 1 s | 3.6 s first, **1.7 s** cached |
| Command round trip | 150–300 ms (`docker exec`) | **174–350 ms** (`Sandbox.exec` from this Mac) |
| Benchmark, 4 processes, 3 meshes | 9–31 s (Mac under load) | 7.4–8.9 s in a 4-core Sandbox; 34 s in a Function |
| MPI latency / bandwidth, 2 processes | 2–3 µs, 1.4–2.0 GB/s | 10–12 µs, 1.0–1.5 GB/s |
| Largest CPU request | 8 (Docker Desktop setting) | **64 cores**; 96+ rejected: "Must be between 0.125 and 64 cores" |

Architecture: arm64 and x86 agree to 1.6 × 10⁻¹⁰ relative on every quantity. Iterating on a Mac gives the engineering answer the cloud gives.

Strong scaling, CG with algebraic multigrid:

| Unknowns | Machine | 1 | 2 | 4 | 8 | 16 | 32 | 64 processes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 452k | M3 Pro, Docker | 37–40 s | 26 s | 15 s | 11 s | | | |
| 452k | Modal 32-core Function | 42 s | | | | | 22 s | |
| 2.0M | Modal 64-core Function | | | | **41.6 s** | 42.7 s | 52.1 s | 72.6 s |

On Modal, adding processes beyond 8 made the 2M-unknown solve slower. Likely causes: MPI through gVisor (four to five times the local latency), shared hosts, and memory bandwidth. Modal's per-core pricing makes this worse: 64 cores cost eight times what 8 do for a slower result.

## Problems found and fixed

1. **Thread oversubscription.** Each MPI process started its own OpenMP/BLAS threads: 4 processes took 37.5 s instead of 0.21 s. The image sets `OMP_NUM_THREADS=1` and `OPENBLAS_NUM_THREADS=1`.
2. **Renamed API in dolfinx 0.11.** `create_petsc_vector_wrap` is now `create_vector_wrap`; without the rigid-body near-null space, multigrid took 254 iterations instead of 55. The benchmark logs it if the API moves again.
3. **Probe on an element face.** A point on a face gave a different stress per partition (3.09 vs 3.01 MPa); the probe now averages the owned cells that contain it.
4. **UCX under gVisor.** MPICH's default UCX transport prints `UCX ERROR scandir(/sys/class/net)` on Modal. The image uses the `ofi` transport (`MPIR_CVAR_CH4_NETMOD=ofi`), which is also the fastest locally.
5. **h5py** resolved to a non-MPI build beside MPI HDF5; dropped (VTU output does not need it).
6. **Modal re-imports the job's module in the container**, so module-level `sys.argv` failed and the Function crash-looped. The gateway must not rely on module-level arguments.
7. **GitHub org policy** blocked public packages. It now allows them, and the org image is public.

## What it changes in the design

- **Modal machine sizes stop at 8–16 cores.** The 32-core Modal machine in the decision doc should become an 8-core (and at most 16-core) Modal machine; anything larger goes to whole-node EC2. Chat machines (4 cores) and GPUs stay on Modal.
- **Validate EC2 before promising 96-core machines.** This spike did not run on EC2; `hpc7a` scaling for this benchmark is the next measurement.
- **Cold image import is a real cost**: 101 s the first time Modal sees an image. Publishing a new environment should warm it on Modal before anyone waits on it.
- **Local runs are for correctness, not timing.** A Mac with mixed performance and efficiency cores, under other load, varied 4× between identical runs.
- **The results format works as designed**: 128 KB for this run, including a browser-ready 3D surface.

## Reproduce

```sh
cd environments
docker buildx build --platform linux/arm64 --load -t beam-env-fea:dev -f fea/Dockerfile .
spike/local_spike.sh beam-env-fea:dev linux/arm64 /tmp/beam-spike
cd .. && uv run --with modal python environments/spike/modal_spike.py     # needs `modal setup`
uv run --with modal python environments/spike/modal_scaling.py
```
