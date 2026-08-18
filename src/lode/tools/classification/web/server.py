#!/usr/bin/env python3
"""Local web UI for classifying each source's raw values onto the harmonized
target schema (schema/ccnd.yaml). Same shape as column_mapping (list of
sources -> per-source review page), but the review unit is a raw *value*
combination rather than a raw column, and results are saved to
sources/<source_id>/classification_map.yaml.

Which raw column(s) feed which target attribute, and which targets get the
Street View sampling helper, are config-driven — see lode.config.yaml's
tools.classification.targets. A source missing some of a target's columns
just reviews on whichever it has (see status.present_columns()); a target
with none of its columns present for a source is marked not_applicable, not
missing.

The rule-based first-pass suggestion only ever looks at the *first* configured
column for a target (e.g. source_class for canbics_class) — combining several
free-text columns automatically is fragile, so the others are shown as
context for the human to weigh instead, alongside Street View if enabled.

Mounted under lode tools home at /classification/ — see lode.tools.home.web.server.
"""

import os
from pathlib import Path

import pandas as pd
import yaml
from dotenv import load_dotenv
from flask import Blueprint, jsonify, redirect, request, send_from_directory

from lode.helpers.config import load_config
from lode.helpers.constants import NOT_INCLUDED
from lode.helpers.geo_sampling import sample_points
from lode.helpers.matching import match_name
from lode.helpers.schema import get_field
from lode.tools.classification.status import (
    find_mapping,
    load_yaml,
    preprocessed_path,
    present_columns,
    stringify,
    target_status,
    unique_combos,
)


