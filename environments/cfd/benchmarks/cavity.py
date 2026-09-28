"""Lid-driven cavity benchmark: centreline velocity against Ghia, Ghia & Shin (1982) at Re 100.

A unit square cavity whose lid moves at 1 m/s, nu = 0.01 m^2/s, solved to steady state with simpleFoam
(laminar, incompressible, SIMPLEC) on three meshes refined by 2. The finest mesh's u-velocity along
the vertical centreline is compared with the published table; the minimum velocity gets a grid
convergence index. Serial.

    python /beam/benchmarks/cavity.py            # meshes 20, 40, 80
    python /beam/benchmarks/cavity.py --n 40,80,160
"""
from __future__ import annotations

import argparse
import re
import subprocess
import time
from pathlib import Path

import numpy as np

from beam_out import gci, out

# Ghia, Ghia & Shin (1982), J. Comput. Phys. 48:387, Table I, Re = 100: u along x = 0.5.
GHIA_Y = [0.9766, 0.9688, 0.9609, 0.9531, 0.8516, 0.7344, 0.6172, 0.5000, 0.4531, 0.2813, 0.1719, 0.1016, 0.0703, 0.0625, 0.0547]
GHIA_U = [0.84123, 0.78871, 0.73722, 0.68717, 0.23151, 0.00332, -0.13641, -0.20581, -0.21090, -0.15662, -0.10150, -0.06434, -0.04775, -0.04192, -0.03717]
NU, LID, MAX_ITERATIONS = 0.01, 1.0, 20000
RESIDUALS = {"p": 1e-7, "U": 1e-9}

HEADER = "FoamFile {{ version 2.0; format ascii; class {cls}; object {obj}; }}\n"


def case_files(n: int) -> dict[str, str]:
    dt = 0.25 / n / LID  # Courant 0.25 at the lid speed
    return {
        "system/blockMeshDict": HEADER.format(cls="dictionary", obj="blockMeshDict") + f"""scale 1;
vertices ((0 0 0) (1 0 0) (1 1 0) (0 1 0) (0 0 0.1) (1 0 0.1) (1 1 0.1) (0 1 0.1));
blocks (hex (0 1 2 3 4 5 6 7) ({n} {n} 1) simpleGrading (1 1 1));
edges ();
boundary (
  movingWall {{ type wall; faces ((3 7 6 2)); }}
  fixedWalls {{ type wall; faces ((0 4 7 3) (2 6 5 1) (1 5 4 0)); }}
  frontAndBack {{ type empty; faces ((0 3 2 1) (4 5 6 7)); }}
);""",
        "system/controlDict": HEADER.format(cls="dictionary", obj="controlDict") + f"""application simpleFoam; startFrom startTime; startTime 0; stopAt endTime; endTime {MAX_ITERATIONS};
deltaT 1; writeControl timeStep; writeInterval {MAX_ITERATIONS}; purgeWrite 0; writeFormat ascii; writePrecision 12;
writeCompression off; timeFormat general; timePrecision 6; runTimeModifiable false;""",
        "system/fvSchemes": HEADER.format(cls="dictionary", obj="fvSchemes") + """ddtSchemes { default steadyState; } gradSchemes { default Gauss linear; }
divSchemes { default none; div(phi,U) bounded Gauss linear; div((nuEff*dev2(T(grad(U))))) Gauss linear; }
laplacianSchemes { default Gauss linear orthogonal; } interpolationSchemes { default linear; } snGradSchemes { default orthogonal; }""",
        "system/fvSolution": HEADER.format(cls="dictionary", obj="fvSolution") + f"""solvers {{
  p {{ solver GAMG; smoother GaussSeidel; tolerance 1e-12; relTol 0.01; }}
  U {{ solver smoothSolver; smoother symGaussSeidel; tolerance 1e-12; relTol 0.1; }}
}}
SIMPLE {{ nNonOrthogonalCorrectors 0; consistent yes; pRefCell 0; pRefValue 0; residualControl {{ p {RESIDUALS["p"]}; U {RESIDUALS["U"]}; }} }}
relaxationFactors {{ equations {{ U 0.9; ".*" 0.9; }} }}""",
        "constant/transportProperties": HEADER.format(cls="dictionary", obj="transportProperties") + f"transportModel Newtonian; nu {NU};",
        "constant/turbulenceProperties": HEADER.format(cls="dictionary", obj="turbulenceProperties") + "simulationType laminar;",
        "0/U": HEADER.format(cls="volVectorField", obj="U") + f"""dimensions [0 1 -1 0 0 0 0]; internalField uniform (0 0 0);
boundaryField {{ movingWall {{ type fixedValue; value uniform ({LID} 0 0); }} fixedWalls {{ type noSlip; }} frontAndBack {{ type empty; }} }}""",
        "0/p": HEADER.format(cls="volScalarField", obj="p") + """dimensions [0 2 -2 0 0 0 0]; internalField uniform 0;
boundaryField { movingWall { type zeroGradient; } fixedWalls { type zeroGradient; } frontAndBack { type empty; } }""",
    }


