"""Status helper usable without spinning up column_mapping's Flask app —
what geomerge serve shows in its table."""

from pathlib import Path

import yaml

from geomerge.tools.column_mapping.inspect_raw import inspect_columns


def load_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text()) or {} if path.exists() else {}


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
    if has_column_map:
        column_map = load_yaml(column_map_path)
        accounted = set(column_map.get("column_map", {})) | set(column_map.get("dropped", []))
        if has_data:
            try:
                raw_columns = {c["name"] for c in inspect_columns(raw_path, fmt)}
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
    }
