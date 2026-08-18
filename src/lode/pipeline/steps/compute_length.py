"""Processing step: reprojects to a projected CRS to compute length_km, then
discards that projection — the stored geometry stays in the target schema's
CRS (EPSG:4326).

Not implemented yet — which projected CRS to use hasn't been decided.
Scaffolded as a pass-through (not a hard failure) so the processing/merge
stage wiring is testable end-to-end ahead of that.
"""


def apply(data, *, source_id: str, config: dict):
    return data, {"warnings": ["compute_length not implemented yet — length_km not populated"]}