def foam(case: Path, *args: str) -> str:
    p = subprocess.run(["bash", "-lc", "source /usr/lib/openfoam/openfoam2512/etc/bashrc && " + " ".join(args)], cwd=case, capture_output=True, text=True)
    (case / f"log.{args[0]}").write_text(p.stdout + p.stderr)
    if p.returncode != 0:
        raise RuntimeError(f"{args[0]} failed:\n{(p.stdout + p.stderr)[-2000:]}")
    return p.stdout


def vectors(path: Path) -> np.ndarray:
    text = path.read_text()
    m = re.search(r"internalField\s+nonuniform\s+List<vector>\s+(\d+)\s*\((.*?)\)\s*;", text, re.S)
    if not m:
        raise RuntimeError(f"no nonuniform vector field in {path}")
    values = np.array(re.findall(r"\(([^()]+)\)", m.group(2)), dtype=object)
    arr = np.array([[float(x) for x in v.split()] for v in values])
    if len(arr) != int(m.group(1)) or not np.all(np.isfinite(arr)):
        raise RuntimeError(f"incomplete or non-finite field in {path}")
    return arr


def centreline(c: np.ndarray, u: np.ndarray, dx: float):
    """u along x = 0.5, a face between two cell columns: the mean of the two neighbours, bottom to top."""
    left, right = np.isclose(c[:, 0], 0.5 - dx / 2), np.isclose(c[:, 0], 0.5 + dx / 2)
    ol, orr = np.argsort(c[left, 1]), np.argsort(c[right, 1])
    return c[left, 1][ol], (u[left, 0][ol] + u[right, 0][orr]) / 2


