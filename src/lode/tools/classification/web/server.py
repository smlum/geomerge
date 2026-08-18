#!/usr/bin/env python3
"""Local web UI for classifying each source's raw values onto the harmonized
target schema (schema/ccnd.yaml). Same shape as column_mapping (list of
sources -> per-source review page), but the review unit is a raw *value*
combination rather than a raw column, and results are saved to
sources/<source_id>/classification_map.yaml.

Which raw column(s) feed which target attribute, and which targets get the
Street View sampling helper, are config-driven — see lode.config.yaml's
tools.classification.targets. A source missing some of a target's columns
just reviews on whichever it has (see present_columns()); a target with none
of its columns present for a source is marked not_applicable, not missing.

The rule-based first-pass suggestion only ever looks at the *first* configured
column for a target (e.g. source_class for canbics_class) — combining several
free-text columns automatically is fragile, so the others are shown as
context for the human to weigh instead, alongside Street View if enabled.

Usage:
    lode tools classification review
Then open http://localhost:8646
"""

import math
import os
from pathlib import Path

import geopandas as gpd
import pandas as pd
import yaml
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

from lode.helpers.config import load_config, stage_output_dir
from lode.helpers.constants import NOT_INCLUDED
from lode.helpers.geo_sampling import sample_points
from lode.helpers.matching import match_name
from lode.helpers.schema import get_field

CONFIG = load_config()
REPO_ROOT = CONFIG["repo_root"]
# .env lives at the project root (beside lode.config.yaml), not inside the
# lode/ submodule — it's this project's local secret, not lode's. Explicit
# path rather than load_dotenv()'s cwd-search default, so it works the same
# regardless of where `lode tools classification` is run from.
load_dotenv(REPO_ROOT / ".env")
SOURCES_DIR = REPO_ROOT / CONFIG["sources_dir"]
TARGET_SCHEMA_PATH = REPO_ROOT / CONFIG["target_schema"]
PREPROCESSING_DIR = stage_output_dir(CONFIG, "preprocessing")

TOOL_CONFIG = CONFIG["tools"]["classification"]
TARGETS = TOOL_CONFIG["targets"]  # {name: {source_columns: [...], street_view: bool}}
MATCHING_RULES_PATH = REPO_ROOT / TOOL_CONFIG["matching_rules"]
STREET_VIEW_CONFIG = TOOL_CONFIG.get("street_view", {})

app = Flask(__name__, static_folder=str(Path(__file__).parent), static_url_path="")


# ---- yaml / data access ----------------------------------------------------

def load_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text()) or {} if path.exists() else {}


def load_matching_rules() -> dict:
    return load_yaml(MATCHING_RULES_PATH)


def classification_map_path(source_id: str) -> Path:
    return SOURCES_DIR / source_id / "classification_map.yaml"


def load_classification_map(source_id: str) -> dict:
    return load_yaml(classification_map_path(source_id))


