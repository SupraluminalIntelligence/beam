"""Read an OpenFOAM case into the parts of a flow scene (walls, slices, streamlines) for Results.scene."""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np

AXES = {"x": 0, "y": 1, "z": 2}
# OpenFOAM dimension sets [kg m s K mol A cd] with the unit Beam shows for them.
UNITS = {
    (0, 1, -1, 0, 0, 0, 0): "m/s",
    (1, -1, -2, 0, 0, 0, 0): "Pa",
    (0, 2, -2, 0, 0, 0, 0): "m^2/s^2",
    (0, 2, -3, 0, 0, 0, 0): "m^2/s^3",
    (0, 2, -1, 0, 0, 0, 0): "m^2/s",
    (0, 0, -1, 0, 0, 0, 0): "1/s",
    (0, 0, 0, 1, 0, 0, 0): "K",
    (1, -3, 0, 0, 0, 0, 0): "kg/m^3",
    (0, 0, 0, 0, 0, 0, 0): "1",
}
BASE = ("kg", "m", "s", "K", "mol", "A", "cd")
PREFERRED = ("U", "p", "p_rgh", "T", "alpha.water")


def _unit(dims) -> str:
    dims = tuple(int(round(d)) for d in dims)
    if dims in UNITS:
        return UNITS[dims]
    up = [f"{b}^{d}" if d != 1 else b for b, d in zip(BASE, dims) if d > 0]
    down = [f"{b}^{-d}" if d != -1 else b for b, d in zip(BASE, dims) if d < 0]
    return (" ".join(up) or "1") + ("/" + " ".join(down) if down else "")


def _times(d: Path) -> list[float]:
    out = []
    for p in d.iterdir() if d.is_dir() else []:
        try:
            out.append((float(p.name), p))
        except ValueError:
            pass
    return [t for t, p in sorted(out) if p.is_dir()]


def _patch_types(boundary: Path) -> dict[str, str]:
    """{patch: type} from constant/polyMesh/boundary."""
    text = re.sub(r"/\*.*?\*/|//[^\n]*", "", boundary.read_text(), flags=re.S)
    return {m.group(1): m.group(2) for m in re.finditer(r"(\S+)\s*\{[^{}]*?\btype\s+(\w+)\s*;", text)}


def _dimensions(field: Path) -> list[float] | None:
    try:
        head = field.read_text(errors="replace")[:4000]
    except (OSError, IsADirectoryError):
        return None
    m = re.search(r"dimensions\s*\[([^\]]*)\]", head)
    return [float(v) for v in m.group(1).split()] if m else None


