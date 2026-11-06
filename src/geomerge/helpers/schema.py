"""Looks up a field's definition in a target schema yaml (e.g. schema/ccnd.yaml)."""

from pathlib import Path

import yaml


def get_field(schema_path: Path, field_name: str) -> dict:
    schema = yaml.safe_load(schema_path.read_text())
    for field in schema["fields"]:
        if field["name"] == field_name:
            return field
    raise ValueError(f"{schema_path} has no field named '{field_name}'")


def is_required(schema_path: Path, field_name: str) -> bool:
    """The field's `required` flag; False for a field the schema doesn't define."""
    try:
        return bool(get_field(schema_path, field_name).get("required", False))
    except ValueError:
        return False
