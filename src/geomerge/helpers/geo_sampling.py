"""Random point sampling along line geometry, for showing a human a few
representative spots in Street View. Ground-up rewrite inspired by
scripts/classification-review/sample_points.py's approach (weighted-by-length
random point + short-tangent bearing) — generalized to sample a single
already-filtered GeoDataFrame on demand, rather than grouping+batch-writing a
manifest for a whole dataset up front."""

import math

import geopandas as gpd
import numpy as np


def ensure_projected(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    if gdf.crs is None:
        raise ValueError("input has no CRS defined")
    if gdf.crs.is_geographic:
        return gdf.to_crs(gdf.estimate_utm_crs())
    return gdf


def bearing(p1, p2) -> float:
    dx, dy = p2.x - p1.x, p2.y - p1.y
    return (math.degrees(math.atan2(dx, dy)) + 360) % 360


def _stringify(value) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    return str(value)


def sample_points(gdf: gpd.GeoDataFrame, n: int, seed: int = None) -> list:
    """Pick up to n random points along gdf's line geometry, weighted by
    segment length. Each point gets a lat/lng (WGS84), a facing heading for
    a Street View camera, and "values": every non-geometry column on the row
    it was drawn from — not just whatever columns the caller filtered by, so
    a reviewer can see e.g. a source_status the current target doesn't
    group by, without this module knowing anything about classification.
    Returns [] if gdf is empty or has zero total length (e.g. every row is a
    degenerate/empty geometry)."""
    if gdf.empty:
        return []

    gdf = ensure_projected(gdf)
    lines = gdf.geometry
    lengths = lines.length.to_numpy()
    total = lengths.sum()
    if total <= 0:
        return []

    value_columns = [c for c in gdf.columns if c != gdf.geometry.name]

    rng = np.random.default_rng(seed)
    weights = lengths / total
    picks = rng.choice(len(gdf), size=n, p=weights)
    to_wgs84 = gdf.crs.to_epsg() != 4326

    points = []
    for row_pos in picks:
        line = lines.iloc[row_pos]
        dist = rng.uniform(0, line.length)
        point = line.interpolate(dist)

        d1, d2 = max(dist - 1, 0), min(dist + 1, line.length)
        heading = bearing(line.interpolate(d1), line.interpolate(d2))

        point_wgs84 = (
            gpd.GeoSeries([point], crs=gdf.crs).to_crs("EPSG:4326").iloc[0] if to_wgs84 else point
        )
        line_wgs84 = gpd.GeoSeries([line], crs=gdf.crs).to_crs("EPSG:4326").iloc[0]
        row = gdf.iloc[row_pos]
        values = {c: _stringify(row[c]) for c in value_columns}
        points.append({
            "lat": point_wgs84.y,
            "lng": point_wgs84.x,
            "heading": round(heading, 1),
            "values": values,
            "segment": line_wgs84.__geo_interface__,
        })
    return points