def scene_parts(case=".", *, time=None, arrays=None, walls=None, slices=None, streamlines=True, seeds=150):
    """The parts of a flow scene from an OpenFOAM case.

    time: the time to show; the latest written by default.
    arrays: field names to colour by (U, p and T when present by default); units come from each
      field's dimensions.
    walls: patch names to draw (every patch of type wall by default); walls that enclose the flow
      start see-through.
    slices: planes through the cells, each ("x" | "y" | "z", position) or {"normal": (nx, ny, nz),
      "origin": (x, y, z)}; by default one through the domain's centre, across its thinnest side.
    streamlines: seeded across the inflow patches (where U points in), or through the domain when
      nothing flows in; False for none. seeds: how many.
    Returns (parts, {array: unit}, cells, label)."""
    import pyvista as pv

    case = Path(case)
    foam = next(iter(sorted(case.glob("*.foam"))), None) or case / "beam.foam"
    foam.touch()
    reconstructed, decomposed = _times(case), _times(case / "processor0")
    use_decomposed = bool(decomposed) and (not reconstructed or decomposed[-1] > reconstructed[-1])
    root = case / "processor0" if use_decomposed else case
    reader = pv.POpenFOAMReader(str(foam))
    if use_decomposed:
        reader.case_type = "decomposed"
    reader.enable_all_patch_arrays()
    reader.cell_to_point_creation = True
    times = reader.time_values
    if not times:
        raise ValueError(f"{case}: no time directories to read")
    t = times[-1] if time is None else min(times, key=lambda v: abs(v - time))
    reader.set_active_time_value(t)
    data = reader.read()
    mesh = data["internalMesh"]
    boundary = data["boundary"] if "boundary" in data.keys() else pv.MultiBlock()

    stamp = next((p for p in root.iterdir() if p.is_dir() and _times_match(p.name, t)), None)
    available = [a for a in mesh.cell_data.keys() if a in mesh.point_data.keys()]
    chosen = list(arrays) if arrays is not None else [a for a in PREFERRED if a in available]
    if not chosen:
        raise ValueError(f"{case}: none of {', '.join(PREFERRED)} at t = {t:g}; name the arrays to show (it has {', '.join(available)})")
    units = {}
    for a in chosen:
        if a not in available:
            raise ValueError(f"{case}: no field {a!r} at t = {t:g} (it has {', '.join(available)})")
        dims = _dimensions(stamp / a) if stamp else None
        units[a] = _unit(dims) if dims else ""

    parts = {}
    lo, hi = np.array(mesh.bounds[0::2]), np.array(mesh.bounds[1::2])
    extent = np.maximum(hi - lo, 1e-30)
    types = _patch_types(root / "constant/polyMesh/boundary")
    wall_names = list(walls) if walls is not None else [n for n, ty in types.items() if "wall" in ty.lower()]
    wall_blocks = [(n, boundary[n]) for n in wall_names if n in boundary.keys() and boundary[n] is not None and boundary[n].n_cells]
    if walls is not None and len(wall_blocks) != len(wall_names):
        missing = [n for n in wall_names if n not in dict(wall_blocks)]
        raise ValueError(f"{case}: no patch {', '.join(missing)} (it has {', '.join(boundary.keys())})")
    if wall_blocks:
        wlo = np.min([b.bounds[0::2] for _, b in wall_blocks], axis=0)
        whi = np.max([b.bounds[1::2] for _, b in wall_blocks], axis=0)
        encloses = bool(np.all((whi - wlo) >= 0.9 * extent))
        grouped = wall_blocks if len(wall_blocks) <= 6 else [("walls", pv.MultiBlock([b for _, b in wall_blocks]).combine().extract_surface())]
        for n, b in grouped:
            parts[_part(n)] = {"data": b, "label": n, **({"opacity": 0.25} if encloses else {})}

    centre = (lo + hi) / 2
    planes = slices if slices is not None else [("xyz"[int(np.argmin(extent))], float(centre[int(np.argmin(extent))]))]
    for s in planes:
        if isinstance(s, dict):
            normal, origin = tuple(s["normal"]), tuple(s["origin"])
            key, text = "slice", f"slice through {tuple(round(v, 6) for v in origin)}"
        else:
            axis, at = s
            normal = tuple(1.0 if k == AXES[axis] else 0.0 for k in range(3))
            origin = tuple(at if k == AXES[axis] else centre[k] for k in range(3))
            key, text = f"slice-{axis}", f"slice {axis} = {at:g} m"
        cut = mesh.slice(normal=normal, origin=origin)
        if not cut.n_cells:
            raise ValueError(f"{case}: the {text} misses the mesh (bounds {mesh.bounds})")
        name = key
        while name in parts:
            name = f"{key}-{len(parts)}"
        parts[name] = {"data": cut, "label": text}

    if streamlines and "U" in mesh.point_data.keys():
        rng = np.random.default_rng(0)
        starts = []
        for n in boundary.keys():
            patch = boundary[n]
            if patch is None or not patch.n_cells or types.get(n, "").lower() in ("empty", "wedge", "symmetry", "symmetryplane", "cyclic") or "wall" in types.get(n, "").lower():
                continue
            if "U" not in patch.cell_data:
                continue
            sized = patch.compute_normals(cell_normals=True, point_normals=False, auto_orient_normals=False, consistent_normals=False, split_vertices=False)
            area = sized.compute_cell_sizes(length=False, area=True, volume=False).cell_data["Area"]
            inflow = -np.einsum("ij,ij->i", np.asarray(patch.cell_data["U"]), np.asarray(sized.cell_data["Normals"])) * area
            if inflow.sum() > 0:
                starts.append((sized, np.clip(inflow, 0, None)))
        if starts:
            weights = np.concatenate([w for _, w in starts])
            centres = np.concatenate([np.asarray(p.cell_centers().points) - 1e-3 * extent.min() * np.asarray(p.cell_data["Normals"]) for p, _ in starts])
            pick = rng.choice(len(centres), size=min(seeds, int((weights > 0).sum())), replace=False, p=weights / weights.sum())
            points, direction = centres[pick], "forward"
        else:
            cc = np.asarray(mesh.cell_centers().points)
            points, direction = cc[rng.choice(len(cc), size=min(seeds, len(cc)), replace=False)], "both"
        lines = mesh.streamlines_from_source(pv.PolyData(points), vectors="U", integration_direction=direction, max_length=4 * float(np.linalg.norm(extent)))
        if lines.n_lines:
            parts["streamlines"] = {"data": lines, "label": "streamlines from the inflow" if starts else "streamlines through the domain"}

    return parts, units, int(mesh.n_cells), f"{case.resolve().name} at t = {t:g} s"


def _part(name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "patch"
    return slug[:80]


def _times_match(name: str, t: float) -> bool:
    try:
        return abs(float(name) - t) <= 1e-9 * max(1.0, abs(t))
    except ValueError:
        return False
