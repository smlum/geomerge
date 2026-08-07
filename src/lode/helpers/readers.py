"""Reads a tabular/geospatial source file by its declared format string,
geometry included — shared by any tool or pipeline step that needs the
actual data (not just column inspection, which drops geometry on purpose;
see column_mapping/inspect_raw.py)."""

from pathlib import Path

import geopandas as gpd
import pandas as pd

GEO_FORMATS = {"geojson", "shapefile", "gpkg"}


def read_source_file(path: Path, fmt: str):
    if fmt in GEO_FORMATS:
        return gpd.read_file(path)
    if fmt == "parquet":
        # Not gpd.read_parquet(): it picks a "primary" geometry column from
        # the file's own metadata, which can be wrong (e.g. a point label
        # column marked primary over the real line geometry). Column mapping
        # decides which column is geometry explicitly instead.
        return pd.read_parquet(path)
    if fmt == "csv":
        return pd.read_csv(path)
    if fmt == "json":
        return pd.read_json(path)
    raise ValueError(f"reading isn't supported yet for format '{fmt}'")
