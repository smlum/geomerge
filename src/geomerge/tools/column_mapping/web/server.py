#!/usr/bin/env python3
"""Local web UI for mapping each source's raw column names onto the common
target schema (schema/ccnd.yaml's source_mappable fields, by default — see
geomerge.config.yaml). A per-source page that inspects the raw file, suggests
targets via a rule-based first pass, and saves your corrections to
sources/<source_id>/column_map.yaml. The list-of-sources view lives in
geomerge serve now, not here — see index() below.

Nothing here is project-specific except geomerge.config.yaml's paths — point
that at a different schema/matching-rules file and this tool works for
another domain unchanged.

Mounted under geomerge serve at /column-mapping/ — see geomerge.tools.home.web.server.
"""

from collections import Counter
from pathlib import Path

import yaml
from flask import Blueprint, jsonify, redirect, request, send_from_directory

from geomerge.helpers.config import load_config
from geomerge.helpers.matching import match_name
from geomerge.tools.column_mapping.inspect_raw import GEO_FORMATS, inspect_columns
from geomerge.tools.column_mapping.status import cached_raw_column_names, load_yaml, source_status


def create_blueprint(config: dict = None) -> Blueprint:
    config = config or load_config()
    repo_root = config["repo_root"]
    tool_config = config["tools"]["column_mapping"]

    target_schema_path = repo_root / config["target_schema"]
    matching_rules_path = repo_root / tool_config["matching_rules"]
    sources_dir = repo_root / config["sources_dir"]
    raw_dir = repo_root / config["raw_dir"]
    sample_count = tool_config.get("sample_count", 3)
    sample_max_len = tool_config.get("sample_max_len", 25)

    bp = Blueprint("column_mapping", __name__, static_folder=str(Path(__file__).parent), static_url_path="")

    def load_target_fields() -> list:
        schema = yaml.safe_load(target_schema_path.read_text())
        return [f["name"] for f in schema["fields"] if f.get("source_mappable")]

    def load_matching_rules() -> dict:
        return yaml.safe_load(matching_rules_path.read_text()) or {}

    def source_ids() -> list:
        if not sources_dir.is_dir():
            return []
        return sorted(p.name for p in sources_dir.iterdir() if p.is_dir())

    # No list-of-sources page here — geomerge serve's table replaced it
    # (it already shows this tool's status alongside every other tool's, and
    # links straight into map.html for a given source). / just bounces back
    # there so a bookmarked/typed URL still lands somewhere useful.
    @bp.route("/")
    def index():
        return redirect("/")

    @bp.route("/map.html")
    def map_page():
        return send_from_directory(bp.static_folder, "map.html")

    @bp.route("/api/sources")
    def api_sources():
        return jsonify([source_status(sid, config) for sid in source_ids()])

    @bp.route("/api/column_map/<source_id>")
    def api_column_map_get(source_id):
        source_dir = sources_dir / source_id
        metadata = load_yaml(source_dir / "metadata.yaml")
        if not metadata:
            return jsonify({"error": "no metadata.yaml for this source yet"}), 404

        raw_filename = metadata.get("raw_filename")
        fmt = metadata.get("format")
        if not raw_filename or not fmt:
            return jsonify({"error": "metadata.yaml is missing raw_filename and/or format"}), 400

        raw_path = raw_dir / source_id / raw_filename
        if not raw_path.exists():
            return jsonify({"error": f"raw file not found at data/raw/{source_id}/{raw_filename}"}), 404

        try:
            columns = inspect_columns(raw_path, fmt, sample_count=sample_count, sample_max_len=sample_max_len)
        except Exception as e:
            # Broad on purpose: raw files are external, arbitrary-shaped data
            # (a mislabeled format, a BOM, a nested structure a format-specific
            # reader doesn't expect) — any of those can throw something other
            # than ValueError (a real prior bug: a GeoJSON file mislabeled as
            # "json" hit a bare TypeError here, which — uncaught — became an
            # HTML 500 page. The frontend's res.json() then threw on that HTML,
            # silently, leaving the page looking like it just never loaded).
            # Catching everything here keeps that failure mode to "a real,
            # visible error message" instead of a silent hang.
            return jsonify({"error": f"failed to read raw file: {e}"}), 400

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
            # For map.html's "View source" link — the portal page describing
            # this dataset (see schema/sources.yaml), so mismatches between a
            # raw column and what's expected can be checked against the
            # original listing.
            "dataset_page_url": metadata.get("dataset_page_url", ""),
            "flagged": bool(saved.get("flagged", False)),
        })

    @bp.route("/api/column_map/<source_id>", methods=["POST"])
    def api_column_map_save(source_id):
        data = request.get_json()
        assignments = data.get("assignments", {})
        flagged = bool(data.get("flagged", False))

        # Guard against a partial/stale submission silently clobbering a good
        # mapping (e.g. a direct API call, or two tabs open on the same source) —
        # the payload must cover every column currently in the raw file, not just
        # some of them. Only the column *names* matter for this check, so this
        # uses the same cheap, cached read status.py's dashboard scan does —
        # not inspect_columns()'s full per-column dtype/null/unique/sample pass,
        # which a save/flag click has no use for. Re-parsing a whole raw file
        # (sometimes hundreds of MB) just to write a small YAML was itself the
        # bug: it made a save no safer (a mismatched column list is exactly as
        # detectable from names alone) while dragging in every failure mode a
        # full data read can hit that a schema-only read doesn't (e.g. a value
        # that can't be hashed for .unique() — a real prior bug that turned
        # Flag & next into an indefinite hang on one particular file).
        source_dir = sources_dir / source_id
        metadata = load_yaml(source_dir / "metadata.yaml")
        raw_filename = metadata.get("raw_filename")
        fmt = metadata.get("format")
        if raw_filename and fmt:
            raw_path = raw_dir / source_id / raw_filename
            if raw_path.exists():
                try:
                    raw_columns = cached_raw_column_names(raw_path, fmt)
                except Exception:
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
        # but a real (non-flagged) save must have every collision actually
        # resolved. A flagged save is explicitly "I'm skipping this one for
        # now" — forcing every ambiguous column to be resolved right now would
        # defeat the point of deferring a complex source to the end.
        target_counts = Counter(target for target in assignments.values() if target)
        collisions = sorted(target for target, count in target_counts.items() if count > 1)
        if collisions and not flagged:
            return jsonify({"error": f"resolve before saving — assigned to more than one column: {', '.join(collisions)}"}), 400

        column_map = {name: target for name, target in assignments.items() if target}
        dropped = sorted(name for name, target in assignments.items() if not target)

        out = {"source_id": source_id, "column_map": column_map, "dropped": dropped, "flagged": flagged}

        out_path = sources_dir / source_id / "column_map.yaml"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w") as f:
            yaml.dump(out, f, sort_keys=False, allow_unicode=True)
        return jsonify({"ok": True})

    # The raw file text — for geomerge serve's read-only column_map.yaml
    # preview modal, same pattern as collection's /api/source/<id>/raw.
    @bp.route("/api/column_map/<source_id>/raw")
    def api_column_map_get_raw(source_id):
        out_path = sources_dir / source_id / "column_map.yaml"
        if not out_path.exists():
            return jsonify({"error": "not found"}), 404
        return jsonify({"content": out_path.read_text(), "path": str(out_path.relative_to(repo_root))})

    return bp