def save_classification_map(source_id: str, data: dict):
    path = classification_map_path(source_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        yaml.dump(data, f, sort_keys=False, allow_unicode=True)


def source_ids() -> list:
    if not SOURCES_DIR.is_dir():
        return []
    return sorted(p.name for p in SOURCES_DIR.iterdir() if p.is_dir())


def preprocessed_path(source_id: str) -> Path:
    return PREPROCESSING_DIR / source_id / f"{source_id}.parquet"


def load_preprocessed(source_id: str) -> gpd.GeoDataFrame:
    return gpd.read_parquet(preprocessed_path(source_id))


def stringify(value) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    return str(value)


# ---- classification logic --------------------------------------------------

def present_columns(df, target: str) -> list:
    return [c for c in TARGETS[target]["source_columns"] if c in df.columns]


def unique_combos(df, columns: list) -> list:
    """[{"values": {col: str, ...}, "count": n}, ...], sorted by count desc."""
    if not columns:
        return []
    stringified = df[columns].apply(lambda col: col.map(stringify))
    counted = stringified.value_counts().reset_index(name="count")
    combos = [
        {"values": {c: row[c] for c in columns}, "count": int(row["count"])}
        for _, row in counted.iterrows()
    ]
    combos.sort(key=lambda c: -c["count"])
    return combos


def find_mapping(mappings: list, columns: list, values: dict):
    for m in mappings:
        if all(m["values"].get(c, "") == values.get(c, "") for c in columns):
            return m
    return None


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
        field = get_field(TARGET_SCHEMA_PATH, target)
    except ValueError:
        return None
    return field.get("enum")


def target_status(source_id: str, df, target: str) -> str:
    columns = present_columns(df, target)
    if not columns:
        return "not_applicable"
    combos = unique_combos(df, columns)
    if not combos:
        return "not_applicable"
    mappings = load_classification_map(source_id).get(target, {}).get("mappings", [])
    if not mappings:
        return "not_started"
    covered = sum(1 for combo in combos if find_mapping(mappings, columns, combo["values"]))
    return "complete" if covered == len(combos) else "needs_review"


# ---- routes -----------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/review.html")
def review_page():
    return send_from_directory(app.static_folder, "review.html")


@app.route("/api/sources")
def api_sources():
    result = []
    for source_id in source_ids():
        if not preprocessed_path(source_id).exists():
            result.append({"source_id": source_id, "has_preprocessed_data": False, "targets": {}})
            continue
        df = load_preprocessed(source_id)
        result.append({
            "source_id": source_id,
            "has_preprocessed_data": True,
            "targets": {name: target_status(source_id, df, name) for name in TARGETS},
        })
    return jsonify(result)


@app.route("/api/classification/<source_id>")
def api_classification_get(source_id):
    if not preprocessed_path(source_id).exists():
        return jsonify({"error": f"no preprocessed data for {source_id} — run 'lode pipeline preprocessing' first"}), 404

    df = load_preprocessed(source_id)
    saved = load_classification_map(source_id)

    targets = {}
    for target, target_config in TARGETS.items():
        columns = present_columns(df, target)
        options = target_options(target)
        street_view = bool(target_config.get("street_view", False))

        if not columns:
            targets[target] = {"source_columns": [], "options": options, "street_view": street_view, "groups": []}
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

        targets[target] = {"source_columns": columns, "options": options, "street_view": street_view, "groups": groups}

    return jsonify({"source_id": source_id, "targets": targets})


@app.route("/api/classification/<source_id>", methods=["POST"])
def api_classification_save(source_id):
    data = request.get_json()
    target = data.get("target")
    values = data.get("values")
    target_value = (data.get("target_value") or "").strip()
    method = data.get("method") or "manual"
    notes = (data.get("notes") or "").strip()

    if target not in TARGETS:
        return jsonify({"error": f"unknown target '{target}'"}), 400
    if not values:
        return jsonify({"error": "values required"}), 400
    if not target_value:
        return jsonify({"error": "target_value required"}), 400

    columns = TARGETS[target]["source_columns"]
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


@app.route("/api/config")
def api_config():
    any_street_view = any(t.get("street_view") for t in TARGETS.values())
    mock = bool(STREET_VIEW_CONFIG.get("mock", True))
    return jsonify({
        "street_view_enabled": any_street_view,
        "mock": mock,
        "maps_api_key": (os.environ.get("GOOGLE_MAPS_API_KEY") or None) if (any_street_view and not mock) else None,
        "n_samples": STREET_VIEW_CONFIG.get("n_samples", 3),
        "not_included_value": NOT_INCLUDED,
    })


@app.route("/api/sample_points/<source_id>", methods=["POST"])
def api_sample_points(source_id):
    data = request.get_json()
    target = data.get("target")
    values = data.get("values") or {}
    fresh = bool(data.get("fresh"))

    if target not in TARGETS:
        return jsonify({"error": f"unknown target '{target}'"}), 400
    if not preprocessed_path(source_id).exists():
        return jsonify({"error": f"no preprocessed data for {source_id}"}), 404

    df = load_preprocessed(source_id)
    columns = present_columns(df, target)
    mask = pd.Series(True, index=df.index)
    for c in columns:
        mask &= df[c].map(stringify) == values.get(c, "")
    subset = df[mask]

    n_samples = STREET_VIEW_CONFIG.get("n_samples", 3)
    n_reserve = STREET_VIEW_CONFIG.get("n_reserve", 5)
    # A fresh request (the review UI's "Regenerate" once its spare points are
    # used up) ignores the configured seed so it actually gets a new draw —
    # otherwise every call for the same group/subset would be identical.
    seed = None if fresh else STREET_VIEW_CONFIG.get("seed")
    points = sample_points(subset, n_samples + n_reserve, seed=seed)

    return jsonify({
        "n_features": int(len(subset)),
        "points": points[:n_samples],
        "spare_points": points[n_samples:],
    })


def main(argv=None):
    app.run(debug=True, port=8646)


if __name__ == "__main__":
    main()
