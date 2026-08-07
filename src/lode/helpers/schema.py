"""Looks up a field's definition in a target schema yaml (e.g. schema/ccnd.yaml)."""

from pathlib import Path

import yaml


def get_field(schema_path: Path, field_name: str) -> dict:
    schema = yaml.safe_load(schema_path.read_text())
    for field in schema["fields"]:
        if field["name"] == field_name:
            return field
    raise ValueError(f"{schema_path} has no field named '{field_name}'")
