#!/usr/bin/env python3
"""Create/update checklist.csv from a providers directory's providers.csv.

Generic — not cycling-specific, reusable as-is by a future project.

name/portal_url/geography_level/province are informational, refreshed from
providers.csv on every run (edits to them here are overwritten — go fix
providers.csv instead). Every other column (prior_url, source_url, checked,
notes, flagged, contact, ...) is the actual working state and is preserved
across runs, matched by provider_id — one row per provider, always; a provider with more than one
relevant dataset gets multiple source_ids (comma-separated) on that same
row, not a duplicate row. See the collection web UI's metadata modal
("+ Add another source") for creating those.

prior_url (a lead from an earlier vintage, e.g. CCND) is permanent reference
data — nothing in the checklist workflow ever clears it, unlike source_url
(this cycle's confirmed judgment, which Not-found does clear on purpose).

Usage:
    python sync_checklist.py [--providers-csv path] [--checklist-csv path]
"""

import argparse
import sys
from pathlib import Path

import pandas as pd

from geomerge.helpers.config import load_config

# Refreshed from providers.csv on every run. Every other column already in
# checklist.csv is working state and is carried over as-is — including ones
# added later by the collection UI (flagged, contact, portal_license_*),
# which an explicit allowlist here used to silently drop.
INFO_COLUMNS = ["name", "portal_url", "geography_level", "province"]
# Guaranteed present even in a brand-new or older checklist.
WORK_COLUMNS = ["prior_url", "source_url", "checked", "checked_date", "source_ids", "notes", "flagged"]
COLUMN_ORDER = [
    "checked", "provider_id", "portal_url", "prior_url", "source_url",
    "name", "geography_level", "province", "checked_date", "source_ids", "notes", "flagged",
]


def main(argv=None):
    config = load_config()
    repo_root = config["repo_root"]
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--providers-csv", type=Path, default=repo_root / config["providers_csv"])
    parser.add_argument("--checklist-csv", type=Path, default=repo_root / config["sources_dir"] / "checklist.csv")
    args = parser.parse_args(argv)

    providers = pd.read_csv(args.providers_csv, dtype=str).fillna("")
    info = providers[["provider_id", "name", "portal_url", "geography_level", "province", "population_2021"]]

    column_order = list(COLUMN_ORDER)
    if args.checklist_csv.exists():
        prior = pd.read_csv(args.checklist_csv, dtype=str).fillna("")
        for col in WORK_COLUMNS:  # tolerate an older checklist missing a newly-added column
            if col not in prior.columns:
                prior[col] = ""
        work = prior.drop(columns=[c for c in INFO_COLUMNS if c in prior.columns])
        # The existing file's own column order, plus anything it's missing.
        column_order = list(prior.columns) + [c for c in COLUMN_ORDER if c not in prior.columns]
    else:
        work = pd.DataFrame(columns=["provider_id", *WORK_COLUMNS])

    checklist = info.merge(work, on="provider_id", how="left").fillna("")

    # Work order, not directory order: national first, then all province-level
    # rows as one block (alphabetically by province), then everything smaller
    # than province — still grouped by province within that last tier, biggest
    # population first, blanks sinking to the bottom of their own province
    # group rather than the whole table. Unlike providers.csv's own
    # alphabetical-by-geography_level order, this one's about prioritizing
    # review effort, not browsing.
    tier = checklist["geography_level"].map({"national": 0, "province": 1}).fillna(2).astype(int)
    population = pd.to_numeric(checklist["population_2021"], errors="coerce")
    checklist = (
        checklist.assign(_tier=tier, _population=population)
        .sort_values(
            ["_tier", "province", "_population"],
            ascending=[True, True, False],
            na_position="last",
            kind="stable",
        )
        .drop(columns=["_tier", "_population", "population_2021"])
        .reset_index(drop=True)
    )
    checklist = checklist[column_order]

    args.checklist_csv.parent.mkdir(parents=True, exist_ok=True)
    checklist.to_csv(args.checklist_csv, index=False)

    new_count = len(set(info["provider_id"]) - set(work["provider_id"]))
    print(f"Wrote {args.checklist_csv}")
    print(f"{new_count} new provider(s) added, {len(checklist)} total rows")


if __name__ == "__main__":
    sys.exit(main())
