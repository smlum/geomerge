#!/usr/bin/env python3
"""Write every flagged source and provider to one markdown checklist, so you
can read follow-ups (e.g. on GitHub) without running the web UI.

Read-only view: flags live in sources/<id>/metadata.yaml and checklist.csv,
and are edited in the app. Ticked boxes are carried over when the file is
regenerated (matched by the `id` on each line), so someone can tick off what
they've done before the flag itself is cleared.

Usage:
    geomerge tools followups [--output path]
"""

import argparse
import re
from datetime import date
from pathlib import Path

from geomerge.helpers.config import load_config
from geomerge.helpers.file_cache import cached_yaml
from geomerge.helpers.source_notes import FLAG_STATUSES, flag_reasons, source_markers
from geomerge.tools.collection.status import flagged_providers, provider_row

OTHER_GROUP = "Other"
STATUS_HEADINGS = {"contact": "Contact", "waiting": "Waiting on reply", "review": "Review"}
TICKED = re.compile(r"^- \[[xX]\] .*?`([^`]+)`")


def _ticked_ids(path: Path) -> set:
    if not path.exists():
        return set()
    return {m.group(1) for line in path.read_text().splitlines() if (m := TICKED.match(line))}


def _source_items(config: dict) -> list:
    sources_dir = config["repo_root"] / config["sources_dir"]
    items = []
    for path in sorted(sources_dir.glob("*/metadata.yaml")):
        source_id = path.parent.name
        markers = source_markers(source_id, config)
        if not markers["flagged"]:
            continue
        metadata = cached_yaml(path)
        provider = provider_row(metadata.get("provider_id"), config)
        items.append({
            "id": source_id,
            "kind": "source",
            "name": provider.get("name") or source_id,
            "title": (metadata.get("dataset_title") or "").strip(),
            "province": provider.get("province", ""),
            "url": metadata.get("dataset_page_url") or metadata.get("download_url") or "",
            "contact": (metadata.get("contact") or "").strip() or (provider.get("contact") or "").strip(),
            **markers,
        })
    return items


def _provider_items(config: dict) -> list:
    return [
        {
            "id": p["provider_id"],
            "kind": "provider",
            "name": p["name"],
            "province": p["province"],
            "url": p["source_url"] or p["portal_url"],
            "contact": p["contact"].strip(),
            "notes": p["notes"].strip(),
            **{k: p[k] for k in ("flag_reasons", "flag_status", "flag_status_date")},
        }
        for p in flagged_providers(config)
    ]


def _render_item(item: dict, reasons: dict, ticked: set) -> list:
    box = "x" if item["id"] in ticked else " "
    labels = [reasons.get(r, {}).get("label", r) for r in item["flag_reasons"]]
    head = [f"**{item['name']}**"]
    if item.get("title"):
        head.append(f"_{item['title']}_")
    if item["province"]:
        head.append(item["province"])
    head.append(f"`{item['id']}`" + (" (provider)" if item["kind"] == "provider" else ""))
    if labels:
        head.append(", ".join(labels))
    lines = [f"- [{box}] " + " · ".join(head)]

    details = []
    if item["url"]:
        details.append(f"[Dataset]({item['url']})" if item["kind"] == "source" else f"[Page]({item['url']})")
    contact = item["contact"]
    if contact:
        details.append(f"<{contact}>" if contact.startswith("http") or "@" in contact else contact)
    elif item["flag_status"] == "contact":
        details.append("**no contact on file. Find one first**")
    if details:
        lines.append("  - " + " · ".join(details))
    note = item["notes"] or "_(no note)_"
    note_lines = note.splitlines()
    lines.append("  - " + note_lines[0])
    lines += ["    " + l for l in note_lines[1:]]
    return lines


def render(config: dict, ticked: set) -> str:
    reasons = flag_reasons(config)
    items = _source_items(config) + _provider_items(config)
    out = [
        "# Follow-ups",
        "",
        f"_Generated {date.today()} by `geomerge tools followups` from each source's metadata.yaml "
        "and checklist.csv. Don't edit by hand except to tick boxes; ticks are kept when "
        "the file is regenerated. Flags themselves are cleared in the app._",
        "",
        f"{sum(i['kind'] == 'source' for i in items)} sources · "
        f"{sum(i['kind'] == 'provider' for i in items)} providers",
    ]
    # Sections: the reason groups from config (flag_reasons' `group:`), in
    # order of first appearance; an item goes under its first reason's
    # group, so it's listed once. Within each, by status.
    group_order = list(dict.fromkeys(r["group"] for r in reasons.values() if r["group"])) + [OTHER_GROUP]

    def group_of(item):
        for code in item["flag_reasons"]:
            if reasons.get(code, {}).get("group"):
                return reasons[code]["group"]
        return OTHER_GROUP

    for group in group_order:
        in_group = [i for i in items if group_of(i) == group]
        if not in_group:
            continue
        out += ["", f"## {group} ({len(in_group)})"]
        for status in FLAG_STATUSES:
            rows = sorted(
                (i for i in in_group if i["flag_status"] == status),
                key=lambda i: (i["kind"] != "source", i["province"], i["name"]),
            )
            if not rows:
                continue
            out += ["", f"### {STATUS_HEADINGS.get(status, status)} ({len(rows)})", ""]
            for item in rows:
                out += _render_item(item, reasons, ticked)
    return "\n".join(out) + "\n"


def main(argv=None):
    config = load_config()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, default=config["repo_root"] / config.get("followups_md", "FOLLOWUPS.md"))
    args = parser.parse_args(argv)

    args.output.write_text(render(config, _ticked_ids(args.output)))
    print(f"Wrote {args.output}")
