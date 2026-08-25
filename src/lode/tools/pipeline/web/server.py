#!/usr/bin/env python3
"""Dedicated tab for the mechanical pipeline stages (processing, validation)
— same "own tab" model as prep/ for column mapping/classification. Doesn't
do much yet: no review UI exists for these stages (they're mechanical, no
human decisions), so this is just a scoped table + a copy-command badge for
processing, matching how home's dashboard already treats it. Room to grow
into showing sub-stage steps, logs, etc. later.

Mounted under lode tools home at /pipeline/ — see lode.tools.home.web.server.
Named lode.tools.pipeline (a web tool, under tools/) rather than reusing the
top-level lode.pipeline package name (the actual stage runner) to keep the
two distinct — this module only reads status, same as every other tool's
own status.py.
"""

from pathlib import Path

from flask import Blueprint, jsonify, send_from_directory

from lode.helpers.config import load_config
from lode.pipeline.status import processing_status


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
                # Placeholder — no automated-check step exists yet
                # (lode.config.yaml's "validate" stage is still commented
                # out) — "not_built" rather than "not_started" so it doesn't
                # read as "you have work to do" when the real answer is
                # "there's nothing here yet". Same as home's dashboard.
                "validation": "not_built",
            })
        return jsonify(result)

    return bp
