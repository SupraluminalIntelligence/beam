"""Spike: strong scaling of the cantilever on one 64-core Modal Function (about 2M unknowns).

    uv run --with modal python environments/spike/modal_scaling.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time

import modal

IMAGE_REF = sys.argv[1] if len(sys.argv) > 1 and modal.is_local() else os.environ.get(
    "BEAM_SPIKE_IMAGE", "ghcr.io/supraluminalintelligence/beam-env-fea@sha256:52b46d54c99ce66680ced634a6fca2aa900d118b6089f2df0324184ed940ec0b")
app = modal.App("beam-spike-scaling")
image = modal.Image.from_registry(IMAGE_REF).entrypoint([])


@app.function(image=image, cpu=64.0, memory=131072, timeout=5400)
def scale(ranks: list[int], nx: int) -> list[dict]:
    rows = []
    for n in ranks:
        t0 = time.perf_counter()
        p = subprocess.run(["bash", "-lc", f"cd /work && rm -rf beam && MPIR_CVAR_CH4_NETMOD=ofi mpirun -n {n} python /beam/benchmarks/cantilever.py --nx {nx} --solver cg"],
                           capture_output=True, text=True)
        line = next((l for l in p.stdout.splitlines() if l.startswith("nx")), p.stderr[-300:])
        rows.append({"ranks": n, "wall_s": round(time.perf_counter() - t0, 1), "line": line, "rc": p.returncode, "nproc": os.cpu_count()})
        print(rows[-1], flush=True)
    return rows


if __name__ == "__main__":
    with app.run():
        print("RESULT " + json.dumps(scale.remote([8, 16, 32, 64], 200)))
