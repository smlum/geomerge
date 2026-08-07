"""Preprocessing step: stamps segment_id (unique within this run only, per
ccnd.yaml) and source_id onto every row. Runs last, after any step that
changes row count (e.g. exploding), so IDs reflect the final row set.

segment_id doesn't rely on any per-row ID from the source (many sources
don't have one) — it's just this run's row position, hex-encoded since
we're dealing with thousands of rows, not millions, so it stays short."""


def apply(data, *, source_id: str, config: dict):
    data = data.reset_index(drop=True)
    width = len(format(max(len(data) - 1, 0), "x")) or 1
    data["segment_id"] = [f"{source_id}_{i:0{width}x}" for i in range(len(data))]
    data["source_id"] = source_id
    return data, {}
