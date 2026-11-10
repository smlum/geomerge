"""Overview computations for the Explore tab — headline numbers, a
geography x field breakdown, a per-source sanity table and a per-column
profile, all over the merged output (geomerge.config.yaml's explore.data).

Everything is weighted by the configured length field (km) as well as by
row count: segment lengths vary a lot between sources, so row shares alone
mislead. Usable without the Flask app, same as each tool's status.py.

Field kinds come from the target schema rather than pandas dtypes:
  categorical — a field with `categories` (e.g. canbics_class)
  numeric     — type float/integer
  text        — anything else (verbatim source_* values, ids, ...)
Columns in the data but not in the schema are profiled too, marked as such.
"""

import json
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq

from geomerge.helpers.file_cache import cached_read, cached_yaml

# Categorical colour slots (see web/style.css's --series-N). A field with more
# distinct values than this keeps the first SERIES_SLOTS - 1 and folds the
# rest into "Other" — never a generated 9th colour.
SERIES_SLOTS = 8
BLANK_KEY = "__none__"
OTHER_KEY = "__other__"

PROVIDER_COLUMNS = ["provider_id", "provider_name", "provider_province", "provider_geography_level"]


def explore_config(config: dict) -> dict:
    return config.get("explore") or {}


def data_path(config: dict) -> Path:
    return config["repo_root"] / explore_config(config)["data"]


def schema_fields(config: dict) -> list:
    return cached_yaml(config["repo_root"] / config["target_schema"]).get("fields", [])


def _read_attributes(path: Path) -> pd.DataFrame:
    """Every column except geometry — the Overview never needs shapes, and
    skipping them makes the read several times faster."""
    schema = pq.read_schema(path)
    geo = json.loads(schema.metadata[b"geo"])["primary_column"] if b"geo" in (schema.metadata or {}) else "geometry"
    return pd.read_parquet(path, columns=[n for n in schema.names if n != geo])


def _read_providers(path: Path) -> pd.DataFrame:
    return pd.read_csv(path, dtype=str).fillna("")


def load_frame(config: dict) -> pd.DataFrame:
    """The merged attributes plus provider_* columns joined per source (via
    each source's metadata.yaml provider_id -> providers_csv). The parquet
    read is cached until the merged file changes."""
    df = cached_read(data_path(config), _read_attributes).copy()

    providers = cached_read(config["repo_root"] / config["providers_csv"], _read_providers).set_index("provider_id")
    sources_dir = config["repo_root"] / config["sources_dir"]
    per_source = {}
    for source_id in df["source_id"].dropna().unique():
        provider_id = cached_yaml(sources_dir / source_id / "metadata.yaml").get("provider_id", "")
        row = providers.loc[provider_id] if provider_id in providers.index else None
        per_source[source_id] = {
            "provider_id": provider_id or None,
            "provider_name": row["name"] if row is not None else None,
            "provider_province": row["province"] if row is not None else None,
            "provider_geography_level": row["geography_level"] if row is not None else None,
        }
    for column in PROVIDER_COLUMNS:
        df[column] = df["source_id"].map(lambda s: per_source.get(s, {}).get(column))
    return df


def apply_filters(df: pd.DataFrame, filters: dict) -> pd.DataFrame:
    """Rows where every {column: value} matches (compared as text). Callers
    only pass columns they allow filtering on — see the server's
    request_filters()."""
    for column, value in filters.items():
        df = df[df[column].astype("string") == value]
    return df


def is_blank(series: pd.Series) -> pd.Series:
    if pd.api.types.is_numeric_dtype(series):
        return series.isna()
    return series.isna() | (series.astype("string").str.strip() == "")


def field_kinds(config: dict, df: pd.DataFrame) -> list:
    """[{name, kind, in_schema, categories}] in schema order, then any extra
    data columns (provider_* last). Geometry is skipped."""
    result, seen = [], set()
    for f in schema_fields(config):
        name = f["name"]
        if name not in df.columns or f.get("type") == "geometry":
            continue
        seen.add(name)
        categories = [{"code": c["code"], "label": c.get("label", c["code"])} for c in f.get("categories") or []]
        if categories:
            kind = "categorical"
        elif f.get("type") in ("float", "integer"):
            kind = "numeric"
        else:
            kind = "text"
        result.append({"name": name, "kind": kind, "in_schema": True, "categories": categories})
    for name in df.columns:
        if name in seen:
            continue
        kind = "numeric" if pd.api.types.is_numeric_dtype(df[name]) else "text"
        result.append({"name": name, "kind": kind, "in_schema": False, "categories": []})
    return result


def _pct(part: float, whole: float) -> float:
    return round(100 * part / whole, 1) if whole else 0.0


def headline(df: pd.DataFrame, length: str, primary: str) -> dict:
    total_km = float(df[length].sum())
    classified_km = float(df.loc[~is_blank(df[primary]), length].sum()) if primary in df else 0.0
    return {
        "km": round(total_km, 1),
        "segments": int(len(df)),
        "sources": int(df["source_id"].nunique()),
        "providers": int(df["provider_id"].nunique()),
        "provinces": int(df["provider_province"].nunique()),
        "primary_field": primary,
        "primary_classified_pct": _pct(classified_km, total_km),
    }


