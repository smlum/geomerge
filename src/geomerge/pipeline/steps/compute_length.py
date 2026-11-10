"""Processing step: populates length_km with each segment's geodesic length —
measured on the ellipsoid of the geometry's own geographic CRS (WGS84 for
EPSG:4326), not in a projected CRS.

Geodesic rather than projected deliberately: a national dataset spans too
many zones for any one projection to keep length distortion negligible
everywhere (a Canada-wide Lambert conic is off by a few percent near its
edges), and picking a per-source UTM zone is just a less exact way of
getting the same answer. pyproj's Geod measures along the ellipsoid
directly, so it's exact anywhere, with nothing to configure. Geometry is
left untouched.
"""

def apply(data, *, source_id: str, config: dict):
    if data.crs is None or not data.crs.is_geographic:
        # standardize_crs (preprocessing) always leaves EPSG:4326, so this
        # only fires if the stage order or the target CRS changes.
        raise ValueError(f"compute_length expects a geographic CRS, got {data.crs}")

    geod = data.crs.get_geod()
    data["length_km"] = [
        geod.geometry_length(geom) / 1000 if geom is not None and not geom.is_empty else 0.0
        for geom in data.geometry
    ]

    warnings = []
    n_zero = int((data["length_km"] == 0).sum())
    if n_zero:
        warnings.append(f"{n_zero} segment(s) have zero length (empty or degenerate geometry)")
    return data, {"warnings": warnings}
