"""Status helpers usable without spinning up collection's Flask app — the
per-source piece (source_metadata_status) is what lode tools home shows in
its table; checklist_summary is the provider-level stat line above it, since
checklist.csv is grained by provider, not by the sources/ this tool's other
status is grained by."""

from pathlib import Path

import pandas as pd
import yaml


def required_fields(sources_schema_path: Path) -> list:
    schema = yaml.safe_load(sources_schema_path.read_text())
    return [f["name"] for f in schema["fields"] if f.get("required")]


def source_metadata_status(source_id: str, config: dict) -> str:
    """missing | partial | complete, for an existing sources/<source_id>/metadata.yaml."""
    repo_root = config["repo_root"]
    yaml_path = repo_root / config["sources_dir"] / source_id / "metadata.yaml"
    if not yaml_path.exists():
        return "missing"
    data = yaml.safe_load(yaml_path.read_text()) or {}
    required = required_fields(repo_root / config["sources_schema"])
    return "complete" if all(str(data.get(f, "")).strip() for f in required) else "partial"


def checklist_summary(config: dict) -> dict:
    """Provider-level counts (not per-source): how much of providers.csv has
    been worked through, and how many were found."""
    checklist_path = config["repo_root"] / config["sources_dir"] / "checklist.csv"
    if not checklist_path.exists():
        return {"total": 0, "checked": 0, "found": 0}
    df = pd.read_csv(checklist_path, dtype=str).fillna("")
    checked = (df["checked"] != "") | (df["checked_date"] != "")
    return {
        "total": int(len(df)),
        "checked": int(checked.sum()),
        "found": int((df["source_url"] != "").sum()),
    }
