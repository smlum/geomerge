"""Sentinel values shared between the classification tool and the pipeline
step that applies its output, so the two can't drift out of sync."""

# A classification decision meaning "this raw value combination shouldn't be
# in the output at all" — not a real target class. classify:apply drops any
# row where a target resolves to this, for whichever target it was set on.
NOT_INCLUDED = "not_included"

# A classification decision meaning "no target value applies to this raw
# value combination, but keep the row" — e.g. a source's surface_type isn't
# trustworthy for one particular raw value, without dropping the segment
# from the dataset entirely. Unlike NOT_INCLUDED, classify:apply never folds
# this into the row-exclusion check; it just leaves the target field blank
# for that row.
IGNORED = "ignored"

# Optional per-mapping review markers in classification_map.yaml. "unsure" is
# a best guess to re-check later (cleared once re-reviewed); "conflict" is a
# standing record that the decision disagrees with what the source's own
# label implies. Neither affects status or classify:apply — a flagged mapping
# is still a decided one.
REVIEW_FLAGS = ("unsure", "conflict")
