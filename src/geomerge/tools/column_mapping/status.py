"""Status helper usable without spinning up column_mapping's Flask app —
what geomerge serve shows in its table."""

from pathlib import Path

import yaml

from geomerge.tools.column_mapping.inspect_raw import raw_column_names


def load_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text()) or {} if path.exists() else {}


# source_status() below is called for every source on every dashboard load
# (home, prep) and every "save & next" click (column_mapping's own
# /api/sources) — reading a raw file's column names fresh every single time
# is the actual cost (a full geopandas parse for geo formats, worst case
# ~11s for one large real file in this project), even though the same raw
# file's columns essentially never change between those calls. Keyed by
# mtime rather than just path so a re-downloaded/updated raw file is picked
# up automatically instead of needing a server restart — process-lifetime
# only (no persistence across restarts), which is fine for a local dev tool.
_raw_column_names_cache: dict[str, tuple[float, set]] = {}


def cached_raw_column_names(raw_path: Path, fmt: str) -> set:
    key = str(raw_path)
    mtime = raw_path.stat().st_mtime
    cached = _raw_column_names_cache.get(key)
    if cached and cached[0] == mtime:
        return cached[1]
    names = raw_column_names(raw_path, fmt)
    _raw_column_names_cache[key] = (mtime, names)
    return names


def source_status(source_id: str, config: dict) -> dict:
    repo_root = config["repo_root"]
    sources_dir = repo_root / config["sources_dir"]
    raw_dir = repo_root / config["raw_dir"]

    source_dir = sources_dir / source_id
    metadata = load_yaml(source_dir / "metadata.yaml")
    has_metadata = bool(metadata)

    raw_filename = metadata.get("raw_filename") or None
    fmt = metadata.get("format") or None
    raw_path = raw_dir / source_id / raw_filename if raw_filename else None
    has_data = bool(raw_path and raw_path.exists())

    column_map_path = source_dir / "column_map.yaml"
    has_column_map = column_map_path.exists()

    status = "not_started"
    flagged = False
    if has_column_map:
        column_map = load_yaml(column_map_path)
        flagged = bool(column_map.get("flagged", False))
        accounted = set(column_map.get("column_map", {})) | set(column_map.get("dropped", []))
        if flagged:
            # A source explicitly flagged "revisit later" must never read as
            # complete, even if every raw column happens to already be
            # accounted for (e.g. a collision left unresolved on purpose) —
            # otherwise it'd silently drop out of the "still needs work" pool
            # that findNextSourcePreferUnflagged (map.js) relies on to surface
            # it again once nothing unflagged is left.
            status = "needs_review"
        elif has_data:
            try:
                raw_columns = cached_raw_column_names(raw_path, fmt)
                status = "complete" if accounted == raw_columns else "needs_review"
            except ValueError:
                status = "needs_review"
        else:
            status = "needs_review"

    return {
        "source_id": source_id,
        "has_metadata": has_metadata,
        "has_data": has_data,
        "raw_filename": raw_filename,
        "format": fmt,
        "column_map_status": status,
        "flagged": flagged,
    }
