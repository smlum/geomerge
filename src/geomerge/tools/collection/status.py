"""Status helpers usable without spinning up collection's Flask app —
source_metadata_status/source_raw_data_status are what geomerge serve shows
in its table."""

from pathlib import Path

import pandas as pd

from geomerge.helpers.file_cache import cached_read, cached_yaml
from geomerge.helpers.source_notes import flag_markers
from geomerge.helpers.status import COMPLETE, MISSING, PARTIAL


def required_fields(sources_schema_path: Path) -> list:
    schema = cached_yaml(sources_schema_path)
    return [f["name"] for f in schema["fields"] if f.get("required")]


def source_metadata_status(source_id: str, config: dict) -> str:
    """missing | partial | complete, for an existing sources/<source_id>/metadata.yaml."""
    repo_root = config["repo_root"]
    yaml_path = repo_root / config["sources_dir"] / source_id / "metadata.yaml"
    if not yaml_path.exists():
        return MISSING
    data = cached_yaml(yaml_path)
    required = required_fields(repo_root / config["sources_schema"])
    return COMPLETE if all(str(data.get(f, "")).strip() for f in required) else PARTIAL


def source_raw_data_status(source_id: str, config: dict) -> str:
    """missing | complete — is metadata.yaml's declared raw_filename actually
    present under data/raw/<source_id>/? metadata.yaml only records the
    filename a source is supposed to have; it says nothing about whether
    anyone has actually downloaded the file, so this checks disk directly."""
    repo_root = config["repo_root"]
    yaml_path = repo_root / config["sources_dir"] / source_id / "metadata.yaml"
    if not yaml_path.exists():
        return MISSING
    data = cached_yaml(yaml_path)
    raw_filename = data.get("raw_filename")
    if not raw_filename:
        return MISSING
    raw_path = repo_root / config["raw_dir"] / source_id / raw_filename
    return COMPLETE if raw_path.exists() else MISSING


def _flagged_rows(checklist_path: Path) -> list:
    checklist = pd.read_csv(checklist_path, dtype=str).fillna("")
    if "flagged" not in checklist.columns:
        return []
    flagged = checklist[checklist["flagged"] == "x"]
    return [
        {
            "row_index": int(index),
            "provider_id": row["provider_id"],
            "name": row["name"],
            "province": row["province"],
            "notes": row["notes"],
            "source_ids": [s for s in row["source_ids"].split(",") if s],
            "portal_url": row.get("portal_url", ""),
            "source_url": row.get("source_url", ""),
            "contact": row.get("contact", ""),
            **flag_markers(
                True, row.get("flag_reasons", ""), row.get("flag_status", ""), row.get("flag_status_date", "")
            ),
        }
        for index, row in flagged.iterrows()
    ]


def _rows_by_provider(checklist_path: Path) -> dict:
    checklist = pd.read_csv(checklist_path, dtype=str).fillna("")
    return {row["provider_id"]: row.to_dict() for _, row in checklist.drop_duplicates("provider_id").iterrows()}


def provider_row(provider_id: str, config: dict) -> dict:
    """A provider's checklist.csv row as a dict ({} if none) — e.g. its
    portal_url and provider-level contact, for a source's notes popout."""
    checklist_path = config["repo_root"] / config["sources_dir"] / "checklist.csv"
    if not provider_id or not checklist_path.exists():
        return {}
    return cached_read(checklist_path, _rows_by_provider).get(provider_id, {})


def flagged_providers(config: dict) -> list:
    """Every flagged checklist.csv row — a provider-level follow-up (usually
    about finding data, before any source exists), as opposed to a source's
    own flag in its metadata.yaml (helpers/source_notes.py). Neither affects
    the pipeline. row_index is what collection's /api/note and /api/flag take."""
    checklist_path = config["repo_root"] / config["sources_dir"] / "checklist.csv"
    if not checklist_path.exists():
        return []
    return cached_read(checklist_path, _flagged_rows)
