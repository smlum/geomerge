"""Sentinel values shared between the classification tool and the pipeline
step that applies its output, so the two can't drift out of sync."""

# A classification decision meaning "this raw value combination shouldn't be
# in the output at all" — not a real target class. classify:apply drops any
# row where a target resolves to this, for whichever target it was set on.
NOT_INCLUDED = "not_included"
