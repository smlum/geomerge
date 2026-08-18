#!/usr/bin/env python3
"""Local web UI for working through checklist.csv in a browser instead of
editing the raw CSV: found/not-found, source_url, notes. Also serves the
per-source metadata editor (a modal on the same page) for confirmed finds —
sources/<source_id>/metadata.yaml is only ever generated on demand, via the
"Add metadata" button for a row, never automatically.

Usage:
    lode tools checklist review
Then open http://localhost:8642
"""

from datetime import date
from pathlib import Path

import pandas as pd
import yaml
from flask import Flask, jsonify, request, send_from_directory

from lode.helpers.config import load_config

CONFIG = load_config()
REPO_ROOT = CONFIG["repo_root"]
SOURCES_DIR = REPO_ROOT / CONFIG["sources_dir"]
CHECKLIST_CSV = SOURCES_DIR / "checklist.csv"
PROVIDERS_CSV = REPO_ROOT / CONFIG["providers_csv"]
SCHEMA_YAML = REPO_ROOT / CONFIG["sources_schema"]
RAW_DIR = REPO_ROOT / CONFIG["raw_dir"]

EDITABLE_FIELDS = [
    "dataset_page_url", "download_url", "format", "license_name", "license_url",
    "contact", "source_updated_date", "retrieved_date", "data_dictionary_url",
    "raw_filename", "notes",
]

# Best-effort guess only — surfaced via a manual "Detect" button, never applied
# automatically, since a stray old download or an unzipped shapefile bundle
# can easily fool a most-recently-modified-file heuristic.
FORMAT_BY_EXTENSION = {
    ".geojson": "geojson",
    ".json": "json",
    ".shp": "shapefile",
    ".zip": "shapefile",
    ".gpkg": "gpkg",
    ".parquet": "parquet",
    ".csv": "csv",
}

app = Flask(__name__, static_folder=str(Path(__file__).parent), static_url_path="")


def load_checklist() -> pd.DataFrame:
    return pd.read_csv(CHECKLIST_CSV, dtype=str).fillna("")


def save_checklist(df: pd.DataFrame):
    df.to_csv(CHECKLIST_CSV, index=False)


def load_schema() -> dict:
    return yaml.safe_load(SCHEMA_YAML.read_text())


def required_fields() -> list:
    return [f["name"] for f in load_schema()["fields"] if f.get("required")]


def format_options() -> list:
    for f in load_schema()["fields"]:
        if f["name"] == "format":
            return f.get("enum", [])
    return []


def yaml_path_for(source_id: str) -> Path:
    return SOURCES_DIR / source_id / "metadata.yaml"


def next_source_id(provider_id: str) -> str:
    existing = {p.parent.name for p in SOURCES_DIR.glob(f"{provider_id}_*/metadata.yaml")}
    if f"{provider_id}_cycling" not in existing:
        return f"{provider_id}_cycling"
    n = 2
    while f"{provider_id}_cycling_{n}" in existing:
        n += 1
    return f"{provider_id}_cycling_{n}"


def metadata_status(row) -> str:
    """missing | partial | complete | none (none = no confirmed source_url yet)."""
    if not row["source_url"]:
        return "none"
    source_id = row["source_ids"]
    yaml_path = yaml_path_for(source_id) if source_id else None
    if not (yaml_path and yaml_path.exists()):
        return "missing"
    data = yaml.safe_load(yaml_path.read_text()) or {}
    req = required_fields()
    return "complete" if all(str(data.get(f, "")).strip() for f in req) else "partial"


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/meta")
def api_meta():
    return jsonify({
        "checklist_path": str(CHECKLIST_CSV.relative_to(REPO_ROOT)),
        "sources_dir": str(SOURCES_DIR.relative_to(REPO_ROOT)),
        "required_fields": required_fields(),
        "format_options": format_options(),
    })


@app.route("/api/rows")
def api_rows():
    df = load_checklist().reset_index().rename(columns={"index": "row_index"})
    df["metadata_status"] = df.apply(metadata_status, axis=1)
    return jsonify(df.to_dict(orient="records"))


@app.route("/api/found", methods=["POST"])
def api_found():
    data = request.get_json()
    row_index = int(data["row_index"])
    source_url = (data.get("source_url") or "").strip()
    if not source_url:
        return jsonify({"error": "source_url required"}), 400

    df = load_checklist()
    if row_index not in df.index:
        return jsonify({"error": "row not found"}), 404

    today = str(date.today())
    df.at[row_index, "source_url"] = source_url
    df.at[row_index, "checked"] = "x"
    df.at[row_index, "checked_date"] = today
    save_checklist(df)

    # Ready for the download as soon as there's somewhere to point it, well
    # before anyone gets around to generating the yaml. Uses the same slug
    # generate() would pick, so the two line up without needing source_ids
    # set yet.
    provider_id = df.at[row_index, "provider_id"]
    source_id = df.at[row_index, "source_ids"] or next_source_id(provider_id)
    (RAW_DIR / source_id).mkdir(parents=True, exist_ok=True)

    return jsonify({"checked_date": today})


