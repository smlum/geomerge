#!/usr/bin/env python3
"""Stamp checked_date for checklist rows marked checked by hand (e.g. direct
CSV edits) that don't have one yet. The web UI (web/server.py) already stamps
checked_date itself on every Found/Not found click, so this only matters for
rows checked off outside the UI.

Yaml generation lives in web/server.py, not here — this script never creates
or touches sources/<source_id>/metadata.yaml.

Usage:
    python process_checklist.py [--checklist-csv path]
"""

import argparse
import sys
from datetime import date
from pathlib import Path

import pandas as pd

from lode.helpers.paths import find_repo_root


def main(argv=None):
    repo_root = find_repo_root()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--checklist-csv", type=Path, default=repo_root / "sources" / "checklist.csv")
    args = parser.parse_args(argv)

    if not args.checklist_csv.exists():
        raise FileNotFoundError(f"{args.checklist_csv} doesn't exist — run sync_checklist.py first")

    checklist = pd.read_csv(args.checklist_csv, dtype=str).fillna("")
    today = str(date.today())

    stamped = []
    for i, row in checklist.iterrows():
        if row["checked"] and not row["checked_date"]:
            checklist.at[i, "checked_date"] = today
            stamped.append(row["provider_id"])

    checklist.to_csv(args.checklist_csv, index=False)
    print(f"Stamped checked_date for {len(stamped)} row(s): {', '.join(stamped) if stamped else '(none)'}")


if __name__ == "__main__":
    sys.exit(main())
