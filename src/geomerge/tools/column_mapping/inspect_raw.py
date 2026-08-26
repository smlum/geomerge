"""Reads a raw source file and reports per-column stats (dtype, null count,
unique count, a few short sample values) — the evidence the column-mapping
review UI shows alongside each raw column's suggested target."""

from pathlib import Path

import geopandas as gpd
import pandas as pd

GEO_FORMATS = {"geojson", "shapefile", "gpkg"}


def truncate(value: str, max_len: int) -> str:
    return value if len(value) <= max_len else value[: max_len - 1] + "…"


def inspect_columns(raw_path: Path, fmt: str, sample_count: int = 3, sample_max_len: int = 25) -> list:
    if fmt in GEO_FORMATS:
        df = gpd.read_file(raw_path).drop(columns="geometry", errors="ignore")
    elif fmt == "parquet":
        df = pd.read_parquet(raw_path)
    elif fmt == "csv":
        df = pd.read_csv(raw_path)
    elif fmt == "json":
        df = pd.read_json(raw_path)
    else:
        raise ValueError(f"column inspection isn't supported yet for format '{fmt}'")

    columns = []
    for name in df.columns:
        series = df[name]
        samples = [truncate(str(v), sample_max_len) for v in series.dropna().unique()[:sample_count]]
        columns.append({
            "name": str(name),
            "dtype": str(series.dtype),
            "null_count": int(series.isna().sum()),
            "unique_count": int(series.nunique(dropna=True)),
            "samples": samples,
        })
    return columns
