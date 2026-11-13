#!/usr/bin/env python3
"""Single entry point for every geomerge tools/ web UI: a status dashboard (one
row per source, one column per manual pipeline stage, each cell a status
badge linking into that stage's own tool for that source) with every tool
mounted underneath it at its own path prefix, all under one process/port.

Status is read directly from the same files each tool already reads
(metadata.yaml, column_map.yaml, classification_map.yaml, the preprocessed
parquet) via each tool's status.py — not by calling the mounted tools over
HTTP — so the dashboard is accurate regardless of which tool page you
actually have open.

Usage:
    geomerge serve
Then open http://localhost:8640
    http://localhost:8640/setup/
    http://localhost:8640/collection/
    http://localhost:8640/prep/
    http://localhost:8640/pipeline/
    http://localhost:8640/validate/
    http://localhost:8640/column-mapping/
    http://localhost:8640/classification/
"""

from pathlib import Path

import yaml
from flask import Flask, abort, jsonify, render_template, request, send_from_directory
from jinja2 import ChoiceLoader, FileSystemLoader

from geomerge.helpers.config import load_config
from geomerge.helpers.nav import NAV_TABS
from geomerge.helpers.file_cache import cached_yaml
from geomerge.helpers.source_notes import (
    FLAG_STATUSES,
    flag_reasons,
    metadata_path,
    source_markers,
    update_source_markers,
)
from geomerge.helpers.status import NOT_BUILT
from geomerge.helpers.status import classification_overall as classification_overall_status
from geomerge.pipeline.status import preprocessing_status, processing_status
from geomerge.tools.classification.status import review_markers
from geomerge.tools.classification.status import source_status as classification_status
from geomerge.tools.classification.web.server import create_blueprint as create_classification_blueprint
from geomerge.tools.collection.status import (
    flagged_providers,
    provider_row,
    source_metadata_status,
    source_raw_data_status,
)
from geomerge.tools.collection.web.server import create_blueprint as create_collection_blueprint
from geomerge.tools.column_mapping.status import source_status as column_mapping_status
from geomerge.tools.column_mapping.web.server import create_blueprint as create_column_mapping_blueprint
from geomerge.tools.explore.web.server import create_blueprint as create_explore_blueprint
from geomerge.tools.pipeline.web.server import create_blueprint as create_pipeline_blueprint
from geomerge.tools.prep.web.server import create_blueprint as create_prep_blueprint
from geomerge.tools.setup.web.server import create_blueprint as create_setup_blueprint
from geomerge.tools.validate.web.server import create_blueprint as create_validate_blueprint


