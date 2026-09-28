"""Cantilever benchmark: tip deflection and mid-span bending stress against beam theory.

A steel beam 1 m x 0.1 m x 0.1 m is clamped at x = 0 and carries a 1 kN downward load spread
over its tip face. It is solved with quadratic tetrahedra on meshes refined by a constant ratio,
and the finest mesh is compared with Timoshenko beam theory. Three meshes give a grid
convergence index; one mesh is a timing run.

    mpirun -n 4 python /beam/benchmarks/cantilever.py                 # three meshes, direct solver
    mpirun -n 32 python /beam/benchmarks/cantilever.py --nx 160 --solver cg   # one large mesh
"""
from __future__ import annotations

import argparse
import time

import numpy as np
import ufl
from dolfinx import default_scalar_type, fem, geometry, mesh
from dolfinx.fem.petsc import LinearProblem
from mpi4py import MPI

from beam_out import gci, out

L, W, H = 1.0, 0.1, 0.1          # m
E, NU, F = 210e9, 0.3, 1000.0    # Pa, -, N
I = W * H**3 / 12
G = E / (2 * (1 + NU))
KAPPA = 10 * (1 + NU) / (12 + 11 * NU)  # Cowper's shear coefficient for a rectangle
TIP_THEORY = F * L**3 / (3 * E * I) + F * L / (KAPPA * G * W * H)
SIGMA_THEORY = F * (L / 2) * (H / 2) / I  # bending stress at the top fibre, mid-span
comm = MPI.COMM_WORLD


def log(*a):
    if comm.rank == 0:
        print(*a, flush=True)


def interpolation_points(space):
    p = space.element.interpolation_points
    return p() if callable(p) else p


def probe(domain, f, point):
    """Mean of f at point over every owned cell that contains it, so a point on an element face
    gives the same value however the mesh is partitioned."""
    p = np.array([point], dtype=np.float64)
    tree = geometry.bb_tree(domain, domain.topology.dim)
    cells = geometry.compute_colliding_cells(domain, geometry.compute_collisions_points(tree, p), p)
    owned = [c for c in cells.links(0) if c < domain.topology.index_map(domain.topology.dim).size_local]
    total = sum(float(f.eval(p, np.array([c], dtype=np.int32))[0]) for c in owned)
    total, count = comm.allreduce(total, op=MPI.SUM), comm.allreduce(len(owned), op=MPI.SUM)
    return total / count


def near_nullspace(V):
    """Rigid-body modes for algebraic multigrid on elasticity. Returns None if this dolfinx lacks the API."""
    try:
        import dolfinx.la
        from dolfinx.la.petsc import create_vector_wrap
        from petsc4py import PETSc

        im, bs = V.dofmap.index_map, V.dofmap.index_map_bs
        vecs = [dolfinx.la.vector(im, bs=bs, dtype=default_scalar_type) for _ in range(6)]
        b = [v.array for v in vecs]
        dofs = [V.sub(i).dofmap.list.flatten() for i in range(3)]
        for i in range(3):
            b[i][dofs[i]] = 1.0
        x = V.tabulate_dof_coordinates()
        nodes = V.dofmap.list.flatten()
        x0, x1, x2 = x[nodes, 0], x[nodes, 1], x[nodes, 2]
        b[3][dofs[0]], b[3][dofs[1]] = -x1, x0
        b[4][dofs[0]], b[4][dofs[2]] = x2, -x0
        b[5][dofs[2]], b[5][dofs[1]] = x1, -x2
        dolfinx.la.orthonormalize(vecs)
        return PETSc.NullSpace().create(vectors=[create_vector_wrap(v) for v in vecs])
    except Exception as e:  # noqa: BLE001
        log(f"near null space unavailable ({type(e).__name__}: {e}); GAMG will converge more slowly")
        return None


