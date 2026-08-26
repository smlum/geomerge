"""Loads the project-level geomerge.config.yaml (see repo root) that tells
domain-agnostic tools where a given project keeps its schema, aliases, and
data directories. Returns the raw dict plus a resolved repo_root, so callers
just do `REPO_ROOT / config["some_key"]`."""

from pathlib import Path

import yaml

from geomerge.helpers.paths import find_repo_root


def load_config(start: Path = None) -> dict:
    repo_root = find_repo_root(start)
    config_path = repo_root / "geomerge.config.yaml"
    config = yaml.safe_load(config_path.read_text())
    config["repo_root"] = repo_root
    return config


def stage_output_dir(config: dict, stage_name: str) -> Path:
    """A pipeline stage's output_dir, resolved against repo_root — for tools
    that need to read a stage's output without hardcoding its path (e.g. it
    changed once already, when preprocessing was split out from processing)."""
    for stage in config["pipeline"]["stages"]:
        if stage["name"] == stage_name:
            return config["repo_root"] / stage["output_dir"]
    raise ValueError(f"no pipeline stage named '{stage_name}' in geomerge.config.yaml")
