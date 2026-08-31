"""Canonical status-string vocabulary, shared across every tool's status.py
so the same string isn't hand-typed (and liable to drift/typo) in four
different files. See CLAUDE.md's "Status vocabularies" table for which
stage uses which subset of these — this module doesn't enforce that
subsetting, it just gives every status.py one place to import a string
from instead of retyping it.

Frontend JS keeps its own literals rather than importing from here — no
Python/JS bridge exists for that, and per CLAUDE.md's "small duplication
over shared abstraction" convention, that's fine as long as the vocabulary
itself (this file) has one source of truth on the Python side."""

NOT_STARTED = "not_started"
NEEDS_REVIEW = "needs_review"
COMPLETE = "complete"
NOT_APPLICABLE = "not_applicable"
NOT_COMPLETE = "not_complete"
NOT_BUILT = "not_built"
STALE = "stale"

# collection.metadata's own vocabulary — distinct from the above (see
# home/prep's dashboard, which shows both side by side, and page-shell.css's
# .status-missing/-partial for how they're colored relative to the set above).
MISSING = "missing"
PARTIAL = "partial"

# collection's own checklist rollup (metadata_status/raw_data_status in
# collection/web/server.py) adds a fourth value on top of the three above:
# no confirmed source_url yet at all, distinct from "confirmed but nothing
# filled in" (missing).
NONE = "none"


def classification_overall(targets: dict) -> str:
    """Rolls up classification's per-target statuses into one: complete only
    if every *applicable* target is complete — a source with nothing to
    classify isn't incomplete, it's not_applicable itself. Shared by home's
    dashboard and prep's own table (previously copy-pasted identically in
    both) so the two can't drift out of sync on what "classified" means."""
    applicable = [s for s in targets.values() if s != NOT_APPLICABLE]
    if not applicable:
        return NOT_APPLICABLE
    if all(s == COMPLETE for s in applicable):
        return COMPLETE
    return NOT_COMPLETE
