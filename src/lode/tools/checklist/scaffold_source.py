#!/usr/bin/env python3
"""Manually scaffold <sources-dir>/<source_id>/metadata.yaml for a specific provider+slug.

Most sources should go through the checklist.csv + process_checklist.py
batch flow instead — this is for the manual exception: a provider with a
second (or third...) dataset where you want a meaningful slug (e.g. "mup")
rather than the batch script's auto "_cycling_2".

Usage:
    python scaffold_source.py --provider-id on_toronto --slug mup --source-url https://...
"""

import argparse
import sys
from datetime import date
from pathlib import Path

import pandas as pd
import yaml

from lode.helpers.paths import find_repo_root


def update_checklist(checklist_csv: Path, provider_id: str, source_id: str, source_url: str):
    if not checklist_csv.exists():
        print(f"Warning: {checklist_csv} doesn't exist — run sync_checklist.py first")
        return
    checklist = pd.read_csv(checklist_csv, dtype=str).fillna("")
    matches = checklist.index[checklist["provider_id"] == provider_id]
    if len(matches) == 0:
        print(f"Warning: '{provider_id}' not on the checklist — run sync_checklist.py first")
        return

    open_row = matches[checklist.loc[matches, "source_ids"] == ""]
    today = str(date.today())
    if len(open_row) > 0:
        idx = open_row[0]
    else:
        # Every existing row already has a source — duplicate one for this new source.
        idx = len(checklist)
        checklist.loc[idx] = checklist.loc[matches[0]]
        checklist.at[idx, "source_ids"] = ""

    checklist.at[idx, "source_url"] = source_url
    checklist.at[idx, "source_ids"] = source_id
    checklist.at[idx, "checked_date"] = today
    checklist.to_csv(checklist_csv, index=False)
    print(f"Updated checklist for {provider_id}")


def main(argv=None):
    repo_root = find_repo_root()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--provider-id", required=True)
    parser.add_argument("--slug", required=True, help="Short dataset label, e.g. cycling, mup")
    parser.add_argument("--source-url", default="", help="Dataset page URL, prefilled into the yaml and checklist")
    parser.add_argument("--providers-csv", type=Path, default=repo_root / "providers-directory" / "providers.csv")
    parser.add_argument("--checklist-csv", type=Path, default=repo_root / "sources" / "checklist.csv")
    parser.add_argument("--sources-dir", type=Path, default=repo_root / "sources")
    args = parser.parse_args(argv)

    providers = pd.read_csv(args.providers_csv, dtype=str).fillna("")
    matches = providers[providers["provider_id"] == args.provider_id]
    if matches.empty:
        raise ValueError(f"provider_id '{args.provider_id}' not found in {args.providers_csv}")
    provider = matches.iloc[0]

    source_id = f"{args.provider_id}_{args.slug}"
    out_path = args.sources_dir / source_id / "metadata.yaml"
    if out_path.exists():
        raise FileExistsError(f"{out_path} already exists")

    source = {
        "source_id": source_id,
        "provider_id": args.provider_id,
        "dataset_page_url": args.source_url,
        "download_url": "",
        "format": "",
        "license_name": provider["portal_license_name"],
        "license_url": provider["portal_license_url"],
        "contact": provider["contact"],
        "source_updated_date": "",
        "retrieved_date": str(date.today()),
        "data_dictionary_url": "",
        "raw_filename": "",
        "notes": "",
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        yaml.dump(source, f, sort_keys=False, allow_unicode=True)
    print(f"Wrote {out_path}")

    update_checklist(args.checklist_csv, args.provider_id, source_id, args.source_url)


if __name__ == "__main__":
    sys.exit(main())
