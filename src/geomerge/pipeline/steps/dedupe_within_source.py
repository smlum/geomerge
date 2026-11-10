"""Preprocessing step: removes duplicate segments within one source's own file
(non-spatial — not the cross-provider overlap problem, which is merge's
dedupe_spatial).

Not implemented yet — scaffolded as a pass-through (not a hard failure),
like assign_csd. Runs in preprocessing rather than processing so that
classification review, which reads preprocessing output, sees real group
counts rather than inflated ones.

Motivating case: on_hamilton_cycling's raw file is ~25x duplicated —
261,858 rows but only 10,632 distinct (the rest differ only by OBJECTID),
and those 10,632 cover just 3,673 distinct geometries. So two separate
problems to design for:
  1. exact duplicates (every column but the feature ID identical) — safe
     to drop, keep one;
  2. one geometry carrying several different attribute rows (status, type,
     ...) — needs a rule (keep which? flag for review?), not yet decided.
"""


def apply(data, *, source_id: str, config: dict):
    return data, {"warnings": []}
