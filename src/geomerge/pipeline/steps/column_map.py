"""Preprocessing step: renames/drops raw columns per a source's column_map.yaml."""

import geopandas as gpd
import yaml


def apply(data, *, source_id: str, config: dict):
    repo_root = config["repo_root"]
    column_map_path = repo_root / config["sources_dir"] / source_id / "column_map.yaml"
    if not column_map_path.exists():
        raise FileNotFoundError(f"no column_map.yaml for {source_id}")

    saved = yaml.safe_load(column_map_path.read_text()) or {}
    column_map = saved.get("column_map", {})
    dropped = set(saved.get("dropped", []))

    # Real geometry already present (e.g. from a geojson/shapefile source) is
    # always kept — column_mapping never asks a source to account for it
    # unless a different raw column was explicitly remapped onto "geometry".
    accounted = set(column_map) | dropped
    if isinstance(data, gpd.GeoDataFrame):
        accounted.add(data.geometry.name)

    warnings = []
    unaccounted = [c for c in data.columns if c not in accounted]
    if unaccounted:
        warnings.append(f"columns not in column_map.yaml, dropped: {', '.join(unaccounted)}")

    missing = [c for c in column_map if c not in data.columns]
    if missing:
        warnings.append(f"column_map.yaml references columns no longer in the raw file: {', '.join(missing)}")

    data = data.rename(columns=column_map)
    data = data.drop(columns=list(dropped) + unaccounted, errors="ignore")

    return data, {"warnings": warnings, "dropped_columns": sorted(dropped | set(unaccounted))}
