"""Status helpers usable without spinning up collection's Flask app —
source_metadata_status/source_raw_data_status are what geomerge serve shows
in its table."""

from pathlib import Path

import pandas as pd

from geomerge.helpers.file_cache import cached_read, cached_yaml
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


def _flagged_provider_ids(checklist_path: Path) -> set:
    checklist = pd.read_csv(checklist_path, dtype=str).fillna("")
    first_rows = checklist.drop_duplicates("provider_id")
    return set(first_rows.loc[first_rows["flagged"] == "x", "provider_id"])


def source_flagged(source_id: str, config: dict) -> bool:
    """Is this source's checklist.csv row flagged? checklist.csv is keyed
    per-provider, not per-source, so this joins via metadata.yaml's
    provider_id rather than source_id directly."""
    repo_root = config["repo_root"]
    metadata_path = repo_root / config["sources_dir"] / source_id / "metadata.yaml"
    if not metadata_path.exists():
        return False
    metadata = cached_yaml(metadata_path)
    provider_id = metadata.get("provider_id")
    if not provider_id:
        return False

    checklist_path = repo_root / config["sources_dir"] / "checklist.csv"
    if not checklist_path.exists():
        return False
    return provider_id in cached_read(checklist_path, _flagged_provider_ids)
