"""Status helper usable without spinning up column_mapping's Flask app —
what geomerge serve shows in its table."""

from pathlib import Path

import yaml

from geomerge.helpers.file_cache import cached_read, cached_yaml
from geomerge.helpers.status import COMPLETE, NEEDS_REVIEW, NOT_STARTED
from geomerge.tools.column_mapping.inspect_raw import raw_column_names


def load_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text()) or {} if path.exists() else {}


def cached_raw_column_names(raw_path: Path, fmt: str) -> set:
    """raw_column_names(), cached on disk too (helpers/file_cache.py) — it's
    the costliest part of a cold dashboard load (a scan of every raw file),
    and a raw file's columns essentially never change."""
    return cached_read(raw_path, raw_column_names, fmt, persist=True)


def source_status(source_id: str, config: dict) -> dict:
    repo_root = config["repo_root"]
    sources_dir = repo_root / config["sources_dir"]
    raw_dir = repo_root / config["raw_dir"]

    source_dir = sources_dir / source_id
    metadata = cached_yaml(source_dir / "metadata.yaml")
    has_metadata = bool(metadata)

    raw_filename = metadata.get("raw_filename") or None
    fmt = metadata.get("format") or None
    raw_path = raw_dir / source_id / raw_filename if raw_filename else None
    has_data = bool(raw_path and raw_path.exists())

    column_map_path = source_dir / "column_map.yaml"
    has_column_map = column_map_path.exists()

    status = NOT_STARTED
    if has_column_map:
        column_map = cached_yaml(column_map_path)
        assigned = list(column_map.get("column_map", {}).values())
        accounted = set(column_map.get("column_map", {})) | set(column_map.get("dropped", []))
        if len(assigned) != len(set(assigned)):
            # A target assigned to more than one column — only savable via
            # Flag & next (see server.py), and never complete until resolved.
            status = NEEDS_REVIEW
        elif has_data:
            try:
                raw_columns = cached_raw_column_names(raw_path, fmt)
                status = COMPLETE if accounted == raw_columns else NEEDS_REVIEW
            except ValueError:
                status = NEEDS_REVIEW
        else:
            status = NEEDS_REVIEW

    return {
        "source_id": source_id,
        "has_metadata": has_metadata,
        "has_data": has_data,
        "raw_filename": raw_filename,
        "format": fmt,
        "column_map_status": status,
        # The source's shared flag (metadata.yaml) — see helpers/source_notes.py.
        "flagged": bool(metadata.get("flagged", False)),
    }
