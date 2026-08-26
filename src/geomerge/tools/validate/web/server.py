#!/usr/bin/env python3
"""Dedicated tab for the validation stage — split out from pipeline/ (which
now covers processing only) so each mechanical pipeline stage gets its own
tab/page, same model as prep/ for column mapping/classification. No
automated-check step exists yet (geomerge.config.yaml's "validate" stage is
still commented out), so every source just shows the same "not_built"
placeholder for now — this page exists so there's a place for that status
to live and grow into real checks/logs later, rather than being wired up
retroactively.

Mounted under geomerge serve at /validate/ — see geomerge.tools.home.web.server.
Named geomerge.tools.validate (a web tool, under tools/) rather than a
top-level geomerge.pipeline.validate stage-runner name, same reasoning as
geomerge.tools.pipeline — this module only reads status.
"""

from pathlib import Path

from flask import Blueprint, jsonify, send_from_directory

from geomerge.helpers.config import load_config


def create_blueprint(config: dict = None) -> Blueprint:
    config = config or load_config()
    repo_root = config["repo_root"]
    sources_dir = repo_root / config["sources_dir"]

    bp = Blueprint("validate_tab", __name__, static_folder=str(Path(__file__).parent), static_url_path="")

    def source_ids() -> list:
        if not sources_dir.is_dir():
            return []
        return sorted(p.name for p in sources_dir.iterdir() if p.is_dir())

    @bp.route("/")
    def index():
        return send_from_directory(bp.static_folder, "index.html")

    @bp.route("/api/sources")
    def api_sources():
        result = []
        for source_id in source_ids():
            result.append({
                "source_id": source_id,
                # Placeholder — no automated-check step exists yet
                # (geomerge.config.yaml's "validate" stage is still commented
                # out) — "not_built" rather than "not_started" so it doesn't
                # read as "you have work to do" when the real answer is
                # "there's nothing here yet". Same as home's dashboard.
                "validation": "not_built",
            })
        return jsonify(result)

    return bp