def solve(n: int) -> dict:
    case = Path(f"cavity-{n}")
    for rel, text in case_files(n).items():
        (case / rel).parent.mkdir(parents=True, exist_ok=True)
        (case / rel).write_text(text)
    t0 = time.perf_counter()
    foam(case, "blockMesh")
    log = foam(case, "simpleFoam")
    seconds = time.perf_counter() - t0
    converged = re.search(r"SIMPLE solution converged in (\d+) iterations", log)
    last = max((d for d in case.iterdir() if re.fullmatch(r"\d+", d.name) and d.name != "0"), key=lambda d: int(d.name))
    foam(case, "postProcess", "-func", "writeCellCentres", "-latestTime")
    c = vectors(last / "C")
    dx = 1.0 / n
    y, profile = centreline(c, vectors(last / "U"), dx)
    # Walls: no slip at the bottom, the lid at the top.
    yy, uu = np.concatenate([[0.0], y, [1.0]]), np.concatenate([[0.0], profile, [LID]])
    at_ghia = np.interp(GHIA_Y, yy, uu)
    i = int(np.argmin(profile))
    # Parabolic minimum through the three samples around the smallest.
    y0, y1, y2 = y[i - 1:i + 2]
    u0, u1, u2 = profile[i - 1:i + 2]
    denom = (u0 - 2 * u1 + u2)
    shift = 0.5 * (u0 - u2) / denom if denom else 0.0
    u_min = u1 - 0.25 * (u0 - u2) * shift
    continuity = [float(x) for x in re.findall(r"sum local = ([0-9.eE+-]+)", log)]
    return {
        "n": n, "cells": n * n, "seconds": seconds, "y": y, "profile": profile, "at_ghia": at_ghia,
        "deviation": float(np.max(np.abs(at_ghia - np.array(GHIA_U)))), "u_min": float(u_min), "y_min": float(y1 + shift * dx),
        "converged": bool(converged), "iterations": int(converged.group(1)) if converged else int(last.name), "continuity": max(continuity[-10:]) if continuity else float("nan"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", default="20,40,80", help="cells across the cavity for each mesh; ratio must be constant")
    sizes = [int(s) for s in ap.parse_args().n.split(",")]
    runs = []
    for n in sizes:
        r = solve(n)
        runs.append(r)
        print(f"{n:4d}x{n:<4d} · u_min {r['u_min']:+.5f} at y {r['y_min']:.4f} · max |u - Ghia| {r['deviation']:.4f} · "
              f"{'converged' if r['converged'] else 'NOT converged'} in {r['iterations']} iterations · {r['seconds']:.1f} s", flush=True)
    fine = runs[-1]

    umin = out.quantity("centreline_u_min", fine["u_min"], "m/s", label="minimum centreline u", headline=True,
                        reference={"value": -0.21090, "source": "Ghia, Ghia & Shin 1982, Re 100"})
    out.quantity("max_deviation_from_ghia", fine["deviation"], "m/s", label="largest difference from Ghia", headline=True)
    out.quantity("u_min_location", fine["y_min"], "m", label="height of minimum u", reference={"value": 0.4531, "source": "Ghia, Ghia & Shin 1982 (nearest tabulated point)"})
    out.quantity("cells", fine["cells"], "1", label="cells, finest mesh")
    out.quantity("solve_time", fine["seconds"], "s", label="solve time, finest mesh")

    out.check("ghia-agreement", "pass" if fine["deviation"] < 0.02 else "review", label="centreline u vs Ghia 1982",
              value=f"max |Δu| {fine['deviation']:.4f} m/s", criterion="< 0.02 m/s (2% of the lid speed)")
    out.check("solver-converged", "pass" if all(r["converged"] for r in runs) else "fail", label="steady solution converged", stage="solve",
              value=f"{fine['iterations']} iterations on the finest mesh", criterion=f"initial residuals p < {RESIDUALS['p']:g}, U < {RESIDUALS['U']:g}")
    out.check("continuity", "pass" if fine["continuity"] < 1e-6 else "review", label="continuity errors", stage="solve",
              value=f"sum local {fine['continuity']:.1e}", criterion="< 1e-6")
    if len(runs) >= 3:
        g = gci(runs[-1]["u_min"], runs[-2]["u_min"], runs[-3]["u_min"], runs[-1]["n"] / runs[-2]["n"])
        if g["gci"] is not None:
            umin["uncertainty"] = {"kind": "gci", "relative": g["gci"]}
            out.check("mesh-convergence", "pass" if g["gci"] < 0.02 else "review", label="mesh convergence, minimum u", stage="mesh",
                      value=f"GCI {g['gci']:.2%}, order {g['order']:.2f}", criterion="GCI < 2%")
        else:
            out.check("mesh-convergence", "review", label="mesh convergence, minimum u", stage="mesh", value=g["state"])
    else:
        out.check("mesh-convergence", "not-evaluated", label="mesh convergence, minimum u", stage="mesh", detail="One mesh: a timing run.")

    out.series("centreline_u", fine["y"], {f"OpenFOAM {fine['n']}x{fine['n']}": fine["profile"]},
               x_label="height y", x_unit="m", y_unit="m/s", label="u along the vertical centreline")
    out.series("ghia_1982", GHIA_Y, {"Ghia, Ghia & Shin 1982": GHIA_U}, x_label="height y", x_unit="m", y_unit="m/s", label="Ghia et al. 1982, Re 100")
    out.table("meshes", [{"name": "cells across"}, {"name": "cells"}, {"name": "u min", "unit": "m/s"}, {"name": "max |u - Ghia|", "unit": "m/s"}, {"name": "solve", "unit": "s"}],
              [[r["n"], r["cells"], r["u_min"], r["deviation"], r["seconds"]] for r in runs])
    out.view("Centreline", plot="centreline_u", table="meshes")
    path = out.write()
    print(f"u_min {fine['u_min']:+.5f} vs Ghia -0.21090 · max |u - Ghia| {fine['deviation']:.4f} · wrote {path}")


if __name__ == "__main__":
    main()
