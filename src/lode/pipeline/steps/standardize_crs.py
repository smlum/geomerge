"""Preprocessing step: reprojects to the target schema's declared CRS. If
geometry has no CRS metadata (e.g. just parsed from raw WKB with none
attached), assumes it's already the target CRS rather than guessing further."""

from pyproj import CRS

from lode.helpers.schema import get_field


def apply(data, *, source_id: str, config: dict):
    schema_path = config["repo_root"] / config["target_schema"]
    target_crs = CRS(get_field(schema_path, "geometry")["crs"])
    warnings = []

    if data.crs is None:
        data = data.set_crs(target_crs)
        warnings.append(f"geometry had no CRS metadata; assumed already {target_crs.to_string()}")
    elif data.crs != target_crs:
        data = data.to_crs(target_crs)

    return data, {"warnings": warnings}