def sources_table(df: pd.DataFrame, length: str, primary: str) -> list:
    blank_primary = is_blank(df[primary]) if primary in df else pd.Series(False, index=df.index)
    grouped = df.assign(_blank_km=df[length].where(blank_primary, 0.0)).groupby("source_id")
    rows = []
    for source_id, g in grouped:
        km = float(g[length].sum())
        rows.append({
            "source_id": source_id,
            "provider_name": g["provider_name"].iloc[0],
            "province": g["provider_province"].iloc[0],
            "km": round(km, 1),
            "segments": int(len(g)),
            "mean_m": round(1000 * km / len(g), 1) if len(g) else 0.0,
            "max_km": round(float(g[length].max()), 2),
            "primary_blank_pct": _pct(float(g["_blank_km"].sum()), km),
        })
    rows.sort(key=lambda r: -r["km"])
    return rows


def column_profile(df: pd.DataFrame, kinds: list, length: str, top_n: int = 6) -> list:
    total_km = float(df[length].sum())
    profile = []
    for f in kinds:
        s = df[f["name"]]
        filled = ~is_blank(s)
        entry = {
            "name": f["name"],
            "kind": f["kind"],
            "in_schema": f["in_schema"],
            "filled_pct": _pct(int(filled.sum()), len(df)),
            "filled_km_pct": _pct(float(df.loc[filled, length].sum()), total_km),
            "distinct": int(s[filled].nunique()),
        }
        if f["kind"] == "numeric" and filled.any():
            values = pd.to_numeric(s[filled], errors="coerce")
            entry.update({
                "min": round(float(values.min()), 3),
                "median": round(float(values.median()), 3),
                "max": round(float(values.max()), 3),
            })
        elif filled.any():
            # A near-unique column (ids) has no meaningful "top values".
            entry["mostly_unique"] = entry["distinct"] > 0.9 * int(filled.sum())
            if not entry["mostly_unique"]:
                values = s[filled].astype("string")
                by_km = df.loc[filled, length].groupby(values).sum().sort_values(ascending=False)
                counts = values.value_counts()
                entry["top"] = [
                    {"value": str(v), "km_pct": _pct(float(km), total_km), "rows_pct": _pct(int(counts[v]), len(df))}
                    for v, km in by_km.head(top_n).items()
                ]
        profile.append(entry)
    return profile


def breakdown(df: pd.DataFrame, kinds: list, geo: str, field: str, length: str, colors: dict = None) -> dict:
    """km and row counts per geography value x field value. Series keep the
    schema's category order (so a value's colour slot never depends on the
    current data); values beyond SERIES_SLOTS fold into Other; blanks are
    their own None series. `colors` ({value: [light, dark]}, from
    explore.colors.<field>) gives a series a fixed colour instead of its slot."""
    colors = colors or {}
    kind = next((f for f in kinds if f["name"] == field), None)
    if kind is None:
        raise ValueError(f"unknown field '{field}'")
    if geo not in df.columns:
        raise ValueError(f"unknown geography column '{geo}'")

    values = df[field].astype("string")
    blank = is_blank(df[field])
    present = set(values[~blank].unique())

    if kind["categories"]:
        ordered = [(c["code"], c["label"]) for c in kind["categories"]]
        ordered += [(v, v) for v in sorted(present - {c for c, _ in ordered})]
    else:
        by_km = df.loc[~blank, length].groupby(values[~blank]).sum().sort_values(ascending=False)
        ordered = [(v, v) for v in by_km.index]

    if len(ordered) > SERIES_SLOTS:
        kept, folded = ordered[:SERIES_SLOTS - 1], {c for c, _ in ordered[SERIES_SLOTS - 1:]}
    else:
        kept, folded = ordered, set()

    series = [
        {"key": code, "label": label, "slot": i + 1, "color": colors.get(code)}
        for i, (code, label) in enumerate(kept)
    ]
    if folded & present:
        series.append({"key": OTHER_KEY, "label": "Other", "slot": "other"})
    if blank.any():
        series.append({"key": BLANK_KEY, "label": "None", "slot": "none"})

    keyed = values.where(~values.isin(folded), OTHER_KEY).where(~blank, BLANK_KEY)
    # "(blank)", same wording as the classification review page.
    geo_values = df[geo].astype("string").where(~is_blank(df[geo]), "(blank)")
    grouped = df.assign(_geo=geo_values, _key=keyed).groupby(["_geo", "_key"])[length].agg(["sum", "count"])

    rows = {}
    for (g, key), r in grouped.iterrows():
        row = rows.setdefault(g, {"geo": g, "km": 0.0, "segments": 0, "values": {}})
        row["values"][key] = {"km": round(float(r["sum"]), 2), "segments": int(r["count"])}
        row["km"] += float(r["sum"])
        row["segments"] += int(r["count"])
    for row in rows.values():
        row["km"] = round(row["km"], 1)

    totals = {}
    for row in rows.values():
        for key, v in row["values"].items():
            t = totals.setdefault(key, {"km": 0.0, "segments": 0})
            t["km"] += v["km"]
            t["segments"] += v["segments"]
    for t in totals.values():
        t["km"] = round(t["km"], 1)

    return {
        "geo": geo,
        "field": field,
        "series": series,
        "rows": sorted(rows.values(), key=lambda r: -r["km"]),
        "totals": totals,
    }