@app.route("/api/not_found", methods=["POST"])
def api_not_found():
    data = request.get_json()
    row_index = int(data["row_index"])
    notes = (data.get("notes") or "").strip()

    df = load_checklist()
    if row_index not in df.index:
        return jsonify({"error": "row not found"}), 404

    today = str(date.today())
    df.at[row_index, "checked"] = "x"
    df.at[row_index, "checked_date"] = today
    # Retract any previously recorded source_url/source_ids (e.g. correcting a
    # mistaken "Found"). prior_url (the permanent CCND-lead reference, if any)
    # is never touched here, so it's never lost to a retraction.
    df.at[row_index, "source_url"] = ""
    df.at[row_index, "source_ids"] = ""
    if notes:
        existing = df.at[row_index, "notes"]
        df.at[row_index, "notes"] = f"{existing}; {notes}" if existing else notes
    save_checklist(df)
    return jsonify({"checked_date": today})


@app.route("/api/note", methods=["POST"])
def api_note():
    data = request.get_json()
    row_index = int(data["row_index"])
    notes = data.get("notes") or ""

    df = load_checklist()
    if row_index not in df.index:
        return jsonify({"error": "row not found"}), 404

    df.at[row_index, "notes"] = notes
    save_checklist(df)
    return jsonify({"ok": True})


@app.route("/api/generate", methods=["POST"])
def api_generate():
    data = request.get_json()
    row_index = int(data["row_index"])

    df = load_checklist()
    if row_index not in df.index:
        return jsonify({"error": "row not found"}), 404
    row = df.loc[row_index]

    # A stale source_ids (yaml deleted since) is reused rather than replaced,
    # so re-generating doesn't orphan the id already recorded on the checklist.
    source_id = row["source_ids"] or next_source_id(row["provider_id"])
    out_path = yaml_path_for(source_id)
    if out_path.exists():
        return jsonify({"error": "yaml already exists", "source_id": source_id}), 400

    providers = pd.read_csv(PROVIDERS_CSV, dtype=str).fillna("").set_index("provider_id")
    provider_row = providers.loc[row["provider_id"]] if row["provider_id"] in providers.index else None

    out_path.parent.mkdir(parents=True, exist_ok=True)
    source = {
        "source_id": source_id,
        "provider_id": row["provider_id"],
        "dataset_page_url": row["source_url"],
        "download_url": "",
        "format": "",
        "license_name": provider_row["portal_license_name"] if provider_row is not None else "",
        "license_url": provider_row["portal_license_url"] if provider_row is not None else "",
        "contact": provider_row["contact"] if provider_row is not None else "",
        "source_updated_date": "",
        "retrieved_date": str(date.today()),
        "data_dictionary_url": "",
        "raw_filename": "",
        "notes": "",
    }
    with open(out_path, "w") as f:
        yaml.dump(source, f, sort_keys=False, allow_unicode=True)

    # Normally already created by "Found" — this just covers it being deleted
    # since, or a yaml generated without going through that step.
    (RAW_DIR / source_id).mkdir(parents=True, exist_ok=True)

    df.at[row_index, "source_ids"] = source_id
    save_checklist(df)
    return jsonify({"source_id": source_id})


@app.route("/api/source/<source_id>")
def api_source_get(source_id):
    out_path = yaml_path_for(source_id)
    if not out_path.exists():
        return jsonify({"error": "not found"}), 404
    return jsonify(yaml.safe_load(out_path.read_text()) or {})


@app.route("/api/detect_raw/<source_id>")
def api_detect_raw(source_id):
    raw_dir = RAW_DIR / source_id
    if not raw_dir.is_dir():
        return jsonify({"error": f"no {raw_dir.relative_to(REPO_ROOT)}/ directory found"}), 404

    # A shapefile is usually a bundle of sibling files (.shp/.shx/.dbf/...)
    # inside its own folder. raw_filename should still be directly openable
    # (data/raw/<source_id>/<raw_filename>), so the candidate is the .shp
    # itself, at its path relative to raw_dir — not the bundle folder's name,
    # which points at nothing on its own.
    candidates = []
    for entry in raw_dir.iterdir():
        if entry.name.startswith("."):
            continue
        if entry.is_file():
            fmt = "shapefile" if entry.suffix.lower() == ".shp" else FORMAT_BY_EXTENSION.get(entry.suffix.lower(), "other")
            candidates.append((entry, entry.stat().st_mtime, fmt))
        elif entry.is_dir():
            shp_files = list(entry.rglob("*.shp"))
            if shp_files:
                # Folder's own mtime (extraction time) ranks it among the
                # other candidates; the .shp path is what actually gets used.
                candidates.append((shp_files[0], entry.stat().st_mtime, "shapefile"))

    if not candidates:
        return jsonify({"error": f"{raw_dir.relative_to(REPO_ROOT)}/ is empty"}), 404

    latest, _, fmt = max(candidates, key=lambda c: c[1])
    return jsonify({"raw_filename": str(latest.relative_to(raw_dir)), "format": fmt})


@app.route("/api/source/<source_id>", methods=["POST"])
def api_source_save(source_id):
    out_path = yaml_path_for(source_id)
    if not out_path.exists():
        return jsonify({"error": "not found"}), 404

    data = yaml.safe_load(out_path.read_text()) or {}
    updates = request.get_json()
    for field in EDITABLE_FIELDS:
        if field in updates:
            data[field] = updates[field]

    with open(out_path, "w") as f:
        yaml.dump(data, f, sort_keys=False, allow_unicode=True)
    return jsonify({"ok": True})


def main(argv=None):
    app.run(debug=True, port=8642)


if __name__ == "__main__":
    main()
