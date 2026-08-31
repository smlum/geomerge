"""Status helpers usable without spinning up collection's Flask app —
source_metadata_status/source_raw_data_status are what geomerge serve shows
in its table."""

from pathlib import Path

import yaml

from geomerge.helpers.status import COMPLETE, MISSING, PARTIAL


def required_fields(sources_schema_path: Path) -> list:
    schema = yaml.safe_load(sources_schema_path.read_text())
    return [f["name"] for f in schema["fields"] if f.get("required")]


def source_metadata_status(source_id: str, config: dict) -> str:
    """missing | partial | complete, for an existing sources/<source_id>/metadata.yaml."""
    repo_root = config["repo_root"]
    yaml_path = repo_root / config["sources_dir"] / source_id / "metadata.yaml"
    if not yaml_path.exists():
        return MISSING
    data = yaml.safe_load(yaml_path.read_text()) or {}
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
    data = yaml.safe_load(yaml_path.read_text()) or {}
    raw_filename = data.get("raw_filename")
    if not raw_filename:
        return MISSING
    raw_path = repo_root / config["raw_dir"] / source_id / raw_filename
    return COMPLETE if raw_path.exists() else MISSING
