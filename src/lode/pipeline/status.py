"""Read-only status for pipeline stages — has a stage's output been
generated for a source, and is it stale relative to the inputs it's cheap to
check. No pipeline run happens here; this only inspects what's already on
disk, for lode tools home's dashboard."""

from pathlib import Path

import yaml

from lode.helpers.config import stage_output_dir


def load_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text()) or {} if path.exists() else {}


def _mtime(path: Path):
    return path.stat().st_mtime if path.exists() else None


def _newest_mtime(paths):
    mtimes = [m for p in paths if (m := _mtime(p)) is not None]
    return max(mtimes) if mtimes else None


def preprocessing_status(source_id: str, config: dict) -> str:
    """not_built | stale | complete — stale if the raw file or
    column_map.yaml changed more recently than the preprocessing output."""
    repo_root = config["repo_root"]
    output_path = stage_output_dir(config, "preprocessing") / source_id / f"{source_id}.parquet"
    if not output_path.exists():
        return "not_built"

    source_dir = repo_root / config["sources_dir"] / source_id
    metadata = load_yaml(source_dir / "metadata.yaml")
    raw_filename = metadata.get("raw_filename")
    inputs = [source_dir / "column_map.yaml"]
    if raw_filename:
        inputs.append(repo_root / config["raw_dir"] / source_id / raw_filename)

    newest_input = _newest_mtime(inputs)
    output_mtime = _mtime(output_path)
    if newest_input and output_mtime and newest_input > output_mtime:
        return "stale"
    return "complete"


def processing_status(source_id: str, config: dict) -> str:
    """not_built | stale | complete — stale if the preprocessing output or
    classification_map.yaml changed more recently than the processing output."""
    repo_root = config["repo_root"]
    output_path = stage_output_dir(config, "processing") / source_id / f"{source_id}.parquet"
    if not output_path.exists():
        return "not_built"

    preprocessing_output = stage_output_dir(config, "preprocessing") / source_id / f"{source_id}.parquet"
    classification_map_path = repo_root / config["sources_dir"] / source_id / "classification_map.yaml"

    newest_input = _newest_mtime([preprocessing_output, classification_map_path])
    output_mtime = _mtime(output_path)
    if newest_input and output_mtime and newest_input > output_mtime:
        return "stale"
    return "complete"
