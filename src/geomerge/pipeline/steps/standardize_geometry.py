"""Preprocessing step: ensures geometry is real (parsing WKB/WKT if it just
got renamed from a raw column, not yet typed), explodes multi-part geometry,
and drops/logs anything that doesn't match the target schema's declared
geometry_type. Leaves CRS untouched — that's standardize_crs's job."""

import geopandas as gpd

from geomerge.helpers.schema import get_field


def apply(data, *, source_id: str, config: dict):
    if "geometry" not in data.columns:
        raise ValueError("no geometry column present after column mapping")

    schema_path = config["repo_root"] / config["target_schema"]
    target_type = get_field(schema_path, "geometry")["geometry_type"]

    warnings = []
    if not isinstance(data["geometry"], gpd.GeoSeries):
        try:
            geom = gpd.GeoSeries.from_wkb(data["geometry"])
        except Exception:
            geom = gpd.GeoSeries.from_wkt(data["geometry"].astype(str))
        data = gpd.GeoDataFrame(data.drop(columns="geometry"), geometry=geom)
        warnings.append("geometry wasn't already typed as geometry; parsed from WKB/WKT")

    data = data.explode(index_parts=False)
    rows_exploded = len(data)
    data = data[data.geometry.geom_type == target_type].copy()
    wrong_type_dropped = rows_exploded - len(data)
    if wrong_type_dropped:
        warnings.append(f"dropped {wrong_type_dropped} row(s) not matching geometry_type {target_type} after exploding")

    return data, {"warnings": warnings}
