#!/usr/bin/env python3
"""Local web UI for mapping each source's raw column names onto the common
target schema (schema/ccnd.yaml's source_mappable fields, by default — see
lode.config.yaml). Two views: a list of sources with what's missing (raw
data / metadata) before mapping is even possible, and a per-source page that
inspects the raw file, suggests targets via a rule-based first pass, and
saves your corrections to sources/<source_id>/column_map.yaml.

Nothing here is project-specific except lode.config.yaml's paths — point
that at a different schema/matching-rules file and this tool works for
another domain unchanged.

Usage:
    lode tools column-mapping
Then open http://localhost:8645
"""

from collections import Counter
from pathlib import Path

import yaml
from flask import Flask, jsonify, request, send_from_directory

from lode.helpers.config import load_config
from lode.helpers.matching import match_name
from lode.tools.column_mapping.inspect_raw import GEO_FORMATS, inspect_columns

CONFIG = load_config()
REPO_ROOT = CONFIG["repo_root"]
TOOL_CONFIG = CONFIG["tools"]["column_mapping"]

TARGET_SCHEMA_PATH = REPO_ROOT / CONFIG["target_schema"]
MATCHING_RULES_PATH = REPO_ROOT / TOOL_CONFIG["matching_rules"]
SOURCES_DIR = REPO_ROOT / CONFIG["sources_dir"]
RAW_DIR = REPO_ROOT / CONFIG["raw_dir"]
SAMPLE_COUNT = TOOL_CONFIG.get("sample_count", 3)
SAMPLE_MAX_LEN = TOOL_CONFIG.get("sample_max_len", 25)

app = Flask(__name__, static_folder=str(Path(__file__).parent), static_url_path="")


def load_target_fields() -> list:
    schema = yaml.safe_load(TARGET_SCHEMA_PATH.read_text())
    return [f["name"] for f in schema["fields"] if f.get("source_mappable")]


def load_matching_rules() -> dict:
    return yaml.safe_load(MATCHING_RULES_PATH.read_text()) or {}


def load_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text()) or {} if path.exists() else {}


def source_ids() -> list:
    if not SOURCES_DIR.is_dir():
        return []
    return sorted(p.name for p in SOURCES_DIR.iterdir() if p.is_dir())


def source_status(source_id: str) -> dict:
    source_dir = SOURCES_DIR / source_id
    metadata = load_yaml(source_dir / "metadata.yaml")
    has_metadata = bool(metadata)

    raw_filename = metadata.get("raw_filename") or None
    fmt = metadata.get("format") or None
    raw_path = RAW_DIR / source_id / raw_filename if raw_filename else None
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


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/map.html")
def map_page():
    return send_from_directory(app.static_folder, "map.html")


@app.route("/api/sources")
def api_sources():
    return jsonify([source_status(sid) for sid in source_ids()])


@app.route("/api/column_map/<source_id>")
def api_column_map_get(source_id):
    source_dir = SOURCES_DIR / source_id
    metadata = load_yaml(source_dir / "metadata.yaml")
    if not metadata:
        return jsonify({"error": "no metadata.yaml for this source yet"}), 404

    raw_filename = metadata.get("raw_filename")
    fmt = metadata.get("format")
    if not raw_filename or not fmt:
        return jsonify({"error": "metadata.yaml is missing raw_filename and/or format"}), 400

    raw_path = RAW_DIR / source_id / raw_filename
    if not raw_path.exists():
        return jsonify({"error": f"raw file not found at data/raw/{source_id}/{raw_filename}"}), 404

    try:
        columns = inspect_columns(raw_path, fmt, sample_count=SAMPLE_COUNT, sample_max_len=SAMPLE_MAX_LEN)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    matching_rules = load_matching_rules()
    saved = load_yaml(source_dir / "column_map.yaml")
    saved_map = saved.get("column_map", {})
    saved_dropped = set(saved.get("dropped", []))

    for col in columns:
        if col["name"] in saved_map:
            col["assigned"] = saved_map[col["name"]]
            col["confidence"] = "saved"
        elif col["name"] in saved_dropped:
            col["assigned"] = None
            col["confidence"] = "saved"
        else:
            target, confidence = match_name(col["name"], matching_rules)
            col["assigned"] = target
            col["confidence"] = confidence

    # Soft-flag targets assigned to more than one column — resolved by the
    # human, not blocked (an arbitrary tie already picked the suggestion).
    target_counts = Counter(c["assigned"] for c in columns if c["assigned"])
    for col in columns:
        col["collision"] = bool(col["assigned"]) and target_counts[col["assigned"]] > 1

    targets = load_target_fields()
    # geometry is handled natively by geo formats (geojson/shapefile/gpkg) —
    # it'd never get column-mapped for those, so it'd otherwise show as
    # permanently "missing" and just be noise in the reminder list below.
    reminder_targets = [t for t in targets if not (t == "geometry" and fmt in GEO_FORMATS)]

    return jsonify({
        "source_id": source_id,
        "raw_filename": raw_filename,
        "format": fmt,
        "targets": targets,
        "reminder_targets": reminder_targets,
        "columns": columns,
        "width_unit": saved.get("width_unit", ""),
    })


@app.route("/api/column_map/<source_id>", methods=["POST"])
def api_column_map_save(source_id):
    data = request.get_json()
    assignments = data.get("assignments", {})
    width_unit = (data.get("width_unit") or "").strip()

    # Guard against a partial/stale submission silently clobbering a good
    # mapping (e.g. a direct API call, or two tabs open on the same source) —
    # the payload must cover every column currently in the raw file, not just
    # some of them.
    source_dir = SOURCES_DIR / source_id
    metadata = load_yaml(source_dir / "metadata.yaml")
    raw_filename = metadata.get("raw_filename")
    fmt = metadata.get("format")
    if raw_filename and fmt:
        raw_path = RAW_DIR / source_id / raw_filename
        if raw_path.exists():
            try:
                raw_columns = {c["name"] for c in inspect_columns(raw_path, fmt)}
            except ValueError:
                raw_columns = None
            if raw_columns is not None:
                submitted = set(assignments)
                missing = raw_columns - submitted
                extra = submitted - raw_columns
                if missing or extra:
                    detail = []
                    if missing:
                        detail.append(f"missing: {', '.join(sorted(missing))}")
                    if extra:
                        detail.append(f"not in raw file: {', '.join(sorted(extra))}")
                    return jsonify({"error": f"assignments don't match the current raw file's columns ({'; '.join(detail)})"}), 400

    # Soft-flag collisions can still be saved from a normal edit in progress,
    # but the final save must have every collision actually resolved.
    target_counts = Counter(target for target in assignments.values() if target)
    collisions = sorted(target for target, count in target_counts.items() if count > 1)
    if collisions:
        return jsonify({"error": f"resolve before saving — assigned to more than one column: {', '.join(collisions)}"}), 400

    column_map = {name: target for name, target in assignments.items() if target}
    dropped = sorted(name for name, target in assignments.items() if not target)

    out = {"source_id": source_id, "column_map": column_map, "dropped": dropped}
    if "source_width" in column_map.values() and width_unit:
        out["width_unit"] = width_unit

    out_path = SOURCES_DIR / source_id / "column_map.yaml"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        yaml.dump(out, f, sort_keys=False, allow_unicode=True)
    return jsonify({"ok": True})


def main(argv=None):
    app.run(debug=True, port=8645)


if __name__ == "__main__":
    main()
