#!/usr/bin/env python3
"""Local web UI for classifying each source's raw values onto the harmonized
target schema (schema/ccnd.yaml). Same shape as column_mapping (list of
sources -> per-source review page), but the review unit is a raw *value*
combination rather than a raw column, and results are saved to
sources/<source_id>/classification_map.yaml.

Which raw column(s) feed which target attribute, and which targets get the
Street View sampling helper, are config-driven — see geomerge.config.yaml's
tools.classification.targets. A source missing some of a target's columns
just reviews on whichever it has (see status.present_columns()); a target
with none of its columns present for a source is marked not_applicable, not
missing.

The rule-based first-pass suggestion only ever looks at the *first* configured
column for a target (e.g. source_class for canbics_class) — combining several
free-text columns automatically is fragile, so the others are shown as
context for the human to weigh instead, alongside Street View if enabled.

Mounted under geomerge serve at /classification/ — see geomerge.tools.home.web.server.
"""

import os
from pathlib import Path

import pandas as pd
import yaml
from dotenv import load_dotenv
from flask import Blueprint, jsonify, redirect, render_template, request

from geomerge.helpers.config import load_config
from geomerge.helpers.constants import IGNORED, NOT_INCLUDED, REVIEW_FLAGS
from geomerge.helpers.geo_sampling import sample_points
from geomerge.helpers.matching import match_name, normalize
from geomerge.helpers.schema import get_field
from geomerge.tools.classification.prior_year import prior_year_lookup
from geomerge.tools.classification.status import (
    columns_and_combos,
    find_mapping,
    is_eligible,
    load_yaml,
    preprocessed_path,
    present_columns,
    source_status,
    stringify,
)