def create_blueprint(config: dict = None) -> Blueprint:
    config = config or load_config()
    repo_root = config["repo_root"]
    # .env lives at the project root (beside lode.config.yaml), not inside the
    # lode/ submodule — it's this project's local secret, not lode's. Explicit
    # path rather than load_dotenv()'s cwd-search default, so it works the same
    # regardless of where this is launched from.
    load_dotenv(repo_root / ".env")

    sources_dir = repo_root / config["sources_dir"]
    target_schema_path = repo_root / config["target_schema"]

    tool_config = config["tools"]["classification"]
    targets = tool_config["targets"]  # {name: {source_columns: [...], street_view: bool}}
    matching_rules_path = repo_root / tool_config["matching_rules"]
    street_view_config = tool_config.get("street_view", {})

    bp = Blueprint("classification", __name__, static_folder=str(Path(__file__).parent), static_url_path="")

    def load_matching_rules() -> dict:
        return load_yaml(matching_rules_path)

    def classification_map_path(source_id: str) -> Path:
        return sources_dir / source_id / "classification_map.yaml"

    def load_classification_map(source_id: str) -> dict:
        return load_yaml(classification_map_path(source_id))

    def save_classification_map(source_id: str, data: dict):
        path = classification_map_path(source_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            yaml.dump(data, f, sort_keys=False, allow_unicode=True)

    def load_preprocessed(source_id: str):
        import geopandas as gpd
        return gpd.read_parquet(preprocessed_path(source_id, config))

    def source_ids() -> list:
        if not sources_dir.is_dir():
            return []
        return sorted(p.name for p in sources_dir.iterdir() if p.is_dir())

    def suggest_target(target: str, columns: list, values: dict):
        """(target_value_or_None, confidence) — guessed from the *first* present
        column only, against schema/classification_matching_rules.yaml."""
        if not columns:
            return None, "none"
        rules = load_matching_rules().get(target, {})
        if not rules:
            return None, "none"
        primary_value = values.get(columns[0], "")
        if not primary_value:
            return None, "none"
        return match_name(primary_value, rules)

    def target_options(target: str):
        try:
            field = get_field(target_schema_path, target)
        except ValueError:
            return None
        return field.get("enum")

    # No list-of-sources page here — lode tools home's table replaced it and
    # links straight into review.html for a given source. / just bounces
    # back there so a bookmarked/typed URL still lands somewhere useful.
    @bp.route("/")
    def index():
        return redirect("/")

    @bp.route("/review.html")
    def review_page():
        return send_from_directory(bp.static_folder, "review.html")

    # Used by review.js's "Next source" button to find the next one that
    # still needs work — not a list-of-sources page (that's home's job now).
    @bp.route("/api/sources")
    def api_sources():
        result = []
        for source_id in source_ids():
            if not preprocessed_path(source_id, config).exists():
                result.append({"source_id": source_id, "has_preprocessed_data": False, "targets": {}})
                continue
            df = load_preprocessed(source_id)
            result.append({
                "source_id": source_id,
                "has_preprocessed_data": True,
                "targets": {name: target_status(source_id, df, name, config) for name in targets},
            })
        return jsonify(result)

    @bp.route("/api/classification/<source_id>")
    def api_classification_get(source_id):
        if not preprocessed_path(source_id, config).exists():
            return jsonify({"error": f"no preprocessed data for {source_id} — run 'lode pipeline preprocessing' first"}), 404

        df = load_preprocessed(source_id)
        saved = load_classification_map(source_id)

        result = {}
        for target, target_config in targets.items():
            columns = present_columns(df, target, targets)
            options = target_options(target)
            street_view = bool(target_config.get("street_view", False))

            if not columns:
                result[target] = {"source_columns": [], "options": options, "street_view": street_view, "groups": []}
                continue

            mappings = saved.get(target, {}).get("mappings", [])
            groups = []
            for combo in unique_combos(df, columns):
                existing = find_mapping(mappings, columns, combo["values"])
                if existing:
                    groups.append({
                        "values": combo["values"],
                        "count": combo["count"],
                        "target": existing["target"],
                        "method": existing.get("method", "manual"),
                        "notes": existing.get("notes", ""),
                        "confidence": "saved",
                    })
                    continue
                suggested, confidence = suggest_target(target, columns, combo["values"])
                groups.append({
                    "values": combo["values"],
                    "count": combo["count"],
                    "target": suggested,
                    "method": "rule" if suggested else None,
                    "notes": "",
                    "confidence": confidence,
                })

            result[target] = {"source_columns": columns, "options": options, "street_view": street_view, "groups": groups}

        return jsonify({"source_id": source_id, "targets": result})

    @bp.route("/api/classification/<source_id>", methods=["POST"])
    def api_classification_save(source_id):
        data = request.get_json()
        target = data.get("target")
        values = data.get("values")
        target_value = (data.get("target_value") or "").strip()
        method = data.get("method") or "manual"
        notes = (data.get("notes") or "").strip()

        if target not in targets:
            return jsonify({"error": f"unknown target '{target}'"}), 400
        if not values:
            return jsonify({"error": "values required"}), 400
        if not target_value:
            return jsonify({"error": "target_value required"}), 400

        columns = targets[target]["source_columns"]
        saved = load_classification_map(source_id)
        target_entry = saved.setdefault(target, {"source_columns": columns, "mappings": []})
        target_entry["source_columns"] = columns

        entry = {"values": values, "target": target_value, "method": method}
        if notes:
            entry["notes"] = notes

        existing = find_mapping(target_entry["mappings"], columns, values)
        if existing:
            target_entry["mappings"][target_entry["mappings"].index(existing)] = entry
        else:
            target_entry["mappings"].append(entry)

        save_classification_map(source_id, saved)
        return jsonify({"ok": True})

    @bp.route("/api/config")
    def api_config():
        any_street_view = any(t.get("street_view") for t in targets.values())
        mock = bool(street_view_config.get("mock", True))
        return jsonify({
            "street_view_enabled": any_street_view,
            "mock": mock,
            "maps_api_key": (os.environ.get("GOOGLE_MAPS_API_KEY") or None) if (any_street_view and not mock) else None,
            "n_samples": street_view_config.get("n_samples", 3),
            "not_included_value": NOT_INCLUDED,
        })

    @bp.route("/api/sample_points/<source_id>", methods=["POST"])
    def api_sample_points(source_id):
        data = request.get_json()
        target = data.get("target")
        values = data.get("values") or {}
        fresh = bool(data.get("fresh"))

        if target not in targets:
            return jsonify({"error": f"unknown target '{target}'"}), 400
        if not preprocessed_path(source_id, config).exists():
            return jsonify({"error": f"no preprocessed data for {source_id}"}), 404

        df = load_preprocessed(source_id)
        columns = present_columns(df, target, targets)
        mask = pd.Series(True, index=df.index)
        for c in columns:
            mask &= df[c].map(stringify) == values.get(c, "")
        subset = df[mask]

        n_samples = street_view_config.get("n_samples", 3)
        n_reserve = street_view_config.get("n_reserve", 5)
        # A fresh request (the review UI's "Regenerate" once its spare points are
        # used up) ignores the configured seed so it actually gets a new draw —
        # otherwise every call for the same group/subset would be identical.
        seed = None if fresh else street_view_config.get("seed")
        points = sample_points(subset, n_samples + n_reserve, seed=seed)

        return jsonify({
            "n_features": int(len(subset)),
            "points": points[:n_samples],
            "spare_points": points[n_samples:],
        })

    return bp
