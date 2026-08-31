#!/usr/bin/env python3
"""Local web UI for working through checklist.csv in a browser instead of
editing the raw CSV: found/not-found, source_url, notes. Also serves the
per-source metadata editor (a modal on the same page) for confirmed finds —
sources/<source_id>/metadata.yaml is only ever generated on demand, via the
"Add metadata" button for a row, never automatically.

Mounted under geomerge serve at /collection/ — see geomerge.tools.home.web.server.
"""

import re
import shutil
import unicodedata
from datetime import date
from pathlib import Path

import pandas as pd
import yaml
from flask import Blueprint, jsonify, render_template, request

from geomerge.helpers.config import load_config, stage_output_dir


def slugify(text: str) -> str:
    normalized = unicodedata.normalize("NFD", text)
    stripped = "".join(c for c in normalized if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", "_", stripped.lower()).strip("_")


EDITABLE_FIELDS = [
    "dataset_page_url", "download_url", "format", "license_name", "license_url",
    "open_license", "contact", "source_updated_date", "retrieved_date",
    "data_dictionary_url", "raw_filename", "notes",
]

# checklist.csv row fields editable via Add/Edit source — provider_id and
# name are handled separately (provider_id is a stable key set only on
# creation; name is required so it's always sent, but neither is "optional"
# in the way these are).
EDITABLE_ROW_FIELDS = [
    "province", "portal_url", "portal_license_name", "portal_license_url", "contact", "notes",
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


def create_blueprint(config: dict = None) -> Blueprint:
    config = config or load_config()
    repo_root = config["repo_root"]
    sources_dir = repo_root / config["sources_dir"]
    checklist_csv = sources_dir / "checklist.csv"
    providers_csv = repo_root / config["providers_csv"]
    providers_schema_yaml = repo_root / config["providers_schema"]
    schema_yaml = repo_root / config["sources_schema"]
    raw_dir = repo_root / config["raw_dir"]

    bp = Blueprint(
        "collection", __name__,
        static_folder=str(Path(__file__).parent), static_url_path="",
        template_folder="templates",
    )

    def load_checklist() -> pd.DataFrame:
        return pd.read_csv(checklist_csv, dtype=str).fillna("")

    def save_checklist(df: pd.DataFrame):
        df.to_csv(checklist_csv, index=False)

    def load_schema() -> dict:
        return yaml.safe_load(schema_yaml.read_text())

    def required_fields() -> list:
        return [f["name"] for f in load_schema()["fields"] if f.get("required")]

    def format_options() -> list:
        for f in load_schema()["fields"]:
            if f["name"] == "format":
                return f.get("enum", [])
        return []

    def geography_level_options() -> list:
        # Sourced from the shared providers schema (ca-data-providers), not
        # hardcoded here, so a new checklist row's geography_level always
        # matches what that master registry actually accepts.
        schema = yaml.safe_load(providers_schema_yaml.read_text())
        for f in schema["fields"]:
            if f["name"] == "geography_level":
                return f.get("enum", [])
        return []

    def provider_field_descriptions() -> dict:
        # Powers the Add source modal's field tooltips, straight from the
        # same schema, so the hint text can't drift from what the master
        # registry actually expects.
        schema = yaml.safe_load(providers_schema_yaml.read_text())
        return {f["name"]: f.get("description", "") for f in schema["fields"]}

    def yaml_path_for(source_id: str) -> Path:
        return sources_dir / source_id / "metadata.yaml"

    def source_ids_for(row) -> list:
        return [s.strip() for s in (row["source_ids"] or "").split(",") if s.strip()]

    def next_source_id(provider_id: str, label: str = "") -> str:
        # A label (e.g. "multi_use_trails") bakes straight into the id —
        # meaningful and stable, unlike the numeric fallback below, which
        # only exists for providers with more than one source and no label
        # given for the later ones.
        if label:
            return f"{provider_id}_{slugify(label)}"
        existing = {p.parent.name for p in sources_dir.glob(f"{provider_id}_*/metadata.yaml")}
        if f"{provider_id}_cycling" not in existing:
            return f"{provider_id}_cycling"
        n = 2
        while f"{provider_id}_cycling_{n}" in existing:
            n += 1
        return f"{provider_id}_cycling_{n}"

    def metadata_status(row) -> str:
        """missing | partial | complete | none (none = no confirmed source_url
        yet). A provider can have several sources; this is the worst of
        them — complete only once every one of them is, missing if any
        hasn't even been generated yet."""
        if not row["source_url"]:
            return "none"
        source_ids = source_ids_for(row)
        if not source_ids:
            return "missing"
        req = required_fields()
        statuses = []
        for source_id in source_ids:
            yaml_path = yaml_path_for(source_id)
            if not yaml_path.exists():
                statuses.append("missing")
                continue
            data = yaml.safe_load(yaml_path.read_text()) or {}
            statuses.append("complete" if all(str(data.get(f, "")).strip() for f in req) else "partial")
        if all(s == "complete" for s in statuses):
            return "complete"
        if any(s == "missing" for s in statuses):
            return "missing"
        return "partial"

    def raw_data_status(row) -> str:
        """missing | complete | none (none = no confirmed source_url yet) —
        is each source's declared raw_filename actually sitting under
        data/raw/<source_id>/? complete only once every source's file is
        there; declaring a filename doesn't mean it's been downloaded yet,
        so this checks disk directly."""
        if not row["source_url"]:
            return "none"
        source_ids = source_ids_for(row)
        if not source_ids:
            return "missing"
        for source_id in source_ids:
            yaml_path = yaml_path_for(source_id)
            if not yaml_path.exists():
                return "missing"
            data = yaml.safe_load(yaml_path.read_text()) or {}
            raw_filename = data.get("raw_filename")
            if not raw_filename or not (raw_dir / source_id / raw_filename).exists():
                return "missing"
        return "complete"

    @bp.route("/")
    def index():
        return render_template("collection/index.html", active_tab="collect")

    @bp.route("/api/meta")
    def api_meta():
        return jsonify({
            "checklist_path": str(checklist_csv.relative_to(repo_root)),
            "sources_dir": str(sources_dir.relative_to(repo_root)),
            "required_fields": required_fields(),
            "format_options": format_options(),
            "geography_level_options": geography_level_options(),
            "provider_field_descriptions": provider_field_descriptions(),
        })

    @bp.route("/api/rows")
    def api_rows():
        df = load_checklist().reset_index().rename(columns={"index": "row_index"})
        df["metadata_status"] = df.apply(metadata_status, axis=1)
        df["raw_data_status"] = df.apply(raw_data_status, axis=1)
        return jsonify(df.to_dict(orient="records"))

    @bp.route("/api/add_row", methods=["POST"])
    def api_add_row():
        # Adds directly to this project's working checklist only — doesn't
        # touch ca-data-providers/providers.csv (the master registry).
        # Reconciling the two is a separate, later problem; for now this
        # just needs to unblock adding a source that isn't in the checklist
        # yet, e.g. one providers.csv missed.
        data = request.get_json()
        provider_id = (data.get("provider_id") or "").strip()
        name = (data.get("name") or "").strip()
        geography_level = (data.get("geography_level") or "").strip()

        if not provider_id or not name or not geography_level:
            return jsonify({"error": "provider_id, name, and geography_level are required"}), 400

        df = load_checklist()
        if (df["provider_id"] == provider_id).any():
            return jsonify({"error": f"provider_id '{provider_id}' already exists in the checklist"}), 400

        new_row = {col: "" for col in df.columns}
        new_row.update({"provider_id": provider_id, "name": name, "geography_level": geography_level})
        new_row.update({f: (data.get(f) or "").strip() for f in EDITABLE_ROW_FIELDS})
        df = pd.concat([df, pd.DataFrame([new_row])], ignore_index=True)
        save_checklist(df)
        return jsonify({"ok": True, "row_index": len(df) - 1})

    @bp.route("/api/update_row", methods=["POST"])
    def api_update_row():
        # provider_id is never touched here — it's the stable key everything
        # else (source_ids, any future providers.csv sync) keys off, so it's
        # only ever set once, at creation.
        data = request.get_json()
        row_index = int(data["row_index"])
        name = (data.get("name") or "").strip()
        geography_level = (data.get("geography_level") or "").strip()

        if not name or not geography_level:
            return jsonify({"error": "name and geography_level are required"}), 400

        df = load_checklist()
        if row_index not in df.index:
            return jsonify({"error": "row not found"}), 404

        df.at[row_index, "name"] = name
        df.at[row_index, "geography_level"] = geography_level
        for field in EDITABLE_ROW_FIELDS:
            df.at[row_index, field] = (data.get(field) or "").strip()
        save_checklist(df)
        return jsonify({"ok": True})

    @bp.route("/api/found", methods=["POST"])
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
        # before anyone gets around to generating the yaml. Uses the same
        # (unlabeled) slug generate() would default to, so the two line up
        # without needing source_ids set yet — only relevant for a
        # provider's first source; later ones get their folder from
        # generate() itself once a label's been chosen.
        provider_id = df.at[row_index, "provider_id"]
        existing_ids = source_ids_for(df.loc[row_index])
        source_id = existing_ids[0] if existing_ids else next_source_id(provider_id)
        (raw_dir / source_id).mkdir(parents=True, exist_ok=True)

        return jsonify({"checked_date": today})

    @bp.route("/api/not_found", methods=["POST"])
    def api_not_found():
        data = request.get_json()
        row_index = int(data["row_index"])
        notes = (data.get("notes") or "").strip()

        df = load_checklist()
        if row_index not in df.index:
            return jsonify({"error": "row not found"}), 404
        row = df.loc[row_index]

        # Undo whatever Found/Generate already created for this row on disk —
        # the same folders /api/remove_source knows how to delete — instead
        # of silently leaving them behind. Every other tool discovers sources
        # purely by scanning sources/*, with no idea this checklist row ever
        # retracted them, so an un-deleted folder from a prior Found/Generate
        # keeps looking like a real, in-progress source everywhere else (a
        # real incident: bc_thompson_nicola_regional_district_cycling stayed
        # in Prepare's list long after this row was marked not found here).
        # Blocked — not deleted, not left as a silent orphan either — if real
        # downstream work already exists, same guard /api/rename_source uses,
        # since silently destroying real review work would be worse than
        # either alternative.
        generated_ids = source_ids_for(row)
        blocked = [sid for sid in generated_ids if downstream_work_exists(sid)]
        if blocked:
            return jsonify({
                "error": f"can't mark not found — already has real work done: {', '.join(blocked)}. Remove the source first if you're sure.",
            }), 400

        # /api/found creates this row's raw-dir stub immediately, before
        # Generate necessarily ever runs — covers Found -> (never Generate)
        # -> Not Found, which generated_ids above wouldn't catch on its own.
        # Only cleaned up if it's still genuinely empty (nobody downloaded
        # anything into it yet) and Generate never created a metadata.yaml
        # there — otherwise it might be a real, if not-yet-catalogued,
        # download, so it's left alone rather than guessed away.
        cleanup_ids = list(generated_ids)
        if row["provider_id"]:
            guessed_id = next_source_id(row["provider_id"])
            guessed_raw_dir = raw_dir / guessed_id
            if (
                guessed_id not in cleanup_ids
                and not yaml_path_for(guessed_id).exists()
                and guessed_raw_dir.is_dir()
                and not any(guessed_raw_dir.iterdir())
            ):
                cleanup_ids.append(guessed_id)

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

        for source_id in cleanup_ids:
            for base_dir in (sources_dir, raw_dir):
                target = base_dir / source_id
                if target.exists():
                    shutil.rmtree(target)

        return jsonify({"checked_date": today})

    @bp.route("/api/note", methods=["POST"])
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

    @bp.route("/api/portal_url", methods=["POST"])
    def api_portal_url():
        data = request.get_json()
        row_index = int(data["row_index"])
        portal_url = (data.get("portal_url") or "").strip()

        df = load_checklist()
        if row_index not in df.index:
            return jsonify({"error": "row not found"}), 404

        df.at[row_index, "portal_url"] = portal_url
        save_checklist(df)
        return jsonify({"ok": True})

    @bp.route("/api/flag", methods=["POST"])
    def api_flag():
        data = request.get_json()
        row_index = int(data["row_index"])
        flagged = bool(data.get("flagged"))

        df = load_checklist()
        if row_index not in df.index:
            return jsonify({"error": "row not found"}), 404

        df.at[row_index, "flagged"] = "x" if flagged else ""
        save_checklist(df)
        return jsonify({"ok": True})

    @bp.route("/api/generate", methods=["POST"])
    def api_generate():
        # Always creates one new source and appends it to this row's
        # source_ids — a provider can have several, each with its own
        # metadata.yaml. label is optional but permanent: it's baked into
        # source_id right here and can't be changed afterward (same rule as
        # provider_id elsewhere), so a collision has to be caught now.
        data = request.get_json()
        row_index = int(data["row_index"])
        label = (data.get("label") or "").strip()

        df = load_checklist()
        if row_index not in df.index:
            return jsonify({"error": "row not found"}), 404
        row = df.loc[row_index]

        source_id = next_source_id(row["provider_id"], label)
        out_path = yaml_path_for(source_id)
        if out_path.exists():
            return jsonify({"error": f"a source called '{source_id}' already exists — try a different label"}), 400

        # Prefer the checklist row's own portal_license_name/portal_license_url/
        # contact — locally editable via Edit source, so more likely current
        # than providers.csv — falling back to providers.csv only if the
        # checklist row was never filled in for those.
        providers = pd.read_csv(providers_csv, dtype=str).fillna("").set_index("provider_id")
        provider_row = providers.loc[row["provider_id"]] if row["provider_id"] in providers.index else None

        def prefer_row(row_field, provider_field):
            return row[row_field] or (provider_row[provider_field] if provider_row is not None else "")

        out_path.parent.mkdir(parents=True, exist_ok=True)
        source = {
            "source_id": source_id,
            "label": label,
            "provider_id": row["provider_id"],
            "dataset_page_url": row["source_url"],
            "download_url": "",
            "format": "",
            "license_name": prefer_row("portal_license_name", "portal_license_name"),
            "license_url": prefer_row("portal_license_url", "portal_license_url"),
            "open_license": None,
            "contact": prefer_row("contact", "contact"),
            "source_updated_date": "",
            "retrieved_date": str(date.today()),
            "data_dictionary_url": "",
            "raw_filename": "",
            "notes": "",
        }
        with open(out_path, "w") as f:
            yaml.dump(source, f, sort_keys=False, allow_unicode=True)

        # Normally already created by "Found" (for a provider's first
        # source) — this covers every other case: later sources, or this
        # one's raw dir having been deleted since.
        (raw_dir / source_id).mkdir(parents=True, exist_ok=True)

        existing_ids = source_ids_for(row)
        df.at[row_index, "source_ids"] = ",".join(existing_ids + [source_id])
        save_checklist(df)
        return jsonify({"source_id": source_id})

    @bp.route("/api/remove_source", methods=["POST"])
    def api_remove_source():
        # Destructive — deletes metadata.yaml and any downloaded raw data for
        # this one source_id. Only ever called for a provider with more than
        # one source (the UI hides Remove otherwise), so a provider never
        # ends up with zero.
        data = request.get_json()
        row_index = int(data["row_index"])
        source_id = (data.get("source_id") or "").strip()

        df = load_checklist()
        if row_index not in df.index:
            return jsonify({"error": "row not found"}), 404
        existing_ids = source_ids_for(df.loc[row_index])
        if source_id not in existing_ids:
            return jsonify({"error": "source not found on this row"}), 404

        for base_dir in (sources_dir, raw_dir):
            target = base_dir / source_id
            if target.exists():
                shutil.rmtree(target)

        existing_ids.remove(source_id)
        df.at[row_index, "source_ids"] = ",".join(existing_ids)
        save_checklist(df)
        return jsonify({"ok": True})

    def downstream_work_exists(source_id: str) -> bool:
        """Anything past collection already keyed off this exact source_id —
        renaming past this point would silently orphan real work rather
        than just relabeling an empty folder."""
        candidates = [
            sources_dir / source_id / "column_map.yaml",
            sources_dir / source_id / "classification_map.yaml",
        ]
        for stage_name in ("preprocessing", "processing"):
            try:
                candidates.append(stage_output_dir(config, stage_name) / source_id)
            except ValueError:
                pass
        return any(p.exists() for p in candidates)

    @bp.route("/api/rename_source", methods=["POST"])
    def api_rename_source():
        # Only reachable while nothing downstream references this source_id
        # yet (checked both here and again just before the actual rename, in
        # case something changed in between) — label is otherwise locked
        # forever specifically because renaming later would break real work.
        data = request.get_json()
        row_index = int(data["row_index"])
        old_source_id = (data.get("old_source_id") or "").strip()
        label = (data.get("label") or "").strip()

        df = load_checklist()
        if row_index not in df.index:
            return jsonify({"error": "row not found"}), 404
        row = df.loc[row_index]
        existing_ids = source_ids_for(row)
        if old_source_id not in existing_ids:
            return jsonify({"error": "source not found on this row"}), 404

        if downstream_work_exists(old_source_id):
            return jsonify({"error": "can't rename — later pipeline steps already reference this source"}), 400

        new_source_id = next_source_id(row["provider_id"], label) if label else old_source_id
        if new_source_id == old_source_id:
            return jsonify({"error": "nothing to rename"}), 400
        if yaml_path_for(new_source_id).exists():
            return jsonify({"error": f"'{new_source_id}' already exists"}), 400

        old_yaml_dir = sources_dir / old_source_id
        old_yaml_dir.rename(sources_dir / new_source_id)
        old_raw_dir = raw_dir / old_source_id
        if old_raw_dir.exists():
            old_raw_dir.rename(raw_dir / new_source_id)

        yaml_path = yaml_path_for(new_source_id)
        yaml_data = yaml.safe_load(yaml_path.read_text()) or {}
        yaml_data["source_id"] = new_source_id
        yaml_data["label"] = label
        with open(yaml_path, "w") as f:
            yaml.dump(yaml_data, f, sort_keys=False, allow_unicode=True)

        existing_ids[existing_ids.index(old_source_id)] = new_source_id
        df.at[row_index, "source_ids"] = ",".join(existing_ids)
        save_checklist(df)
        return jsonify({"source_id": new_source_id})

    @bp.route("/api/source/<source_id>")
    def api_source_get(source_id):
        out_path = yaml_path_for(source_id)
        if not out_path.exists():
            return jsonify({"error": "not found"}), 404
        result = yaml.safe_load(out_path.read_text()) or {}
        result["_can_rename"] = not downstream_work_exists(source_id)
        return jsonify(result)

    # The raw file text, not the parsed dict api_source_get returns above —
    # for geomerge serve's read-only metadata preview modal, which shows
    # the actual file (key order, comments, formatting) rather than a
    # re-serialized version of it.
    @bp.route("/api/source/<source_id>/raw")
    def api_source_get_raw(source_id):
        out_path = yaml_path_for(source_id)
        if not out_path.exists():
            return jsonify({"error": "not found"}), 404
        return jsonify({"content": out_path.read_text(), "path": str(out_path.relative_to(repo_root))})

    @bp.route("/api/detect_raw/<source_id>")
    def api_detect_raw(source_id):
        source_raw_dir = raw_dir / source_id
        if not source_raw_dir.is_dir():
            return jsonify({"error": f"no {source_raw_dir.relative_to(repo_root)}/ directory found"}), 404

        # A shapefile is usually a bundle of sibling files (.shp/.shx/.dbf/...)
        # inside its own folder. raw_filename should still be directly openable
        # (data/raw/<source_id>/<raw_filename>), so the candidate is the .shp
        # itself, at its path relative to raw_dir — not the bundle folder's name,
        # which points at nothing on its own.
        candidates = []
        for entry in source_raw_dir.iterdir():
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
            return jsonify({"error": f"{source_raw_dir.relative_to(repo_root)}/ is empty"}), 404

        latest, _, fmt = max(candidates, key=lambda c: c[1])
        return jsonify({"raw_filename": str(latest.relative_to(source_raw_dir)), "format": fmt})

    @bp.route("/api/source/<source_id>", methods=["POST"])
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

    return bp
