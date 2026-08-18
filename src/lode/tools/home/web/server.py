#!/usr/bin/env python3
"""Single entry point for every lode tools/ web UI: a status dashboard (one
row per source, one column per manual pipeline stage, each cell a status
badge linking into that stage's own tool for that source) with every tool
mounted underneath it at its own path prefix, all under one process/port.

Status is read directly from the same files each tool already reads
(metadata.yaml, column_map.yaml, classification_map.yaml, the preprocessed
parquet) via each tool's status.py — not by calling the mounted tools over
HTTP — so the dashboard is accurate regardless of which tool page you
actually have open.

Usage:
    lode tools home
Then open http://localhost:8640
    http://localhost:8640/collection/
    http://localhost:8640/column-mapping/
    http://localhost:8640/classification/
"""

from pathlib import Path

from flask import Flask, jsonify, send_from_directory

from lode.helpers.config import load_config
from lode.pipeline.status import preprocessing_status, processing_status
from lode.tools.classification.status import source_status as classification_status
from lode.tools.classification.web.server import create_blueprint as create_classification_blueprint
from lode.tools.collection.status import checklist_summary, source_metadata_status
from lode.tools.collection.web.server import create_blueprint as create_collection_blueprint
from lode.tools.column_mapping.status import source_status as column_mapping_status
from lode.tools.column_mapping.web.server import create_blueprint as create_column_mapping_blueprint


def create_app(config: dict = None) -> Flask:
    config = config or load_config()
    repo_root = config["repo_root"]
    sources_dir = repo_root / config["sources_dir"]

    app = Flask(__name__, static_folder=str(Path(__file__).parent), static_url_path="")
    app.register_blueprint(create_collection_blueprint(config), url_prefix="/collection")
    app.register_blueprint(create_column_mapping_blueprint(config), url_prefix="/column-mapping")
    app.register_blueprint(create_classification_blueprint(config), url_prefix="/classification")

    def source_ids() -> list:
        if not sources_dir.is_dir():
            return []
        return sorted(p.name for p in sources_dir.iterdir() if p.is_dir())

    @app.route("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.route("/api/sources")
    def api_sources():
        result = []
        for source_id in source_ids():
            cm = column_mapping_status(source_id, config)
            cls = classification_status(source_id, config)

            # One column, not one per target attribute: complete only if
            # every *applicable* target is complete. not_applicable targets
            # (e.g. this source has no source_snow_removal column at all)
            # don't count against it — a source with nothing to classify
            # isn't "incomplete", it's not_applicable itself.
            applicable = [s for s in cls["targets"].values() if s != "not_applicable"]
            if not applicable:
                classification_overall = "not_applicable"
            elif all(s == "complete" for s in applicable):
                classification_overall = "complete"
            else:
                classification_overall = "not_complete"

            result.append({
                "source_id": source_id,
                # tools/ — human-reviewed decisions, each with its own web UI.
                "tools": {
                    "metadata": source_metadata_status(source_id, config),
                    "column_mapping": cm["column_map_status"],
                    "classification": classification_overall,
                },
                # pipeline/ — mechanical processing driven by those decisions;
                # no review UI, just "has it run, is it stale". Validation is
                # a placeholder — no automated-check step exists yet
                # (lode.config.yaml's "validate" stage is still commented
                # out) — "not_built" rather than "not_started" so it doesn't
                # read as "you have work to do" when the real answer is
                # "there's nothing here yet".
                "pipeline": {
                    "preprocessing": preprocessing_status(source_id, config),
                    "processing": processing_status(source_id, config),
                    "validation": "not_built",
                },
            })
        return jsonify(result)

    @app.route("/api/summary")
    def api_summary():
        return jsonify({"checklist": checklist_summary(config)})

    return app


def main(argv=None):
    create_app().run(debug=True, port=8640)


if __name__ == "__main__":
    main()