def create_blueprint(config: dict = None) -> Blueprint:
    config = config or load_config()
    repo_root = config["repo_root"]
    # .env lives at the project root (beside geomerge.config.yaml), not inside the
    # geomerge/ submodule — it's this project's local secret, not geomerge's. Explicit
    # path rather than load_dotenv()'s cwd-search default, so it works the same
    # regardless of where this is launched from.
    load_dotenv(repo_root / ".env")

    sources_dir = repo_root / config["sources_dir"]
    target_schema_path = repo_root / config["target_schema"]

    tool_config = config["tools"]["classification"]
    targets = tool_config["targets"]  # {name: {source_columns: [...], street_view: bool}}
    matching_rules_path = repo_root / tool_config["matching_rules"]
    street_view_config = tool_config.get("street_view", {})
    prior_year_dictionary_config = tool_config.get("prior_year_dictionary")

    bp = Blueprint(
        "classification", __name__,
        static_folder=str(Path(__file__).parent), static_url_path="",
        template_folder="templates",
    )

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
        # ccnd.yaml's categorical fields are schema/ccnd.yaml's `categories`
        # (a list of {code, label, description} — see geomerge.tools.setup),
        # not a bare list of strings — the review UI still just wants the
        # codes (what's actually saved to classification_map.yaml), so this
        # unpacks that shape rather than showing every source_column/tool a
        # richer object it doesn't need.
        try:
            field = get_field(target_schema_path, target)
        except ValueError:
            return None
        categories = field.get("categories")
        if categories is None:
            return None
        return [c["code"] for c in categories]

    # No list-of-sources page here — geomerge serve's table replaced it and
    # links straight into review.html for a given source. / just bounces
    # back there so a bookmarked/typed URL still lands somewhere useful.
    @bp.route("/")
    def index():
        return redirect("/")

    @bp.route("/review.html")
    def review_page():
        return render_template("classification/review.html", active_tab="prepare", include_source_card=True)

    # Used by review.js's "Next source" button to find the next one that
    # still needs work — not a list-of-sources page (that's home's job now).
    @bp.route("/api/sources")
    def api_sources():
        return jsonify([{"source_id": source_id, **source_status(source_id, config)} for source_id in source_ids()])

    @bp.route("/api/classification/<source_id>")
    def api_classification_get(source_id):
        if not preprocessed_path(source_id, config).exists():
            return jsonify({"error": f"no preprocessed data for {source_id} — run 'geomerge pipeline preprocessing' first"}), 404
        if not is_eligible(source_id, config):
            return jsonify({
                "error": f"{source_id} is flagged, or column mapping/preprocessing isn't complete yet — "
                         "resolve that before classifying"
            }), 409

        saved = load_classification_map(source_id)

        # The prior-year match is both the first suggestion and a visual
        # review cue. It's only meaningful for the configured target and is
        # matched against that target's first source column.
        prior_year_target = (prior_year_dictionary_config or {}).get("target")
        prior_year_map = prior_year_lookup(source_id, config) if prior_year_target else {}

        result = {}
        for target, target_config in targets.items():
            columns, combos = columns_and_combos(source_id, target, config)
            options = target_options(target)
            street_view = bool(target_config.get("street_view", False))

            if not columns:
                result[target] = {"source_columns": [], "options": options, "street_view": street_view, "groups": []}
                continue

            mappings = saved.get(target, {}).get("mappings", [])
            show_prior_year = target == prior_year_target
            groups = []
            for combo in combos:
                prior_year_match = prior_year_map.get(normalize(combo["values"].get(columns[0], ""))) if show_prior_year else None
                existing = find_mapping(mappings, columns, combo["values"])
                if existing:
                    groups.append({
                        "values": combo["values"],
                        "count": combo["count"],
                        "target": existing["target"],
                        "method": existing.get("method", "manual"),
                        "notes": existing.get("notes", ""),
                        "flag": existing.get("flag", ""),
                        "confidence": "saved",
                        "prior_year_match": prior_year_match,
                    })
                    continue
                if (
                    prior_year_match
                    and prior_year_match["value"]
                    and (options is None or prior_year_match["value"] in options)
                ):
                    suggested, confidence = prior_year_match["value"], "prior_year"
                else:
                    suggested, confidence = suggest_target(target, columns, combo["values"])
                groups.append({
                    "values": combo["values"],
                    "count": combo["count"],
                    "target": suggested,
                    "method": "rule" if suggested else None,
                    "notes": "",
                    "flag": "",
                    "confidence": confidence,
                    "prior_year_match": prior_year_match,
                })

            result[target] = {
                "source_columns": columns,
                "options": options,
                "street_view": street_view,
                "show_prior_year": show_prior_year,
                "groups": groups,
            }

        return jsonify({"source_id": source_id, "source_notes": saved.get("notes", ""), "targets": result})

    # Bulk save — every row of the currently-open tab's table in one request,
    # same "single save button at bottom" model as column_mapping's map.js
    # rather than each row auto-saving itself on its own click. "entries" is
    # a list of {values, target_value, method, notes, flag}; a row the reviewer
    # left blank is simply omitted by the client rather than sent with an
    # empty target_value, so this endpoint doesn't need to distinguish
    # "explicitly cleared" from "never touched" — see review.js's save flow.
    # "source_notes", when present, replaces the file's top-level `notes`, and
    # can be sent without any entries.
    @bp.route("/api/classification/<source_id>", methods=["POST"])
    def api_classification_save(source_id):
        if not is_eligible(source_id, config):
            return jsonify({"error": f"{source_id} is flagged, or column mapping/preprocessing isn't complete yet"}), 409

        data = request.get_json()
        target = data.get("target")
        entries = data.get("entries") or []

        if not entries and "source_notes" not in data:
            return jsonify({"error": "entries or source_notes required"}), 400
        if entries and target not in targets:
            return jsonify({"error": f"unknown target '{target}'"}), 400
        for item in entries:
            flag = item.get("flag")
            if flag and flag not in REVIEW_FLAGS:
                return jsonify({"error": f"unknown flag '{flag}'"}), 400

        saved = load_classification_map(source_id)

        if "source_notes" in data:
            source_notes = (data["source_notes"] or "").strip()
            saved.pop("notes", None)
            if source_notes:
                # First in the file, above the per-target sections.
                saved = {"notes": source_notes, **saved}

        if entries:
            columns = targets[target]["source_columns"]
            target_entry = saved.setdefault(target, {"source_columns": columns, "mappings": []})
            target_entry["source_columns"] = columns

            for item in entries:
                values = item.get("values")
                target_value = (item.get("target_value") or "").strip()
                method = item.get("method") or "manual"
                notes = (item.get("notes") or "").strip()
                flag = item.get("flag")
                if not values or not target_value:
                    continue

                entry = {"values": values, "target": target_value, "method": method}
                if flag:
                    entry["flag"] = flag
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
            "ignored_value": IGNORED,
            "review_flags": list(REVIEW_FLAGS),
            "prior_year_dictionary_target": (prior_year_dictionary_config or {}).get("target"),
            "prior_year_dictionary_label": (prior_year_dictionary_config or {}).get("label"),
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

    # The raw file text — for geomerge serve's read-only classification_map.yaml
    # preview modal, same pattern as collection's /api/source/<id>/raw.
    @bp.route("/api/classification/<source_id>/raw")
    def api_classification_get_raw(source_id):
        path = classification_map_path(source_id)
        if not path.exists():
            return jsonify({"error": f"{path.name} hasn't been created yet — nothing saved for this source yet."}), 404
        return jsonify({"content": path.read_text(), "path": str(path.relative_to(repo_root))})

    return bp
