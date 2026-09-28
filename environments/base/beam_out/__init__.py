"""Write Beam results: beam/out/manifest.json plus the files it names.

    from beam_out import out
    out.quantity("tip_deflection", 1.92e-4, "m", headline=True)
    out.check("mesh-convergence", "pass", value="GCI 0.4%", criterion="< 2%")
    out.series("tip_deflection_vs_mesh", x=[...], ys={"deflection": [...]}, x_label="cells", y_unit="m")
    out.field("solid", points, tetrahedra, {"von_mises": (values, "Pa")})
    out.write()

Only rank 0 of an MPI job writes. Every call validates its input, so a bad result fails the job
instead of reaching the viewer. The manifest only grows: new keys may be added, none renamed.
"""
from __future__ import annotations

import json
import math
import os
import platform
import time
from pathlib import Path

import numpy as np

MANIFEST_VERSION = 1
STATUSES = ("pass", "review", "fail", "not-evaluated")
STAGES = ("setup", "mesh", "solve", "post")
PREVIEW_TRIANGLES = 500_000
PREVIEW_STEPS = 120


def _rank() -> int:
    try:
        from mpi4py import MPI

        return MPI.COMM_WORLD.rank
    except Exception:
        return 0


def _finite(name: str, values) -> np.ndarray:
    a = np.asarray(values, dtype=np.float64)
    if not np.all(np.isfinite(a)):
        raise ValueError(f"{name} has non-finite values")
    return a


def _slug(name: str) -> str:
    if not name or not all(c.isalnum() or c in "-_." for c in name):
        raise ValueError(f"name {name!r} must be letters, digits, '-', '_' or '.'")
    return name


