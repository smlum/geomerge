#!/usr/bin/env python3
"""Explore tab — read-only views over the merged pipeline output
(geomerge.config.yaml's explore block; plan in WORKFLOW.md §7). One
top-level tab with sub-views: Overview is built; Map and Table are planned
(shown disabled in the sub-nav), Compare will be its own tab.

Every endpoint takes optional filters as plain query params, one per
geography column (e.g. ?source_id=on_ottawa_cycling or
?provider_province=QC) — the same params the page keeps in its own URL, so
any filtered view can be bookmarked or linked to (the source card links to
?source_id=...).

Mounted under geomerge serve at /explore/ — see geomerge.tools.home.web.server.
"""

from pathlib import Path

from flask import Blueprint, jsonify, render_template, request

from geomerge.helpers.config import load_config
from geomerge.tools.explore import overview


def create_blueprint(config: dict = None) -> Blueprint:
    config = config or load_config()
    explore = overview.explore_config(config)
    length = explore.get("length_field", "length_km")
    primary = explore.get("primary_field")
    geographies = explore.get("geographies", [])
    # Extra "By" options that aren't filterable geographies — e.g. the raw
    # source_class, which is what a single source's breakdown drills to.
    detail_columns = explore.get("detail_columns", [])
    filterable = [g["column"] for g in geographies]

    bp = Blueprint(
        "explore", __name__,
        static_folder=str(Path(__file__).parent), static_url_path="",
        template_folder="templates",
    )

    # Whole-page payloads keyed by filter set, dropped wholesale when the
    # merged file changes (its mtime) — a fresh merge shows up on the next
    # page load, no restart.
    summary_cache = {"stamp": None, "by_filters": {}}

    def request_filters() -> dict:
        return {c: request.args[c] for c in filterable if request.args.get(c)}

    def filtered_frame(filters: dict):
        df = overview.load_frame(config)
        kinds = overview.field_kinds(config, df)
        return overview.apply_filters(df, filters), kinds

    def missing_data_error():
        path = overview.data_path(config)
        if path.exists():
            return None
        rel = path.relative_to(config["repo_root"])
        return jsonify({"error": f"{rel} doesn't exist yet — run 'geomerge pipeline run' to build it."}), 404

    def no_rows_error(filters: dict):
        shown = ", ".join(f"{k} = {v}" for k, v in filters.items())
        return jsonify({"error": f"No rows match {shown}.", "filters": filters}), 404

    @bp.route("/")
    def index():
        return render_template("explore/overview.html", active_tab="explore", include_source_card=True)

    @bp.route("/api/overview")
    def api_overview():
        if (err := missing_data_error()):
            return err
        path = overview.data_path(config)
        stamp = path.stat().st_mtime_ns
        if summary_cache["stamp"] != stamp:
            summary_cache.update({"stamp": stamp, "by_filters": {}})

        filters = request_filters()
        key = tuple(sorted(filters.items()))
        if key not in summary_cache["by_filters"]:
            df, kinds = filtered_frame(filters)
            if df.empty:
                return no_rows_error(filters)
            summary_cache["by_filters"][key] = {
                "data_path": str(path.relative_to(config["repo_root"])),
                "data_modified": path.stat().st_mtime,
                "length_field": length,
                "primary_field": primary,
                "filters": filters,
                "geographies": [g for g in geographies if g["column"] in df.columns],
                "detail_columns": [d for d in detail_columns if d["column"] in df.columns],
                "fields": [{"name": f["name"], "kind": f["kind"]} for f in kinds if f["kind"] == "categorical"],
                "headline": overview.headline(df, length, primary),
                "sources": overview.sources_table(df, length, primary),
                "profile": overview.column_profile(df, kinds, length),
            }
        return jsonify(summary_cache["by_filters"][key])

    @bp.route("/api/breakdown")
    def api_breakdown():
        if (err := missing_data_error()):
            return err
        filters = request_filters()
        df, kinds = filtered_frame(filters)
        if df.empty:
            return no_rows_error(filters)
        geo = request.args.get("geo") or (filterable[0] if filterable else "source_id")
        allowed_by = filterable + [d["column"] for d in detail_columns]
        if geo not in allowed_by:
            return jsonify({"error": f"can't break down by '{geo}' (options: {', '.join(allowed_by)})"}), 400
        field = request.args.get("field") or primary
        try:
            colors = (explore.get("colors") or {}).get(field)
            return jsonify(overview.breakdown(df, kinds, geo, field, length, colors))
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

    return bp
