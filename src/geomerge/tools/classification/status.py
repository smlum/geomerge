"""Status helpers usable without spinning up classification's Flask app —
source_status is what geomerge serve shows in its table."""

import math
from pathlib import Path

import geopandas as gpd
import yaml

from geomerge.helpers.config import stage_output_dir
from geomerge.helpers.status import COMPLETE, NEEDS_REVIEW, NOT_APPLICABLE, NOT_STARTED


def load_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text()) or {} if path.exists() else {}


def stringify(value) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    return str(value)


def present_columns(df, target: str, targets_config: dict) -> list:
    return [c for c in targets_config[target]["source_columns"] if c in df.columns]


def unique_combos(df, columns: list) -> list:
    """[{"values": {col: str, ...}, "count": n}, ...], grouped by the first
    source column (e.g. source_class) so rows that only differ by a
    secondary column stay adjacent. Groups are ordered by their combined
    count (the source_class with the most rows overall comes first, before
    it's split by any secondary column), and rows within a group are
    ordered by their own count desc."""
    if not columns:
        return []
    stringified = df[columns].apply(lambda col: col.map(stringify))
    counted = stringified.value_counts().reset_index(name="count")
    combos = [
        {"values": {c: row[c] for c in columns}, "count": int(row["count"])}
        for _, row in counted.iterrows()
    ]
    group_totals = {}
    for combo in combos:
        key = combo["values"][columns[0]]
        group_totals[key] = group_totals.get(key, 0) + combo["count"]
    combos.sort(key=lambda c: (-group_totals[c["values"][columns[0]]], -c["count"]))
    return combos


def find_mapping(mappings: list, columns: list, values: dict):
    for m in mappings:
        if all(m["values"].get(c, "") == values.get(c, "") for c in columns):
            return m
    return None


def preprocessed_path(source_id: str, config: dict) -> Path:
    preprocessing_dir = stage_output_dir(config, "preprocessing")
    return preprocessing_dir / source_id / f"{source_id}.parquet"


def target_status(source_id: str, df, target: str, config: dict) -> str:
    targets_config = config["tools"]["classification"]["targets"]
    columns = present_columns(df, target, targets_config)
    if not columns:
        return NOT_APPLICABLE
    combos = unique_combos(df, columns)
    if not combos:
        return NOT_APPLICABLE
    sources_dir = config["repo_root"] / config["sources_dir"]
    classification_map_path = sources_dir / source_id / "classification_map.yaml"
    mappings = load_yaml(classification_map_path).get(target, {}).get("mappings", [])
    if not mappings:
        return NOT_STARTED
    covered = sum(1 for combo in combos if find_mapping(mappings, columns, combo["values"]))
    return COMPLETE if covered == len(combos) else NEEDS_REVIEW


def source_status(source_id: str, config: dict) -> dict:
    """Per-target statuses for one source — has_preprocessed_data: False (all
    targets not_applicable) if it hasn't been through preprocessing yet."""
    targets_config = config["tools"]["classification"]["targets"]
    path = preprocessed_path(source_id, config)
    if not path.exists():
        return {"has_preprocessed_data": False, "targets": {name: NOT_APPLICABLE for name in targets_config}}
    df = gpd.read_parquet(path)
    return {
        "has_preprocessed_data": True,
        "targets": {name: target_status(source_id, df, name, config) for name in targets_config},
    }
