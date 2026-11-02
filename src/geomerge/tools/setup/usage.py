"""Scans every source's column_map.yaml/classification_map.yaml, plus
geomerge.config.yaml's classification.targets block and the two matching-rules
files, once, to answer "which sources (or config) actually reference this
target field name (or this field+enum-value pair)". Powers setup/'s inline
usage badges and its save-time danger check — schema/ccnd.yaml field names
and enum values are referenced elsewhere as bare, unvalidated strings, and
nothing before this module ever checked that.

Domain-agnostic like every other tools/* module — driven entirely by config,
no ccnd.yaml specifics hardcoded.
"""

from collections import defaultdict
from pathlib import Path

import yaml


def load_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text()) or {} if path.exists() else {}


def source_ids(config: dict) -> list:
    sources_dir = config["repo_root"] / config["sources_dir"]
    if not sources_dir.is_dir():
        return []
    return sorted(p.name for p in sources_dir.iterdir() if p.is_dir())


def _empty_entry() -> dict:
    return {
        "column_map_sources": [],
        "classification_target_sources": [],
        "classification_source_column_sources": [],
        "classification_enum_values": defaultdict(list),
        "config_target": False,
        "config_source_column_of": [],
        "column_matching_rule": False,
        "classification_matching_rule_values": [],
    }


def build_usage_index(config: dict) -> dict:
    """{field_name: {
         column_map_sources: [source_id, ...],              # mapped TO this field
         classification_target_sources: [source_id, ...],   # top-level key in classification_map.yaml
         classification_source_column_sources: [source_id, ...],  # in some target's source_columns
         classification_enum_values: {value: [source_id, ...]},   # mappings[].target == value
         config_target: bool,                                # top-level key in geomerge.config.yaml's classification.targets
         config_source_column_of: [target_field, ...],       # referenced in some *other* target's source_columns there
         column_matching_rule: bool,                          # top-level key in column_matching_rules.yaml
         classification_matching_rule_values: [value, ...],   # bucket keys under this field in classification_matching_rules.yaml
       }}
    Every list/dict defaults empty via defaultdict so callers never need
    `.get(..., [])` scattered everywhere.
    """
    repo_root = config["repo_root"]
    sources_dir = repo_root / config["sources_dir"]
    index = defaultdict(_empty_entry)

    for sid in source_ids(config):
        source_dir = sources_dir / sid
        cm = load_yaml(source_dir / "column_map.yaml")
        for _raw_col, target in cm.get("column_map", {}).items():
            if target:
                index[target]["column_map_sources"].append(sid)

        cls = load_yaml(source_dir / "classification_map.yaml")
        for target_field, entry in cls.items():
            # Top-level non-target keys, e.g. the source-level `notes` string.
            if not isinstance(entry, dict):
                continue
            index[target_field]["classification_target_sources"].append(sid)
            for col in entry.get("source_columns", []):
                index[col]["classification_source_column_sources"].append(sid)
            for mapping in entry.get("mappings", []):
                value = mapping.get("target")
                if value:
                    index[target_field]["classification_enum_values"][value].append(sid)

    classification_targets = config["tools"]["classification"].get("targets", {})
    for target_field, target_cfg in classification_targets.items():
        index[target_field]["config_target"] = True
        for col in target_cfg.get("source_columns", []):
            index[col]["config_source_column_of"].append(target_field)

    column_matching_rules = load_yaml(repo_root / config["tools"]["column_mapping"]["matching_rules"])
    for target_field in column_matching_rules:
        index[target_field]["column_matching_rule"] = True

    classification_matching_rules = load_yaml(repo_root / config["tools"]["classification"]["matching_rules"])
    for target_field, buckets in classification_matching_rules.items():
        index[target_field]["classification_matching_rule_values"] = sorted(buckets or {})

    return index


def usage_summary(field_name: str, index: dict) -> dict:
    """Counts/booleans only — cheap to attach to every field for the inline
    badge without a second round trip."""
    u = index[field_name]
    return {
        "column_map_count": len(u["column_map_sources"]),
        "classification_target_count": len(u["classification_target_sources"]),
        "classification_source_column_count": len(u["classification_source_column_sources"]),
        "config_target": u["config_target"],
        "config_source_column_of": u["config_source_column_of"],
        "column_matching_rule": u["column_matching_rule"],
        "classification_matching_rule_values": u["classification_matching_rule_values"],
        "in_use": any([
            u["column_map_sources"],
            u["classification_target_sources"],
            u["classification_source_column_sources"],
            u["config_target"],
            u["config_source_column_of"],
            u["column_matching_rule"],
            u["classification_matching_rule_values"],
        ]),
    }


def usage_detail(field_name: str, index: dict) -> dict:
    """Full source-id lists — for the confirmation message, not the badge."""
    u = index[field_name]
    return {
        "column_map_sources": sorted(u["column_map_sources"]),
        "classification_target_sources": sorted(u["classification_target_sources"]),
        "classification_source_column_sources": sorted(u["classification_source_column_sources"]),
        "config_target": u["config_target"],
        "config_source_column_of": sorted(u["config_source_column_of"]),
        "column_matching_rule": u["column_matching_rule"],
        "classification_matching_rule_values": u["classification_matching_rule_values"],
    }


def enum_value_sources(field_name: str, value: str, index: dict) -> list:
    return sorted(index[field_name]["classification_enum_values"].get(value, []))


def enum_value_has_matching_rule(field_name: str, value: str, index: dict) -> bool:
    return value in index[field_name]["classification_matching_rule_values"]
