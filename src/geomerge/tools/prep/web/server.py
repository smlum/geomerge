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
from urllib.parse import quote

from flask import Blueprint, jsonify, render_template

from geomerge.helpers.config import load_config
from geomerge.helpers.source_notes import source_markers
from geomerge.helpers.status import COMPLETE, classification_overall
from geomerge.pipeline.status import preprocessing_status
from geomerge.tools.classification.status import review_markers
from geomerge.tools.classification.status import source_status as classification_status
from geomerge.tools.column_mapping.status import source_status as column_mapping_status


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

    def blocked_reason(source_id: str, cm: dict, markers: dict, preprocessing: str):
        """Why classification can't start yet, or None — the same gates as
        classification/status.py's is_eligible(), in pipeline order, so the
        earliest stage holding things up is the one reported. Without this,
        a blocked source's classification just read "not applicable",
        indistinguishable from a source with genuinely nothing to classify.
        A flag never blocks (it only means something needs doing)."""
        sid = quote(source_id)
        if markers["excluded"]:
            return {"stage": "Home", "reason": "Excluded from pipeline", "note": markers["notes"],
                    "href": "/"}
        if cm["column_map_status"] != COMPLETE:
            return {"stage": "Map", "reason": "Column mapping isn't complete", "note": "",
                    "href": f"/column-mapping/map.html?id={sid}"}
        if preprocessing != COMPLETE:
            return {"stage": "Preprocess", "reason": f"Preprocessing is {preprocessing.replace('_', ' ')}",
                    "note": "", "href": "", "command": f"geomerge pipeline preprocessing --source {source_id}"}
        return None

    @bp.route("/api/sources")
    def api_sources():
        result = []
        for source_id in source_ids():
            cm = column_mapping_status(source_id, config)
            cls = classification_status(source_id, config)
            mapping_markers = review_markers(source_id, config)
            markers = source_markers(source_id, config)
            preprocessing = preprocessing_status(source_id, config)
            blocked = blocked_reason(source_id, cm, markers, preprocessing)
            result.append({
                "source_id": source_id,
                "column_mapping": cm["column_map_status"],
                # The source's one shared note/flag/exclude switch
                # (metadata.yaml, helpers/source_notes.py) — not per stage.
                "source_notes": markers["notes"],
                "source_flagged": markers["flagged"],
                "source_excluded": markers["excluded"],
                # Per-mapping review flags left during classification.
                "classification_flag_counts": mapping_markers["flag_counts"],
                # Mechanical, no review UI of its own — but classification
                # can't run without it (it reads the standardized columns
                # preprocessing produces, not raw ones), so it sits between
                # the two review steps here rather than off in pipeline/.
                "preprocessing": preprocessing,
                # "blocked" (a prep-page-only display state, not one of
                # classification's own statuses) whenever blocked_reason applies.
                "classification": "blocked" if blocked else classification_overall(cls["targets"]),
                "blocked": blocked,
            })
        return jsonify(result)

    return bp
