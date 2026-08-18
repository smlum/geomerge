"""Processing step: spatial-joins each segment's midpoint against StatCan CSD
polygons (data/reference/statcan_csd_2021.parquet) to populate csduid,
csdname, and province.

Not implemented yet — the CSD reference data still needs validation before
this step is built out. Scaffolded as a pass-through (not a hard failure) so
the processing/merge stage wiring is testable end-to-end ahead of that.
"""


def apply(data, *, source_id: str, config: dict):
    return data, {"warnings": ["assign_csd not implemented yet — csduid/csdname/province not populated"]}
