"""Reads a raw source file and reports per-column stats (dtype, null count,
unique count, a few short sample values) — the evidence the column-mapping
review UI shows alongside each raw column's suggested target."""

import json
import re
from pathlib import Path

import geopandas as gpd
import pandas as pd

GEO_FORMATS = {"geojson", "shapefile", "gpkg"}

# GeoJSON has no up-front schema, so reading its field names means scanning
# the whole file (~4s for a 240MB one). Above this size, field names come
# from the first features instead (_geojson_sample_names). Not for smaller
# files: a field present only in later features (seen in this project) would
# be missed, and their full scan is cheap enough — and cached on disk.
GEOJSON_SAMPLE_ABOVE_BYTES = 50_000_000
_PROPERTIES = re.compile(r'"properties"\s*:\s*')


def _geojson_sample_names(raw_path: Path, max_bytes: int = 4_000_000, max_features: int = 200):
    """Union of the first features' property names (from the first
    max_bytes), or None if none could be parsed. Starts after "features" so
    a "crs" block's own "properties" isn't counted."""
    with open(raw_path, "rb") as f:
        text = f.read(max_bytes).decode("utf-8", errors="ignore")
    start = text.find('"features"')
    if start < 0:
        return None
    decoder = json.JSONDecoder()
    names, found = set(), 0
    for m in _PROPERTIES.finditer(text, start):
        try:
            props, _ = decoder.raw_decode(text, m.end())
        except ValueError:
            break  # cut off at the end of the sample
        if isinstance(props, dict):
            names.update(props)
            found += 1
            if found >= max_features:
                break
    return names if found else None


def raw_column_names(raw_path: Path, fmt: str) -> set:
    """Just the column names, as cheaply as each format allows — for
    status.py's source_status(), called for every source on every dashboard
    load/"save & next" click, where only the raw column *names* matter, not
    inspect_columns()'s much more expensive per-column stats (nulls/uniques/
    samples), which only the single-source review page actually needs.

    For a 229MB real-world GeoJSON in this project, gpd.read_file() (what
    inspect_columns() uses) took ~11s; pyogrio.read_info() (below) took ~4s
    for the same file — real but partial relief, since GeoJSON has no
    upfront schema section (unlike shapefile/gpkg), so OGR still has to scan
    the file regardless of API used. status.py's own mtime-keyed cache is
    what actually fixes repeat calls; this only helps the first one.
    """
    if fmt == "geojson" and raw_path.stat().st_size > GEOJSON_SAMPLE_ABOVE_BYTES:
        sampled = _geojson_sample_names(raw_path)
        if sampled is not None:
            return sampled
    if fmt in GEO_FORMATS:
        import pyogrio
        return set(pyogrio.read_info(str(raw_path))["fields"])
    elif fmt == "parquet":
        import pyarrow.parquet as pq
        return set(pq.ParquetFile(raw_path).schema_arrow.names)
    elif fmt == "csv":
        return set(pd.read_csv(raw_path, nrows=0).columns.astype(str))
    else:
        # No cheap partial-read known to be safe for this format (e.g. json,
        # currently 5 sources, none of them shown to be a bottleneck) — fall
        # back to the full inspect rather than risk a format-specific
        # shortcut nobody's verified against real files of that shape.
        return {c["name"] for c in inspect_columns(raw_path, fmt)}


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
