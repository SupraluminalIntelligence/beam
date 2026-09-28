"""Spike: run the fea environment on Modal and measure what the design depends on.

    uv run --with modal python environments/spike/modal_spike.py ghcr.io/supraluminalintelligence/beam-env-fea@sha256:...

Measures app start (includes Modal importing the image on first use), Sandbox creation, command
round trips, the cantilever benchmark in a 4-core Sandbox and a 32-core Function, and the largest
CPU request Modal accepts. Uses the Modal login in ~/.modal.toml. Writes JSON to stdout's last line.
"""
from __future__ import annotations

import json
import os
import statistics
import subprocess
import sys
import time

import modal

# Modal re-imports this module inside the container, where there are no arguments: keep a default.
IMAGE_REF = sys.argv[1] if len(sys.argv) > 1 and modal.is_local() else os.environ.get(
    "BEAM_SPIKE_IMAGE", "ghcr.io/supraluminalintelligence/beam-env-fea@sha256:52b46d54c99ce66680ced634a6fca2aa900d118b6089f2df0324184ed940ec0b")
image = modal.Image.from_registry(IMAGE_REF).entrypoint([])
app = modal.App("beam-spike")
report: dict = {"image": IMAGE_REF}


def log(msg):
    print(msg, flush=True)


@app.function(image=image, cpu=32.0, memory=65536, timeout=3600)
def run_job(command: str) -> dict:
    """A batch job: run a command in /work and return its output, timing and manifest."""
    import os
    import pathlib

    os.chdir("/work")
    t0 = time.perf_counter()
    p = subprocess.run(["bash", "-lc", command], capture_output=True, text=True)
    elapsed = time.perf_counter() - t0
    manifest = pathlib.Path("/work/beam/out/manifest.json")
    return {
        "seconds": round(elapsed, 2), "returncode": p.returncode, "nproc": os.cpu_count(),
        "stdout": p.stdout[-4000:], "stderr": p.stderr[-4000:],
        "manifest": json.loads(manifest.read_text()) if manifest.exists() else None,
    }


def sandbox_exec(sb, command: str):
    t0 = time.perf_counter()
    p = sb.exec("bash", "-lc", command)
    p.wait()
    return time.perf_counter() - t0, p.returncode, p.stdout.read(), p.stderr.read()


def summary(manifest):
    if not manifest:
        return None
    return {
        "quantities": {q["name"]: q["value"] for q in manifest["quantities"]},
        "checks": {c["id"]: [c["status"], c.get("value")] for c in manifest["checks"]},
        "provenance": manifest["provenance"],
    }


