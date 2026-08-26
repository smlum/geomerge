#!/usr/bin/env python3
"""Dedicated tab for the mechanical processing stage — same "own tab" model
as prep/ for column mapping/classification, and validate/ for the validation
stage (split into its own tab/page, not shown here). Doesn't do much yet: no
review UI exists for this stage (it's mechanical, no human decisions), so
this is just a scoped table + a copy-command badge, matching how home's
dashboard already treats it. Room to grow into showing sub-stage steps,
logs, etc. later.

Mounted under geomerge serve at /pipeline/ — see geomerge.tools.home.web.server.
Named geomerge.tools.pipeline (a web tool, under tools/) rather than reusing the
top-level geomerge.pipeline package name (the actual stage runner) to keep the
two distinct — this module only reads status, same as every other tool's
own status.py.
"""

from pathlib import Path

from flask import Blueprint, jsonify, send_from_directory

from geomerge.helpers.config import load_config
from geomerge.pipeline.status import processing_status


def create_blueprint(config: dict = None) -> Blueprint:
    config = config or load_config()
    repo_root = config["repo_root"]
    sources_dir = repo_root / config["sources_dir"]

    bp = Blueprint("pipeline_tab", __name__, static_folder=str(Path(__file__).parent), static_url_path="")

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
                "processing": processing_status(source_id, config),
            })
        return jsonify(result)

    return bp