def solve(nx: int, solver: str) -> dict:
    ny = nz = max(1, nx // 10)
    domain = mesh.create_box(comm, [np.array([0.0, 0.0, 0.0]), np.array([L, W, H])], [nx, ny, nz], mesh.CellType.tetrahedron)
    V = fem.functionspace(domain, ("Lagrange", 2, (3,)))
    fdim = domain.topology.dim - 1
    clamped = mesh.locate_entities_boundary(domain, fdim, lambda x: np.isclose(x[0], 0.0))
    tip = np.sort(mesh.locate_entities_boundary(domain, fdim, lambda x: np.isclose(x[0], L)))
    tags = mesh.meshtags(domain, fdim, tip, np.full(len(tip), 1, dtype=np.int32))
    bc = fem.dirichletbc(np.zeros(3, dtype=default_scalar_type), fem.locate_dofs_topological(V, fdim, clamped), V)

    mu, lam = E / (2 * (1 + NU)), E * NU / ((1 + NU) * (1 - 2 * NU))
    eps = lambda w: ufl.sym(ufl.grad(w))  # noqa: E731
    sigma = lambda w: 2 * mu * eps(w) + lam * ufl.tr(eps(w)) * ufl.Identity(3)  # noqa: E731
    u, v = ufl.TrialFunction(V), ufl.TestFunction(V)
    ds = ufl.Measure("ds", domain=domain, subdomain_data=tags)
    traction = fem.Constant(domain, default_scalar_type((0.0, 0.0, -F / (W * H))))
    a = ufl.inner(sigma(u), eps(v)) * ufl.dx
    rhs = ufl.dot(traction, v) * ds(1)

    if solver == "lu":
        opts = {"ksp_type": "preonly", "pc_type": "lu", "pc_factor_mat_solver_type": "mumps"}
    else:
        opts = {"ksp_type": "cg", "pc_type": "gamg", "ksp_rtol": 1e-10, "ksp_max_it": 2000}
    problem = LinearProblem(a, rhs, bcs=[bc], petsc_options=opts, petsc_options_prefix=f"cantilever_{nx}_")
    if solver == "cg":
        ns = near_nullspace(V)
        if ns is not None:
            problem.A.setNearNullSpace(ns)

    t0 = time.perf_counter()
    uh = problem.solve()
    uh = uh[0] if isinstance(uh, tuple) else uh
    seconds = comm.allreduce(time.perf_counter() - t0, op=MPI.MAX)
    ksp = getattr(problem, "solver", None) or getattr(problem, "ksp", None)
    reason = ksp.getConvergedReason() if ksp is not None else 1
    iterations = ksp.getIterationNumber() if ksp is not None else 0

    tip_uz = comm.allreduce(fem.assemble_scalar(fem.form(uh[2] * ds(1))), op=MPI.SUM) / (W * H)
    s = sigma(uh)
    dev = s - ufl.tr(s) / 3 * ufl.Identity(3)
    Q = fem.functionspace(domain, ("Discontinuous Lagrange", 1))
    sxx = fem.Function(Q)
    sxx.interpolate(fem.Expression(s[0, 0], interpolation_points(Q)))
    vm = fem.Function(Q)
    vm.interpolate(fem.Expression(ufl.sqrt(1.5 * ufl.inner(dev, dev)), interpolation_points(Q)))
    return {
        "nx": nx, "cells": domain.topology.index_map(3).size_global, "dofs": V.dofmap.index_map.size_global * 3,
        "tip": -tip_uz, "sigma": probe(domain, sxx, [L / 2, W / 2, H * (1 - 1e-9)]),
        "seconds": seconds, "reason": reason, "iterations": iterations,
        "domain": domain, "uh": uh, "vm": vm,
    }


def gather_surface_field(r: dict):
    """Displacement and von Mises on mesh vertices, gathered to rank 0 in global numbering."""
    domain = r["domain"]
    S = fem.functionspace(domain, ("Lagrange", 1))
    ip = interpolation_points(S)
    comps = []
    for expr in (r["uh"][0], r["uh"][1], r["uh"][2], r["vm"]):
        f = fem.Function(S)
        f.interpolate(fem.Expression(expr, ip) if not isinstance(expr, fem.Function) else expr)
        comps.append(f.x.array)
    im = S.dofmap.index_map
    n_owned = im.size_local
    glob = im.local_to_global(np.arange(im.size_local + im.num_ghosts, dtype=np.int32))
    owned_cells = S.dofmap.list[: domain.topology.index_map(3).size_local]
    parts = comm.gather((glob[:n_owned], S.tabulate_dof_coordinates()[:n_owned],
                         np.stack([c[:n_owned] for c in comps], axis=1), glob[owned_cells]), root=0)
    if comm.rank != 0:
        return None
    n = im.size_global
    points, values = np.zeros((n, 3)), np.zeros((n, 4))
    for ids, xyz, vals, _ in parts:
        points[ids], values[ids] = xyz, vals
    tets = np.concatenate([p[3] for p in parts])
    return points, tets, values[:, :3], values[:, 3]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nx", default="20,40,80", help="cells along the beam for each mesh; ratio must be constant")
    ap.add_argument("--solver", choices=["lu", "cg"], default="lu")
    args = ap.parse_args()
    sizes = [int(s) for s in args.nx.split(",")]
    log(f"cantilever · {comm.size} MPI processes · meshes {sizes} · solver {args.solver}")

    runs = []
    for nx in sizes:
        r = solve(nx, args.solver)
        runs.append(r)
        log(f"nx {nx:4d} · {r['cells']:>9,} cells · {r['dofs']:>10,} dofs · tip {r['tip']:.6e} m · "
            f"sigma {r['sigma']:.5e} Pa · {r['seconds']:.2f} s · iterations {r['iterations']}")

    fine = runs[-1]
    tip_err = (fine["tip"] - TIP_THEORY) / TIP_THEORY
    sig_err = (fine["sigma"] - SIGMA_THEORY) / SIGMA_THEORY

    tip_q = out.quantity("tip_deflection", fine["tip"], "m", label="tip deflection", headline=True,
                         reference={"value": TIP_THEORY, "source": "Timoshenko beam theory"})
    out.quantity("midspan_bending_stress", fine["sigma"], "Pa", label="mid-span bending stress", headline=True,
                 reference={"value": SIGMA_THEORY, "source": "Euler-Bernoulli, M c / I"})
    out.quantity("degrees_of_freedom", fine["dofs"], "1", label="degrees of freedom")
    out.quantity("solve_time", fine["seconds"], "s", label="solve time, finest mesh")

    out.check("solver-converged", "pass" if all(r["reason"] > 0 for r in runs) else "fail",
              value=f"{fine['iterations']} iterations" if args.solver == "cg" else "direct", stage="solve")
    out.check("tip-vs-theory", "pass" if abs(tip_err) < 0.02 else "review", label="tip deflection vs beam theory",
              value=f"{tip_err:+.2%}", criterion="within 2%",
              detail="Beam theory ignores the Poisson constraint at the clamp, so a small difference is expected.")
    out.check("stress-vs-theory", "pass" if abs(sig_err) < 0.03 else "review", label="mid-span stress vs beam theory",
              value=f"{sig_err:+.2%}", criterion="within 3%")
    if len(runs) >= 3:
        ratio = runs[-1]["nx"] / runs[-2]["nx"]
        g = gci(runs[-1]["tip"], runs[-2]["tip"], runs[-3]["tip"], ratio)
        if g["gci"] is not None:
            tip_q["uncertainty"] = {"kind": "gci", "relative": g["gci"]}
            out.check("mesh-convergence", "pass" if g["gci"] < 0.02 else "review", label="mesh convergence, tip",
                      value=f"GCI {g['gci']:.2%}, order {g['order']:.2f}", criterion="GCI < 2%", stage="mesh")
        else:
            out.check("mesh-convergence", "review", label="mesh convergence, tip", value=g["state"], stage="mesh")
    else:
        out.check("mesh-convergence", "not-evaluated", label="mesh convergence, tip", stage="mesh",
                  detail="One mesh: a timing run.")

    out.series("tip_vs_mesh", [r["cells"] for r in runs], {"tip deflection": [r["tip"] for r in runs]},
               x_label="cells", y_unit="m", label="tip deflection against mesh size")
    out.table("meshes", [{"name": "nx"}, {"name": "cells"}, {"name": "dofs"}, {"name": "tip", "unit": "m"},
                         {"name": "stress", "unit": "Pa"}, {"name": "solve", "unit": "s"}],
              [[r["nx"], r["cells"], r["dofs"], r["tip"], r["sigma"], r["seconds"]] for r in runs])

    t0 = time.perf_counter()
    gathered = gather_surface_field(fine)
    if gathered is not None:
        points, tets, disp, vm = gathered
        out.field("beam", points, tets, {"displacement": (disp, "m"), "von_mises": (vm, "Pa")})
        out.view("Deflection", field="beam", color="von_mises", warp="displacement", plot="tip_vs_mesh")
    log(f"results written in {time.perf_counter() - t0:.2f} s")
    path = out.write()
    if path:
        log(f"tip {fine['tip']:.6e} m vs theory {TIP_THEORY:.6e} m ({tip_err:+.2%}) · "
            f"stress {fine['sigma']:.5e} Pa vs {SIGMA_THEORY:.5e} Pa ({sig_err:+.2%}) · wrote {path}")


if __name__ == "__main__":
    main()
