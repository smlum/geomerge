"""One note, one flag and one exclude switch per source, kept in that source's
metadata.yaml and shared by every stage — Collect's metadata modal, column
mapping's Flag & next, classification's source note box and Home's notes
popout all read and write these same three fields, rather than each stage
keeping its own copy.

- notes:    free text, whatever's worth knowing or doing about this source.
- flagged:  something about this source needs doing; the note says what.
            Never affects the pipeline. A flag can carry:
  - flag_reasons:     what's wrong, as codes from the project's own
                      `flag_reasons:` list in its geomerge.config.yaml
                      (DEFAULT_FLAG_REASONS if unset), each with a label and
                      optional colour — shown as pills on Home.
  - flag_status:      the follow-up — what to do next about it
                      (FLAG_STATUSES), independent of the reasons.
  - flag_status_date: when flag_status last changed — set automatically.
  All three are dropped when the flag is cleared.
- excluded: keep this source out of the pipeline entirely (see run.py's
            blocked_by), e.g. data that would be wrong if merged as-is.

Per-provider notes (checklist.csv — about finding data, before any source
exists) and per-mapping notes (classification_map.yaml — about one class
decision) are separate on purpose; see collection/status.py and
classification/status.py.
"""

from datetime import date
from pathlib import Path

import yaml

from geomerge.helpers.file_cache import cached_yaml

# Used only when the project's geomerge.config.yaml has no `flag_reasons:`
# of its own — a project's list replaces this, it doesn't extend it.
DEFAULT_FLAG_REASONS = {
    "missing_data": {"label": "Missing data"},
    "data_too_old": {"label": "Data too old"},
    "missing_licence": {"label": "Missing licence"},
}
# Catppuccin accents a reason pill can use (colors.css --ctp-*). A reason
# without its own `color:` takes the next one in this order. red is left
# out (excluded/conflict), as are peach/sapphire/mauve (FLAG_STATUSES' own).
REASON_COLORS = ("blue", "pink", "teal", "yellow", "maroon", "lavender", "flamingo", "sky", "green", "rosewater")
# The follow-up, not the problem — the same for every project, so fixed here.
# contact: the provider needs asking · waiting: asked, no reply yet ·
# review: ours to look at (a reply to read, or nothing external needed).
FLAG_STATUSES = ("contact", "waiting", "review")
DEFAULT_FLAG_STATUS = "review"
FLAG_FIELDS = ("flag_reasons", "flag_status", "flag_status_date")


def flag_reasons(config: dict) -> dict:
    """{code: {"label", "color"}}, in config order."""
    raw = config.get("flag_reasons") or DEFAULT_FLAG_REASONS
    out = {}
    for i, (code, spec) in enumerate(raw.items()):
        spec = spec or {}
        color = spec.get("color")
        out[code] = {
            "label": spec.get("label") or code.replace("_", " "),
            "color": color if color in REASON_COLORS else REASON_COLORS[i % len(REASON_COLORS)],
        }
    return out


def flag_markers(flagged, reasons, status, status_date) -> dict:
    """The flag fields as every reader sees them — empty unless flagged.
    Shared with checklist.csv's provider rows (collection/status.py)."""
    flagged = bool(flagged)
    # A stored status that's no longer one of FLAG_STATUSES reads as the
    # default, so an old file never blocks a save.
    if status not in FLAG_STATUSES:
        status = DEFAULT_FLAG_STATUS
    if isinstance(reasons, str):
        reasons = [r.strip() for r in reasons.split(";")]
    return {
        "flagged": flagged,
        "flag_reasons": [r for r in (reasons or []) if r] if flagged else [],
        "flag_status": ((status or DEFAULT_FLAG_STATUS) if flagged else ""),
        "flag_status_date": (str(status_date or "") if flagged else ""),
    }


