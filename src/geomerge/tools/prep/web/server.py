#!/usr/bin/env python3
"""Dedicated launching pad for the two "prep" tools — column mapping and
classification — that were previously only reachable by clicking a cell in
geomerge serve's dense all-stages table, which opens a new browser tab per
click. This page is its own tab in the nav bar instead: one table scoped to
just these two stages (plus preprocessing between them — mechanical, no
review UI, but classification depends on its output), same-tab links, so
working through many sources in a row doesn't pile up tabs. The per-source
tools themselves (column-mapping/, classification/) are unchanged — this
only changes how you get to them.

Mounted under geomerge serve at /prep/ — see geomerge.tools.home.web.server.
"""

from pathlib import Path

from flask import Blueprint, jsonify, render_template

from geomerge.helpers.config import load_config
from geomerge.pipeline.status import preprocessing_status
from geomerge.tools.classification.status import source_status as classification_status
from geomerge.tools.column_mapping.status import source_status as column_mapping_status


def classification_overall(cls: dict) -> str:
    # Same rollup as geomerge serve: complete only if every *applicable*
    # target is complete — a source with nothing to classify isn't
    # "incomplete", it's not_applicable itself.
    applicable = [s for s in cls["targets"].values() if s != "not_applicable"]
    if not applicable:
        return "not_applicable"
    if all(s == "complete" for s in applicable):
        return "complete"
    return "not_complete"


def create_blueprint(config: dict = None) -> Blueprint:
    config = config or load_config()
    repo_root = config["repo_root"]
    sources_dir = repo_root / config["sources_dir"]

    bp = Blueprint(
        "prep", __name__,
        static_folder=str(Path(__file__).parent), static_url_path="",
        template_folder="templates",
    )

    def source_ids() -> list:
        if not sources_dir.is_dir():
            return []
        return sorted(p.name for p in sources_dir.iterdir() if p.is_dir())

    @bp.route("/")
    def index():
        return render_template("prep/index.html", active_tab="prepare", include_source_card=True)

    @bp.route("/api/sources")
    def api_sources():
        result = []
        for source_id in source_ids():
            cm = column_mapping_status(source_id, config)
            cls = classification_status(source_id, config)
            result.append({
                "source_id": source_id,
                "column_mapping": cm["column_map_status"],
                # For the footer's "N flagged" stat (app.js) — column mapping's
                # own "revisit later" flag (see column_mapping/status.py).
                # Classification has no equivalent flag feature yet; app.js
                # ORs this against a classification_flagged field that simply
                # doesn't exist yet, so adding one later needs no rework here.
                "column_mapping_flagged": cm["flagged"],
                # Mechanical, no review UI of its own — but classification
                # can't run without it (it reads the standardized columns
                # preprocessing produces, not raw ones), so it sits between
                # the two review steps here rather than off in pipeline/.
                "preprocessing": preprocessing_status(source_id, config),
                "classification": classification_overall(cls),
            })
        return jsonify(result)

    return bp
