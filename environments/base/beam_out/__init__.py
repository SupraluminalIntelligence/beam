"""Write Beam results: beam/out/manifest.json plus the files it names.

    from beam_out import out
    out.quantity("tip_deflection", 1.92e-4, "m", headline=True)
    out.check("mesh-convergence", "pass", value="GCI 0.4%", criterion="< 2%")
    out.series("tip_deflection_vs_mesh", x=[...], ys={"deflection": [...]}, x_label="cells", y_unit="m")
    out.series("theory", x=[...], ys={"Euler-Bernoulli": [...]}, x_label="cells", y_unit="m", overlay="tip_deflection_vs_mesh")
    out.field("solid", points, tetrahedra, {"von_mises": (values, "Pa")})
    out.openfoam("flow", "case")   # walls, a slice and streamlines from an OpenFOAM case
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
PREVIEW_SEGMENTS = 500_000
PREVIEW_PARTS = 16
PREVIEW_BYTES = 25 * 1024 * 1024
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


def _work(rel: str) -> Path:
    """beam/ lives at the job root ($BEAM_WORK, /work in Beam's containers), whatever the current directory."""
    return Path(os.environ.get("BEAM_WORK", ".")) / rel


class Results:
    def __init__(self, root: str | os.PathLike | None = None):
        self.root = Path(root or os.environ.get("BEAM_OUT") or _work("beam/out"))
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
    def series(self, name, x, ys: dict, *, x_label, x_unit="", y_unit="", y_scale="linear", label=None, overlay=None):
        """overlay: the name of a series already written with the same axes, to draw this one on its
        plot (a result over its reference data). Without it, the series is a plot of its own."""
        axes = {"x": {"label": x_label, "unit": x_unit}, "y_unit": y_unit, "y_scale": y_scale}
        if overlay is not None:
            base = next((s for s in self.m["series"] if s["name"] == overlay), None)
            if base is None or "overlay" in base:
                raise ValueError(f"{name}: overlay {overlay!r} must name a series already written that is not itself an overlay")
            if (base["x"], base["y"]["unit"], base["y"]["scale"]) != (axes["x"], y_unit, y_scale):
                raise ValueError(f"{name}: overlay {overlay!r} has different axes (x label and unit, y unit and scale)")
        xs = _finite(f"{name}.x", x)
        lines = []
        for key, y in ys.items():
            ya = _finite(f"{name}.{key}", y)
            if ya.shape != xs.shape:
                raise ValueError(f"{name}.{key} has {ya.size} points, x has {xs.size}")
            lines.append({"name": key, "values": ya.tolist()})
        rel = f"series/{_slug(name)}.json"
        self._json(rel, {"x": xs.tolist(), "lines": lines})
        s = {
            "name": name, "label": label or name.replace("_", " "), "data": rel, "points": int(xs.size),
            "x": axes["x"], "y": {"unit": y_unit, "scale": y_scale, "lines": [l["name"] for l in lines]},
        }
        if overlay is not None:
            s["overlay"] = overlay
        self.m["series"].append(s)

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

        # The boundary: faces that belong to one tetrahedron, each wound so its normal points away from
        # that tetrahedron's fourth vertex, i.e. out of the part.
        corners = tets[:, [[0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 3, 1], [1, 2, 3, 0]]].reshape(-1, 4)
        _, first, counts = np.unique(np.sort(corners[:, :3], axis=1), axis=0, return_index=True, return_counts=True)
        boundary = corners[first[counts == 1]]
        surface, opposite = boundary[:, :3].copy(), boundary[:, 3]
        a, b, c = pts[surface[:, 0]], pts[surface[:, 1]], pts[surface[:, 2]]
        inward = np.einsum("ij,ij->i", np.cross(b - a, c - a), pts[opposite] - a) > 0
        surface[inward] = surface[inward][:, [0, 2, 1]]
        if len(surface) > PREVIEW_TRIANGLES:
            raise ValueError(f"{name}: surface has {len(surface)} triangles; decimation is not implemented in this version")
        used, inverse = np.unique(surface, return_inverse=True)
        prefix = f"preview/{slug}"
        self._bin(f"{prefix}.positions.f32", pts[used].astype("<f4"))
        self._bin(f"{prefix}.indices.u32", inverse.reshape(-1, 3).astype("<u4"))
        # At most PREVIEW_STEPS frames, spread evenly over the run and always including its last.
        frames = np.unique(np.linspace(0, nsteps - 1, min(nsteps, PREVIEW_STEPS)).round().astype(int)) if nsteps else None
        meta_arrays = []
        for key, (a, unit) in clean.items():
            sub = a[..., used, :] if a.ndim == (3 if nsteps else 2) else a[..., used]
            sub = sub[frames] if nsteps else sub
            comps = 3 if sub.ndim == (3 if nsteps else 2) else 1
            mag = np.linalg.norm(sub, axis=-1) if comps == 3 else sub
            self._bin(f"{prefix}.{key}.f32", sub.astype("<f4"))
            meta_arrays.append({"name": key, "unit": unit, "components": comps, "association": "point",
                                "range": [float(mag.min()), float(mag.max())], "data": f"{prefix}.{key}.f32"})
        preview = {"version": 1, "kind": "surface", "vertices": int(len(used)), "triangles": int(len(surface)),
                   "positions": f"{prefix}.positions.f32", "indices": f"{prefix}.indices.u32", "arrays": meta_arrays}
        if steps:
            preview["steps"] = {**steps, "values": [float(steps["values"][i]) for i in frames], "saved": int(len(frames)), "total": nsteps}
        self._json(f"{prefix}.json", preview)
        self.m["fields"].append({"name": name, "label": label or name.replace("_", " "), "full": full, "preview": f"{prefix}.json",
                                 "cells": int(len(tets)), "arrays": [{"name": k, "unit": u} for k, (_, u) in clean.items()]})

    def scene(self, name, parts: dict, arrays: dict, *, label=None, cells=None, flat=None):
        """Surfaces and lines drawn together and coloured by the same arrays: a flow's walls, slices and
        streamlines. parts: {name: dataset} or {name: {"data": dataset, "label": str, "opacity": 0-1}},
        each a pyvista dataset of surfaces (any polygons or cells; their outer surface is drawn) or of
        lines. arrays: {array: unit}; every part must carry each array, as point or cell data.
        flat: cell values drawn flat, each triangle with vertices of its own (True), or interpolated to
        shared vertices (False); by default flat when that fits the preview's size limit.
        Writes every part as one VTP for ParaView and a preview the browser draws with parts to toggle."""
        import pyvista as pv

        slug = _slug(name)
        if not parts or len(parts) > PREVIEW_PARTS:
            raise ValueError(f"{name}: give 1 to {PREVIEW_PARTS} parts")
        names = [_slug(a) for a in arrays]
        specs = []
        for pname, spec in parts.items():
            ds = spec["data"] if isinstance(spec, dict) else spec
            if isinstance(ds, pv.MultiBlock):
                ds = ds.combine()
            poly = ds if isinstance(ds, pv.PolyData) else ds.extract_surface()
            if poly.n_lines and poly.faces.size:
                raise ValueError(f"{name}.{pname}: a part is either surfaces or lines, not both")
            if not poly.n_lines and not poly.faces.size:
                raise ValueError(f"{name}.{pname}: has no surfaces or lines")
            for a in names:
                if a not in poly.point_data and a not in poly.cell_data:
                    raise ValueError(f"{name}.{pname}: has no array {a!r}")
            specs.append((_slug(pname), spec if isinstance(spec, dict) else {}, poly))
        comps = {a: (3 if np.asarray(specs[0][2][a]).ndim == 2 else 1) for a in names}

        def build(flat_cells: bool):
            positions, tris, segs, values, meta, n = [], [], [], {a: [] for a in names}, [], 0
            for pname, spec, poly in specs:
                part = {"name": pname, "label": spec.get("label") or pname.replace("_", " ").replace("-", " ")}
                if "opacity" in spec:
                    part["opacity"] = float(spec["opacity"])
                if poly.n_lines:
                    lines = poly.lines
                    pairs, i = [], 0
                    while i < len(lines):
                        k = lines[i]
                        ids = lines[i + 1:i + 1 + k]
                        pairs.append(np.c_[ids[:-1], ids[1:]])
                        i += 1 + k
                    pairs = np.concatenate(pairs) if pairs else np.zeros((0, 2), np.int64)
                    used, inverse = np.unique(pairs, return_inverse=True)
                    pd = poly.cell_data_to_point_data(pass_cell_data=False) if any(a not in poly.point_data for a in names) else poly
                    positions.append(poly.points[used])
                    for a in names:
                        values[a].append(np.asarray(pd.point_data[a])[used])
                    part["segments"] = [sum(len(x) for x in segs), len(pairs)]
                    segs.append(inverse.reshape(-1, 2) + n)
                    n += len(used)
                else:
                    tri = poly.triangulate()
                    faces = tri.regular_faces
                    if flat_cells:
                        corners = faces.ravel()
                        positions.append(tri.points[corners])
                        for a in names:
                            v = np.asarray(tri.cell_data[a]) if a in tri.cell_data else np.asarray(tri.point_data[a])[corners]
                            values[a].append(np.repeat(v, 3, axis=0) if a in tri.cell_data else v)
                        local = np.arange(len(corners)).reshape(-1, 3)
                    else:
                        pd = tri.cell_data_to_point_data(pass_cell_data=False) if any(a not in tri.point_data for a in names) else tri
                        used, inverse = np.unique(faces, return_inverse=True)
                        positions.append(tri.points[used])
                        for a in names:
                            values[a].append(np.asarray(pd.point_data[a])[used])
                        local = inverse.reshape(-1, 3)
                    part["triangles"] = [sum(len(x) for x in tris), len(local)]
                    tris.append(local + n)
                    n += len(positions[-1])
                meta.append(part)
            tri_all = np.concatenate(tris) if tris else np.zeros((0, 3), np.int64)
            seg_all = np.concatenate(segs) if segs else np.zeros((0, 2), np.int64)
            per_vertex = 12 + sum(4 * comps[a] for a in names)
            size = n * per_vertex + tri_all.size * 4 + seg_all.size * 4
            return np.concatenate(positions), tri_all, seg_all, {a: np.concatenate(v) for a, v in values.items()}, meta, size

        built = build(flat is not False)
        if flat is None and built[5] > PREVIEW_BYTES:
            built = build(False)
        pts, tri_all, seg_all, vals, meta, size = built
        if len(tri_all) > PREVIEW_TRIANGLES or len(seg_all) > PREVIEW_SEGMENTS or size > PREVIEW_BYTES:
            raise ValueError(f"{name}: the preview would hold {len(tri_all)} triangles, {len(seg_all)} line segments and {size / 2**20:.0f} MB "
                             f"(limits {PREVIEW_TRIANGLES}, {PREVIEW_SEGMENTS}, {PREVIEW_BYTES / 2**20:.0f} MB); show fewer or smaller parts, or fewer arrays")
        pts = _finite(f"{name}.points", pts)

        full = f"fields/{slug}.vtp"
        if _rank() == 0:
            polys = [poly.copy() for _, _, poly in specs]
            for poly in polys:
                for data in (poly.point_data, poly.cell_data):
                    for key in list(data.keys()):
                        if key not in names:
                            del data[key]
            whole = polys[0].append_polydata(*polys[1:]) if len(polys) > 1 else polys[0]
            whole.save(str(self._path(full)))

        prefix = f"preview/{slug}"
        self._bin(f"{prefix}.positions.f32", pts.astype("<f4"))
        self._bin(f"{prefix}.indices.u32", tri_all.astype("<u4"))
        meta_arrays = []
        for a, unit in zip(names, arrays.values()):
            v = _finite(f"{name}.{a}", vals[a])
            mag = np.linalg.norm(v, axis=-1) if comps[a] == 3 else v
            self._bin(f"{prefix}.{a}.f32", v.astype("<f4"))
            meta_arrays.append({"name": a, "unit": unit, "components": comps[a], "association": "point",
                                "range": [float(mag.min()), float(mag.max())], "data": f"{prefix}.{a}.f32"})
        preview = {"version": 1, "kind": "surface", "vertices": int(len(pts)), "triangles": int(len(tri_all)),
                   "positions": f"{prefix}.positions.f32", "indices": f"{prefix}.indices.u32", "arrays": meta_arrays, "parts": meta}
        if len(seg_all):
            self._bin(f"{prefix}.segments.u32", seg_all.astype("<u4"))
            preview["segments"] = {"count": int(len(seg_all)), "indices": f"{prefix}.segments.u32"}
        self._json(f"{prefix}.json", preview)
        self.m["fields"].append({"name": name, "label": label or name.replace("_", " "), "full": full, "preview": f"{prefix}.json",
                                 "cells": int(cells if cells is not None else sum(p.n_cells for _, _, p in specs)),
                                 "arrays": [{"name": a, "unit": u} for a, u in zip(names, arrays.values())]})

    def openfoam(self, name, case=".", **options):
        """An OpenFOAM case's flow at its latest (or a given) time, as a scene: its wall patches, slices
        through the cells and streamlines seeded across the inflow. See beam_out.openfoam.scene_parts
        for the options (time, arrays, walls, slices, streamlines, seeds). Run it from a serial script
        after the solve; a decomposed case is read as it is."""
        from .openfoam import scene_parts

        label = options.pop("label", None)
        parts, arrays, cells, described = scene_parts(case, **options)
        self.scene(name, parts, arrays, label=label or described, cells=cells)

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


def parameters(with_units: bool = False, path: str | os.PathLike | None = None) -> dict:
    """The simulation version's parameters, which Beam writes to $BEAM_WORK/beam/parameters.json before
    the command runs: {name: value}, or {name: {"value": ..., "unit": ...}} with with_units=True. Empty
    outside a simulation job, so a script also runs on its own with its defaults."""
    p = Path(path) if path is not None else _work("beam/parameters.json")
    if not p.exists():
        return {}
    raw = json.loads(p.read_text())
    return raw if with_units else {k: v["value"] for k, v in raw.items()}


def gci(fine: float, medium: float, coarse: float, ratio: float) -> dict:
    """Three-mesh grid convergence index for a constant refinement ratio (Celik et al. 2008)."""
    e21, e32 = medium - fine, coarse - medium
    if e21 == 0 or e32 == 0 or e21 * e32 < 0:
        return {"state": "oscillates" if e21 * e32 < 0 else "converged", "order": None, "gci": None, "extrapolated": None}
    p = math.log(abs(e32 / e21)) / math.log(ratio)
    extrapolated = fine + (fine - medium) / (ratio**p - 1)
    return {"state": "monotonic", "order": p, "gci": 1.25 * abs(e21 / fine) / (ratio**p - 1), "extrapolated": extrapolated}


out = Results()