class Results:
    def __init__(self, root: str | os.PathLike | None = None):
        self.root = Path(root or os.environ.get("BEAM_OUT", "beam/out"))
        self.started = time.time()
        self.m: dict = {
            "version": MANIFEST_VERSION,
            "provenance": {},
            "quantities": [],
            "checks": [],
            "series": [],
            "fields": [],
            "tables": [],
            "files": [],
            "views": [],
        }

    # numbers ---------------------------------------------------------------------------------
    def quantity(self, name, value, unit, *, label=None, uncertainty=None, reference=None, headline=False):
        v = float(_finite(name, value))
        q = {"name": _slug(name), "label": label or name.replace("_", " "), "value": v, "unit": unit, "headline": bool(headline)}
        if uncertainty is not None:
            q["uncertainty"] = uncertainty  # {"kind": "gci" | "std" | "range", "relative"|"absolute": float}
        if reference is not None:
            q["reference"] = reference  # {"value": float, "source": str}
        self.m["quantities"].append(q)
        return q

    # checks ----------------------------------------------------------------------------------
    def check(self, id, status, *, label=None, value=None, criterion=None, stage="post", detail=None):
        if status not in STATUSES:
            raise ValueError(f"check status must be one of {STATUSES}")
        if stage not in STAGES:
            raise ValueError(f"check stage must be one of {STAGES}")
        c = {"id": _slug(id), "label": label or id.replace("-", " "), "status": status, "stage": stage}
        for k, v in (("value", value), ("criterion", criterion), ("detail", detail)):
            if v is not None:
                c[k] = str(v)
        self.m["checks"].append(c)
        return c

    # plots -----------------------------------------------------------------------------------
    def series(self, name, x, ys: dict, *, x_label, x_unit="", y_unit="", y_scale="linear", label=None):
        xs = _finite(f"{name}.x", x)
        lines = []
        for key, y in ys.items():
            ya = _finite(f"{name}.{key}", y)
            if ya.shape != xs.shape:
                raise ValueError(f"{name}.{key} has {ya.size} points, x has {xs.size}")
            lines.append({"name": key, "values": ya.tolist()})
        rel = f"series/{_slug(name)}.json"
        self._json(rel, {"x": xs.tolist(), "lines": lines})
        self.m["series"].append({
            "name": name, "label": label or name.replace("_", " "), "data": rel, "points": int(xs.size),
            "x": {"label": x_label, "unit": x_unit}, "y": {"unit": y_unit, "scale": y_scale, "lines": [l["name"] for l in lines]},
        })

    # tables ----------------------------------------------------------------------------------
    def table(self, name, columns: list[dict], rows: list[list], *, label=None):
        """columns: [{"name", "unit"}]; rows: lists of numbers or strings, one per column."""
        if any(len(r) != len(columns) for r in rows):
            raise ValueError(f"{name}: every row needs {len(columns)} cells")
        rel = f"tables/{_slug(name)}.json"
        self._json(rel, {"columns": columns, "rows": rows})
        self.m["tables"].append({"name": name, "label": label or name.replace("_", " "), "data": rel, "rows": len(rows)})

    # 3D --------------------------------------------------------------------------------------
    def field(self, name, points, tetrahedra, arrays: dict, *, label=None, steps=None):
        """A tetrahedral mesh with point arrays. arrays: {name: (values, unit)}; values are
        (n,) scalars or (n, 3) vectors, or (steps, n[, 3]) when steps is given.
        steps: {"kind": "time" | "load-step" | "frequency" | "mode" | "iteration", "values": [...], "unit": str}.
        Writes the full mesh as VTU and a bounded surface preview for the browser."""
        pts = _finite(f"{name}.points", points)
        tets = np.asarray(tetrahedra, dtype=np.int64)
        if pts.ndim != 2 or pts.shape[1] != 3 or tets.ndim != 2 or tets.shape[1] != 4:
            raise ValueError(f"{name}: points must be (n, 3) and tetrahedra (m, 4)")
        if tets.min() < 0 or tets.max() >= len(pts):
            raise ValueError(f"{name}: tetrahedra index outside points")
        nsteps = len(steps["values"]) if steps else None
        clean = {}
        for key, (vals, unit) in arrays.items():
            a = _finite(f"{name}.{key}", vals)
            per_point = a if nsteps is None else a[0]
            if per_point.shape[0] != len(pts):
                raise ValueError(f"{name}.{key}: {per_point.shape[0]} values for {len(pts)} points")
            clean[_slug(key)] = (a, unit)

        slug = _slug(name)
        full = f"fields/{slug}.vtu"
        self._vtu(full, pts, tets, {k: (a if nsteps is None else a[-1]) for k, (a, _) in clean.items()})

        faces = np.sort(np.concatenate([tets[:, [0, 1, 2]], tets[:, [0, 1, 3]], tets[:, [0, 2, 3]], tets[:, [1, 2, 3]]]), axis=1)
        uniq, counts = np.unique(faces, axis=0, return_counts=True)
        surface = uniq[counts == 1]
        if len(surface) > PREVIEW_TRIANGLES:
            raise ValueError(f"{name}: surface has {len(surface)} triangles; decimation is not implemented in this version")
        used, inverse = np.unique(surface, return_inverse=True)
        prefix = f"preview/{slug}"
        self._bin(f"{prefix}.positions.f32", pts[used].astype("<f4"))
        self._bin(f"{prefix}.indices.u32", inverse.reshape(-1, 3).astype("<u4"))
        meta_arrays = []
        for key, (a, unit) in clean.items():
            sub = a[..., used, :] if a.ndim == (3 if nsteps else 2) else a[..., used]
            sub = sub[: PREVIEW_STEPS] if nsteps else sub
            comps = 3 if sub.ndim == (3 if nsteps else 2) else 1
            mag = np.linalg.norm(sub, axis=-1) if comps == 3 else sub
            self._bin(f"{prefix}.{key}.f32", sub.astype("<f4"))
            meta_arrays.append({"name": key, "unit": unit, "components": comps, "association": "point",
                                "range": [float(mag.min()), float(mag.max())], "data": f"{prefix}.{key}.f32"})
        preview = {"version": 1, "kind": "surface", "vertices": int(len(used)), "triangles": int(len(surface)),
                   "positions": f"{prefix}.positions.f32", "indices": f"{prefix}.indices.u32", "arrays": meta_arrays}
        if steps:
            preview["steps"] = {**steps, "saved": min(nsteps, PREVIEW_STEPS), "total": nsteps}
        self._json(f"{prefix}.json", preview)
        self.m["fields"].append({"name": name, "label": label or name.replace("_", " "), "full": full, "preview": f"{prefix}.json",
                                 "cells": int(len(tets)), "arrays": [{"name": k, "unit": u} for k, (_, u) in clean.items()]})

    # files and views -------------------------------------------------------------------------
    def file(self, path, *, label=None, kind="file"):
        """Publish a file (kind: "file", "geometry" or "image"). A file outside beam/out is copied to beam/out/files/."""
        import shutil

        if kind not in ("file", "geometry", "image"):
            raise ValueError('kind must be "file", "geometry" or "image"')
        p = Path(path).resolve()
        if not p.is_file():
            raise FileNotFoundError(path)
        root = self.root.resolve()
        if root not in p.parents:
            dest = self._path(f"files/{_slug(p.name)}")
            if _rank() == 0:
                shutil.copyfile(p, dest)
            p = dest.resolve()
        self.m["files"].append({"path": p.relative_to(root).as_posix(), "label": label or p.name, "kind": kind, "bytes": p.stat().st_size})

    def view(self, name, **layout):
        """A named arrangement, e.g. view("Stress", field="solid", color="von_mises", plot="residuals")."""
        self.m["views"].append({"name": name, **layout})

    # write -----------------------------------------------------------------------------------
    def write(self):
        if _rank() != 0:
            return None
        self.m["provenance"] = {
            "environment": os.environ.get("BEAM_ENVIRONMENT", "unknown"),
            "image": os.environ.get("BEAM_IMAGE", "unknown"),
            "arch": platform.machine(),
            "cpus": os.cpu_count(),
            "command": os.environ.get("BEAM_COMMAND"),
            "wallSeconds": round(time.time() - self.started, 3),
            "writtenAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        path = self.root / "manifest.json"
        self._json("manifest.json", self.m)
        return path

    # helpers ---------------------------------------------------------------------------------
    def _path(self, rel: str) -> Path:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def _json(self, rel, data):
        if _rank() != 0:
            return
        p = self._path(rel)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(data, allow_nan=False))
        tmp.replace(p)

    def _bin(self, rel, array: np.ndarray):
        if _rank() == 0:
            self._path(rel).write_bytes(np.ascontiguousarray(array).tobytes())

    def _vtu(self, rel, pts, tets, arrays):
        if _rank() != 0:
            return
        import meshio

        meshio.write(str(self._path(rel)), meshio.Mesh(pts, [("tetra", tets)], point_data=arrays))


def gci(fine: float, medium: float, coarse: float, ratio: float) -> dict:
    """Three-mesh grid convergence index for a constant refinement ratio (Celik et al. 2008)."""
    e21, e32 = medium - fine, coarse - medium
    if e21 == 0 or e32 == 0 or e21 * e32 < 0:
        return {"state": "oscillates" if e21 * e32 < 0 else "converged", "order": None, "gci": None, "extrapolated": None}
    p = math.log(abs(e32 / e21)) / math.log(ratio)
    extrapolated = fine + (fine - medium) / (ratio**p - 1)
    return {"state": "monotonic", "order": p, "gci": 1.25 * abs(e21 / fine) / (ratio**p - 1), "extrapolated": extrapolated}


out = Results()