def apply_flag_changes(current: dict, changes: dict) -> dict:
    """current: flag_markers() output. changes: any of flagged, flag_reasons,
    flag_status. Returns the new flag_markers(), stamping flag_status_date
    whenever the status changes (including a fresh flag starting at
    DEFAULT_FLAG_STATUS)."""
    flagged = bool(changes.get("flagged", current["flagged"]))
    if not flagged:
        return flag_markers(False, None, None, None)
    reasons = changes.get("flag_reasons", current["flag_reasons"])
    if not isinstance(reasons, list) or not all(isinstance(r, str) for r in reasons):
        raise ValueError("flag_reasons must be a list of reason codes")
    status = changes.get("flag_status") or current["flag_status"] or DEFAULT_FLAG_STATUS
    if status not in FLAG_STATUSES:
        raise ValueError(f"flag_status must be one of {', '.join(FLAG_STATUSES)}")
    old_status = current["flag_status"] if current["flagged"] else ""
    status_date = current["flag_status_date"] if status == old_status else str(date.today())
    # dedupe, keep order
    reasons = list(dict.fromkeys(r.strip() for r in reasons if r.strip()))
    return flag_markers(True, reasons, status, status_date)


def metadata_path(source_id: str, config: dict) -> Path:
    return config["repo_root"] / config["sources_dir"] / source_id / "metadata.yaml"


def _markers(metadata: dict) -> dict:
    return {
        "notes": (metadata.get("notes") or "").strip(),
        **flag_markers(
            metadata.get("flagged", False),
            metadata.get("flag_reasons"),
            metadata.get("flag_status"),
            metadata.get("flag_status_date"),
        ),
        "excluded": bool(metadata.get("excluded", False)),
    }


def source_markers(source_id: str, config: dict) -> dict:
    """{"notes", "flagged", "flag_reasons", "flag_status", "flag_status_date",
    "excluded"} — cached, cheap enough to call for every source on every
    dashboard load."""
    return _markers(cached_yaml(metadata_path(source_id, config)))


# Written right after `notes`, and only when set, so an unflagged source's
# metadata.yaml stays exactly as it was.
MARKER_KEYS = ("flagged", *FLAG_FIELDS, "excluded")


def update_source_markers(source_id: str, config: dict, **changes) -> dict:
    """Sets any of notes/flagged/flag_reasons/flag_status/excluded, leaving
    the rest of metadata.yaml alone. Reads the file fresh (not via the
    cache) since it writes it back."""
    unknown = set(changes) - {"notes", "flagged", "flag_reasons", "flag_status", "excluded"}
    if unknown:
        raise ValueError(f"unknown source marker(s): {', '.join(sorted(unknown))}")
    path = metadata_path(source_id, config)
    if not path.exists():
        raise FileNotFoundError(f"{source_id} has no metadata.yaml")

    data = yaml.safe_load(path.read_text()) or {}
    markers = _markers(data)
    if "notes" in changes:
        markers["notes"] = (changes["notes"] or "").strip()
    flag_changes = {k: changes[k] for k in ("flagged", "flag_reasons", "flag_status") if k in changes}
    if flag_changes:
        markers.update(apply_flag_changes(markers, flag_changes))
    if "excluded" in changes:
        markers["excluded"] = bool(changes["excluded"])

    marker_items = {"notes": markers["notes"]}
    if markers["flagged"]:
        marker_items["flagged"] = True
        if markers["flag_reasons"]:
            marker_items["flag_reasons"] = markers["flag_reasons"]
        marker_items["flag_status"] = markers["flag_status"]
        if markers["flag_status_date"]:
            marker_items["flag_status_date"] = markers["flag_status_date"]
    if markers["excluded"]:
        marker_items["excluded"] = True

    out = {}
    for key, value in data.items():
        if key in MARKER_KEYS:
            continue
        if key == "notes":
            out.update(marker_items)
        else:
            out[key] = value
    if "notes" not in data:
        out.update(marker_items)

    with open(path, "w") as f:
        yaml.dump(out, f, sort_keys=False, allow_unicode=True)
    return markers
