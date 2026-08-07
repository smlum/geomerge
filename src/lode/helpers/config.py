"""Loads the project-level lode.config.yaml (see repo root) that tells
domain-agnostic tools where a given project keeps its schema, aliases, and
data directories. Returns the raw dict plus a resolved repo_root, so callers
just do `REPO_ROOT / config["some_key"]`."""

from pathlib import Path

import yaml

from lode.helpers.paths import find_repo_root


def load_config(start: Path = None) -> dict:
    repo_root = find_repo_root(start)
    config_path = repo_root / "lode.config.yaml"
    config = yaml.safe_load(config_path.read_text())
    config["repo_root"] = repo_root
    return config
