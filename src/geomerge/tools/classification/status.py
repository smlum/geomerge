"""Status helpers usable without spinning up classification's Flask app —
source_status is what geomerge serve shows in its table."""

import json
import math
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq
import yaml

from geomerge.helpers.config import stage_output_dir
from geomerge.helpers.constants import REVIEW_FLAGS
from geomerge.helpers.file_cache import cached_read, cached_yaml
from geomerge.helpers.geo_sampling import network_geometry
from geomerge.helpers.source_notes import source_markers
from geomerge.helpers.status import COMPLETE, NEEDS_REVIEW, NOT_APPLICABLE, NOT_STARTED
from geomerge.pipeline.status import preprocessing_status
from geomerge.tools.column_mapping.status import source_status as column_mapping_status


def load_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text()) or {} if path.exists() else {}


def stringify(value) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    return str(value)


def load_value_labels(source_id: str, config: dict) -> dict:
    """{column: {raw_value: {"label": ..., "basis": ..., "notes": ...}}} from the source's
    optional, hand-maintained value_labels.yaml -- what a coded raw value means.
    Display only: mappings and matching rules stay keyed on the raw value.
    Entries with a blank label are still-unknown placeholders, so are skipped.
    Keys go through str() so an unquoted YAML 1 still matches the raw "1"."""
    path = config["repo_root"] / config["sources_dir"] / source_id / "value_labels.yaml"
    result = {}
    for column, values in load_yaml(path).items():
        labelled = {
            str(value): {"label": entry["label"], "basis": entry.get("basis", ""), "notes": entry.get("notes", "")}
            for value, entry in (values or {}).items()
            if (entry or {}).get("label")
        }
        if labelled:
            result[column] = labelled
    return result


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


def _read_column_names(path: Path) -> set:
    return set(pq.read_schema(path).names)


def _read_combos(path: Path, columns: tuple) -> list:
    return unique_combos(pd.read_parquet(path, columns=list(columns)), list(columns))


def _read_row_count(path: Path) -> int:
    return pq.read_metadata(path).num_rows


def is_whole_source_target(target: str, config: dict) -> bool:
    """A target the target schema marks required (e.g. canbics_class) can't
    just be skipped for a source that has none of its source columns —
    every output row needs a value. Such a source instead gets one
    whole-source "all rows" group (values {}) to classify."""
    # Cached read (not helpers.schema's get_field) — this runs for every
    # source × target on each dashboard load.
    fields = cached_yaml(config["repo_root"] / config["target_schema"]).get("fields", [])
    return any(f.get("name") == target and f.get("required") for f in fields)


def columns_and_combos(source_id: str, target: str, config: dict) -> tuple:
    """(present columns, unique_combos) for one target, without loading the
    parquet's geometry, and cached until the parquet changes. The combos are
    shared between callers — treat them as read-only.

    No present columns: no combos (target not_applicable), unless the target
    is required — then a single all-rows combo, see is_whole_source_target."""
    path = preprocessed_path(source_id, config)
    source_columns = config["tools"]["classification"]["targets"][target]["source_columns"]
    names = cached_read(path, _read_column_names)
    columns = [c for c in source_columns if c in names]
    if columns:
        return columns, cached_read(path, _read_combos, tuple(columns))
    if is_whole_source_target(target, config):
        return columns, [{"values": {}, "count": cached_read(path, _read_row_count)}]
    return columns, []


def _read_network(path: Path, columns: tuple, values: tuple) -> dict:
    import geopandas as gpd

    # Only the filter columns and geometry, not the whole file.
    geo_metadata = json.loads(pq.read_schema(path).metadata[b"geo"])
    df = gpd.read_parquet(path, columns=[*columns, geo_metadata["primary_column"]])
    mask = pd.Series(True, index=df.index)
    for column, value in zip(columns, values):
        mask &= df[column].map(stringify) == value
    subset = df[mask]
    return {"n_features": int(len(subset)), "geometry": network_geometry(subset)}