def main():
    t0 = time.perf_counter()
    with app.run():
        report["app_start_s"] = round(time.perf_counter() - t0, 2)
        log(f"app started in {report['app_start_s']} s (includes importing the image the first time)")

        # 1. Sandbox: creation, first command, round trips, benchmark.
        t = time.perf_counter()
        sb = modal.Sandbox.create(app=app, image=image, cpu=4.0, memory=16384, timeout=1800, workdir="/work")
        report["sandbox_create_s"] = round(time.perf_counter() - t, 2)
        first, rc, out, _ = sandbox_exec(sb, "nproc; python -c 'import dolfinx; print(dolfinx.__version__)'; uname -m")
        report["sandbox_first_exec_s"] = round(first, 2)
        report["sandbox_info"] = out.split()
        trips = [sandbox_exec(sb, "true")[0] for _ in range(15)]
        report["exec_round_trip_ms"] = {"median": round(statistics.median(trips) * 1000), "max": round(max(trips) * 1000)}
        log(f"sandbox created in {report['sandbox_create_s']} s · first exec {report['sandbox_first_exec_s']} s · "
            f"round trip median {report['exec_round_trip_ms']['median']} ms · nproc/dolfinx/arch {report['sandbox_info']}")

        pingpong = (
            "import time, numpy as np\nfrom mpi4py import MPI\nc = MPI.COMM_WORLD\n"
            "for size, reps in ((8, 2000), (8388608, 40)):\n"
            "    b = np.zeros(size, dtype=np.uint8); c.Barrier(); t = time.perf_counter()\n"
            "    for _ in range(reps):\n"
            "        if c.rank == 0: c.Send(b, 1); c.Recv(b, 1)\n"
            "        elif c.rank == 1: c.Recv(b, 0); c.Send(b, 0)\n"
            "    dt = (time.perf_counter() - t) / reps / 2\n"
            "    c.rank or print(f'{size}B {dt*1e6:.1f}us {size/dt/1e9:.2f}GB/s')\n")
        sandbox_exec(sb, f"cat > /tmp/pp.py <<'PY'\n{pingpong}PY")
        transports = {}
        for label, envs in (("default", ""), ("ucx shared memory", "UCX_TLS=sm,self"), ("ofi", "MPIR_CVAR_CH4_NETMOD=ofi")):
            _, rc, out, err = sandbox_exec(sb, f"env {envs} mpirun -n 2 python /tmp/pp.py")
            transports[label] = {"out": out.strip().splitlines(), "ucx_error": "UCX  ERROR" in (out + err) or "UCX ERROR" in (out + err), "rc": rc}
            log(f"transport {label}: {transports[label]}")
        report["transports"] = transports

        secs, rc, out, err = sandbox_exec(sb, "BEAM_IMAGE=" + IMAGE_REF + " mpirun -n 4 python /beam/benchmarks/cantilever.py")
        m = sandbox_exec(sb, "cat beam/out/manifest.json")[2]
        report["sandbox_benchmark"] = {"seconds": round(secs, 2), "returncode": rc, "stdout": out[-2500:], "stderr": err[-1500:],
                                       "result": summary(json.loads(m)) if m.strip() else None}
        log(f"sandbox benchmark (4 MPI ranks, 3 meshes): {secs:.1f} s, exit {rc}")
        sb.terminate()

        t = time.perf_counter()
        sb2 = modal.Sandbox.create(app=app, image=image, cpu=4.0, memory=16384, timeout=300)
        sandbox_exec(sb2, "true")
        report["sandbox_second_create_and_exec_s"] = round(time.perf_counter() - t, 2)
        sb2.terminate()
        log(f"second sandbox, image cached: {report['sandbox_second_create_and_exec_s']} s to first command")

        # 2. Function: same benchmark for architecture comparison, then one large mesh on 32 cores.
        t = time.perf_counter()
        small = run_job.remote("BEAM_IMAGE=" + IMAGE_REF + " mpirun -n 4 python /beam/benchmarks/cantilever.py")
        report["function_small"] = {**{k: small[k] for k in ("seconds", "returncode", "nproc")},
                                    "wall_s": round(time.perf_counter() - t, 2), "result": summary(small["manifest"]),
                                    "stderr": small["stderr"][-1500:]}
        log(f"function, small: {small['seconds']} s inside, {report['function_small']['wall_s']} s wall, exit {small['returncode']}")
        for ranks in (1, 32):
            t = time.perf_counter()
            big = run_job.remote(f"BEAM_IMAGE={IMAGE_REF} mpirun -n {ranks} python /beam/benchmarks/cantilever.py --nx 120 --solver cg")
            report[f"function_large_{ranks}"] = {**{k: big[k] for k in ("seconds", "returncode", "nproc")},
                                                 "wall_s": round(time.perf_counter() - t, 2), "result": summary(big["manifest"]),
                                                 "stdout": big["stdout"][-1500:], "stderr": big["stderr"][-1500:]}
            log(f"function, large mesh, {ranks} ranks: {big['seconds']} s inside, exit {big['returncode']}")

        # 3. The largest CPU request Modal accepts, and what the container then sees.
        ceiling = {}
        for cpus in (32, 48, 64, 96, 128, 192):
            try:
                sb = modal.Sandbox.create(app=app, image=image, cpu=float(cpus), memory=cpus * 1024, timeout=120)
                ceiling[cpus] = {"ok": True, "nproc": sandbox_exec(sb, "nproc")[2].strip()}
                sb.terminate()
            except Exception as e:  # noqa: BLE001
                ceiling[cpus] = {"ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}"}
            log(f"cpu={cpus}: {ceiling[cpus]}")
        report["cpu_ceiling"] = ceiling

    print("REPORT " + json.dumps(report))


if __name__ == "__main__":
    main()