def create_app(config: dict = None) -> Flask:
    config = config or load_config()
    repo_root = config["repo_root"]
    sources_dir = repo_root / config["sources_dir"]

    home_web_dir = Path(__file__).parent
    shared_web_dir = home_web_dir.parent.parent.parent / "shared" / "web"

    # static_folder/template_folder=None disables Flask's own automatic
    # handling for both — every other tool's page needs assets from
    # shared/web/ (nav.css, page-shell.css, base.html, ...) reachable at
    # plain root-relative URLs like /nav.css, and home's own app.js/style.css
    # need the same treatment, so both directories have to resolve through
    # one merged mechanism at "/" rather than Flask's single static_folder.
    # static_files() and the ChoiceLoader below are that mechanism — same
    # "try each in order, first match wins" shape Flask already uses to
    # merge every blueprint's own template_folder, just written out by hand
    # since Flask has no equivalent built-in for static files.
    app = Flask(__name__, static_folder=None, template_folder=None)
    app.jinja_loader = ChoiceLoader([
        FileSystemLoader(str(shared_web_dir / "templates")),
        FileSystemLoader(str(home_web_dir / "templates")),
    ])

    @app.route("/<path:filename>")
    def static_files(filename):
        for base_dir in (shared_web_dir, home_web_dir):
            if (base_dir / filename).is_file():
                return send_from_directory(base_dir, filename)
        abort(404)

    # Project-level, not per-source — no status.py, no /api/sources entry below.
    app.register_blueprint(create_setup_blueprint(config), url_prefix="/setup")
    app.register_blueprint(create_collection_blueprint(config), url_prefix="/collection")
    app.register_blueprint(create_prep_blueprint(config), url_prefix="/prep")
    app.register_blueprint(create_pipeline_blueprint(config), url_prefix="/pipeline")
    app.register_blueprint(create_validate_blueprint(config), url_prefix="/validate")
    # Read-only views over the merged output — not per-source either.
    app.register_blueprint(create_explore_blueprint(config), url_prefix="/explore")
    app.register_blueprint(create_column_mapping_blueprint(config), url_prefix="/column-mapping")
    app.register_blueprint(create_classification_blueprint(config), url_prefix="/classification")

    # Available in every template rendered anywhere in the app (base.html's
    # nav loop, in every tool's own blueprint) without each tool having to
    # pass it into its own render_template() call.
    @app.context_processor
    def inject_nav_tabs():
        return {"nav_tabs": NAV_TABS}

    def source_ids() -> list:
        if not sources_dir.is_dir():
            return []
        return sorted(p.name for p in sources_dir.iterdir() if p.is_dir())

    # Shared by /api/sources (every source, for the dashboard table) and
    # /api/source_info/<id> (one source, for the cross-page source-card
    # modal — see /source-card.js) so the two never drift out of sync on
    # what "status" means for a given stage.
    # Whether anyone's recorded who to ask — the source's own contact, or
    # its provider's in checklist.csv (the popout offers to copy that one
    # over). Turns a "contact" follow-up into "find contact" (app.js).
    def has_contact(source_id: str) -> bool:
        metadata = cached_yaml(metadata_path(source_id, config)) or {}
        if (metadata.get("contact") or "").strip():
            return True
        return bool((provider_row(metadata.get("provider_id"), config).get("contact") or "").strip())

    def source_row(source_id: str) -> dict:
        cm = column_mapping_status(source_id, config)
        cls = classification_status(source_id, config)

        return {
            "source_id": source_id,
            # The source's one shared note/flag/exclude switch (metadata.yaml,
            # helpers/source_notes.py), plus how many per-class notes it has —
            # for the Notes column and the Flagged filter (app.js).
            "markers": {
                **source_markers(source_id, config),
                "class_notes": len(review_markers(source_id, config)["notes"]),
                "has_contact": has_contact(source_id),
            },
            # collection/ — what the collection checklist tool produces:
            # metadata.yaml and the raw file landing on disk.
            "collection": {
                "metadata": source_metadata_status(source_id, config),
                "raw": source_raw_data_status(source_id, config),
                # For the raw pill's info modal (app.js) — reuses
                # column_mapping_status's own read of metadata.yaml rather
                # than a second one, since cm is already computed above.
                "raw_filename": cm["raw_filename"],
            },
            # tools/ (displayed as "Prep") — human-reviewed decisions
            # needed before the rest of the pipeline can run, plus
            # preprocessing itself: mechanical (no review UI of its own),
            # but it sits here rather than in pipeline/ below because
            # classification can't run without it — it reads the
            # standardized columns preprocessing produces, not raw ones.
            "tools": {
                "column_mapping": cm["column_map_status"],
                "preprocessing": preprocessing_status(source_id, config),
                "classification": classification_overall_status(cls["targets"]),
            },
            # pipeline/ — mechanical processing with no human decisions
            # of its own. Validation is a placeholder — no automated-
            # check step exists yet (geomerge.config.yaml's "validate" stage
            # is still commented out) — "not_built" rather than
            # "not_started" so it doesn't read as "you have work to do"
            # when the real answer is "there's nothing here yet".
            "pipeline": {
                "processing": processing_status(source_id, config),
                "validation": NOT_BUILT,
            },
        }

    @app.route("/")
    def index():
        # The project's flag reasons (geomerge.config.yaml) and the fixed
        # statuses, for the Notes pills, the popout's pickers and the filter.
        return render_template(
            "index.html", active_tab="home", include_source_card=True,
            flag_reasons=flag_reasons(config), flag_statuses=list(FLAG_STATUSES),
        )

    # Just the rows, so home's and prep's tables can draw immediately and fill
    # in the slower statuses from their own /api/sources afterwards.
    @app.route("/api/source_ids")
    def api_source_ids():
        return jsonify(source_ids())

    @app.route("/api/sources")
    def api_sources():
        return jsonify([source_row(source_id) for source_id in source_ids()])

    # Provider-level follow-ups (flagged checklist.csv rows) — shown as extra
    # rows under Home's Flagged filter, since most have no source yet (e.g.
    # "PDF only, contact them"). Edited through collection's own row-based
    # /api/note and /api/flag, so there's no save endpoint here.
    @app.route("/api/flagged_providers")
    def api_flagged_providers():
        return jsonify(flagged_providers(config))

    # Backs Home's notes popout: the source's shared note/flag/exclude switch,
    # plus its per-class notes from classification_map.yaml (read-only here —
    # they're edited in Classify, one per mapping).
    @app.route("/api/source_notes/<source_id>")
    def api_source_notes(source_id):
        if source_id not in source_ids():
            return jsonify({"error": "no such source"}), 404
        metadata_path = sources_dir / source_id / "metadata.yaml"
        metadata = yaml.safe_load(metadata_path.read_text()) or {} if metadata_path.exists() else {}
        provider = provider_row(metadata.get("provider_id"), config)
        return jsonify({
            **source_markers(source_id, config),
            "class_notes": review_markers(source_id, config)["notes"],
            "path": f"{config['sources_dir']}/{source_id}/metadata.yaml",
            # A few metadata.yaml fields for following up (where to look, who
            # to ask) — the full set stays in Collect's metadata modal.
            "details": {
                "dataset_page_url": metadata.get("dataset_page_url") or "",
                "portal_url": provider.get("portal_url", ""),
                "source_updated_date": str(metadata.get("source_updated_date") or ""),
                "license_name": metadata.get("license_name") or "",
                "license_url": metadata.get("license_url") or "",
                "open_license": metadata.get("open_license"),
                "contact": metadata.get("contact") or "",
                "provider_contact": provider.get("contact", ""),
            },
        })

    @app.route("/api/source_notes/<source_id>", methods=["POST"])
    def api_source_notes_save(source_id):
        if source_id not in source_ids():
            return jsonify({"error": "no such source"}), 404
        data = request.get_json() or {}
        marker_keys = ("notes", "flagged", "flag_reasons", "flag_status", "excluded")
        changes = {k: data[k] for k in marker_keys if k in data}
        if not changes and "contact" not in data:
            return jsonify({"error": f"{', '.join(marker_keys)} or contact required"}), 400
        try:
            result = update_source_markers(source_id, config, **changes) if changes else source_markers(source_id, config)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        if "contact" in data:
            # Same full-document read-modify-write as collection's own save.
            metadata_path = sources_dir / source_id / "metadata.yaml"
            metadata = yaml.safe_load(metadata_path.read_text()) or {}
            metadata["contact"] = (data["contact"] or "").strip()
            with open(metadata_path, "w") as f:
                yaml.dump(metadata, f, sort_keys=False, allow_unicode=True)
            result = {**result, "contact": metadata["contact"]}
        return jsonify(result)

    # Backs the cross-page source-card modal (/source-card.js) — a click on
    # a source id anywhere (home/prep's tables, column_mapping's header)
    # opens the same read-only summary: a few highlighted metadata.yaml
    # fields plus the same per-stage status source_row() already computes
    # for the dashboard, so the two are always consistent. Absolute path
    # (not under any one tool's url_prefix) since every page needs to reach
    # it regardless of which tool it's actually served from.
    @app.route("/api/source_info/<source_id>")
    def api_source_info(source_id):
        if source_id not in set(source_ids()):
            return jsonify({"error": "no such source"}), 404

        metadata_path = sources_dir / source_id / "metadata.yaml"
        metadata = yaml.safe_load(metadata_path.read_text()) or {} if metadata_path.exists() else {}

        row = source_row(source_id)
        row["metadata"] = {
            "provider_id": metadata.get("provider_id", ""),
            "dataset_page_url": metadata.get("dataset_page_url", ""),
            "format": metadata.get("format", ""),
            "license_name": metadata.get("license_name", ""),
            "license_url": metadata.get("license_url", ""),
            "retrieved_date": metadata.get("retrieved_date", ""),
            "notes": metadata.get("notes", ""),
        }
        return jsonify(row)

    return app


def main(argv=None):
    create_app().run(debug=True, port=8640)


if __name__ == "__main__":
    main()