def cached_network(source_id: str, columns: list, values: dict, config: dict) -> dict:
    """Every feature sharing one combination of raw values, merged for a map.
    Merging the largest groups takes seconds, hence the cache."""
    path = preprocessed_path(source_id, config)
    return cached_read(path, _read_network, tuple(columns), tuple(values.get(c, "") for c in columns))


def find_mapping(mappings: list, columns: list, values: dict):
    for m in mappings:
        if all(m["values"].get(c, "") == values.get(c, "") for c in columns):
            return m
    return None


def preprocessed_path(source_id: str, config: dict) -> Path:
    preprocessing_dir = stage_output_dir(config, "preprocessing")
    return preprocessing_dir / source_id / f"{source_id}.parquet"


def is_eligible(source_id: str, config: dict) -> bool:
    """False if this source hasn't cleared column mapping / preprocessing yet
    — a source shouldn't be classified until the data feeding it is settled.
    A flag doesn't block classifying (it only means something needs doing);
    an excluded source has no preprocessed data, since the pipeline skips it."""
    cm = column_mapping_status(source_id, config)
    if cm["column_map_status"] != COMPLETE:
        return False
    return preprocessing_status(source_id, config) == COMPLETE


def target_status(source_id: str, target: str, config: dict) -> str:
    """For a source already known to be eligible — see source_status()."""
    columns, combos = columns_and_combos(source_id, target, config)
    if not combos:
        return NOT_APPLICABLE
    sources_dir = config["repo_root"] / config["sources_dir"]
    classification_map_path = sources_dir / source_id / "classification_map.yaml"
    mappings = cached_yaml(classification_map_path).get(target, {}).get("mappings", [])
    if not mappings:
        return NOT_STARTED
    covered = sum(1 for combo in combos if find_mapping(mappings, columns, combo["values"]))
    return COMPLETE if covered == len(combos) else NEEDS_REVIEW


def review_markers(source_id: str, config: dict) -> dict:
    """{"flag_counts": {flag: n, ...}, "notes": [per-mapping note, ...]} from
    classification_map.yaml alone — no parquet read, so it's cheap to call for
    every source on a dashboard. Per-mapping only: the source-level note and
    flag live in metadata.yaml (helpers/source_notes.py)."""
    targets_config = config["tools"]["classification"]["targets"]
    sources_dir = config["repo_root"] / config["sources_dir"]
    saved = cached_yaml(sources_dir / source_id / "classification_map.yaml")
    flag_counts = {flag: 0 for flag in REVIEW_FLAGS}
    notes = []
    for target in targets_config:
        for mapping in saved.get(target, {}).get("mappings", []):
            if mapping.get("flag") in flag_counts:
                flag_counts[mapping["flag"]] += 1
            if mapping.get("flag") or mapping.get("notes"):
                notes.append({
                    "target": target,
                    "values": mapping.get("values", {}),
                    "value": mapping.get("target", ""),
                    "flag": mapping.get("flag", ""),
                    "notes": mapping.get("notes", ""),
                })
    return {"flag_counts": flag_counts, "notes": notes}


def source_status(source_id: str, config: dict) -> dict:
    """Per-target statuses for one source — has_preprocessed_data: False (all
    targets not_applicable) if it hasn't been through preprocessing yet, or
    if the source isn't eligible for classification yet (see is_eligible)."""
    targets_config = config["tools"]["classification"]["targets"]
    path = preprocessed_path(source_id, config)
    if not path.exists() or not is_eligible(source_id, config):
        return {"has_preprocessed_data": False, "targets": {name: NOT_APPLICABLE for name in targets_config}}
    return {
        "has_preprocessed_data": True,
        "flagged": source_markers(source_id, config)["flagged"],
        "targets": {name: target_status(source_id, name, config) for name in targets_config},
    }
