"""One note, one flag and one exclude switch per source, kept in that source's
metadata.yaml and shared by every stage — Collect's metadata modal, column
mapping's Flag & next, classification's source note box and Home's notes
popout all read and write these same three fields, rather than each stage
keeping its own copy.

- notes:    free text, whatever's worth knowing or doing about this source.
- flagged:  something about this source needs doing; the note says what.
            Never affects the pipeline.
- excluded: keep this source out of the pipeline entirely (see run.py's
            blocked_by), e.g. data that would be wrong if merged as-is.

Per-provider notes (checklist.csv — about finding data, before any source
exists) and per-mapping notes (classification_map.yaml — about one class
decision) are separate on purpose; see collection/status.py and
classification/status.py.
"""

from pathlib import Path

import yaml

from geomerge.helpers.file_cache import cached_yaml

# Written right after `notes`, and only when true, so an unflagged source's
# metadata.yaml stays exactly as it was.
BOOLEAN_FIELDS = ("flagged", "excluded")


def metadata_path(source_id: str, config: dict) -> Path:
    return config["repo_root"] / config["sources_dir"] / source_id / "metadata.yaml"


def _markers(metadata: dict) -> dict:
    return {
        "notes": (metadata.get("notes") or "").strip(),
        "flagged": bool(metadata.get("flagged", False)),
        "excluded": bool(metadata.get("excluded", False)),
    }


def source_markers(source_id: str, config: dict) -> dict:
    """{"notes", "flagged", "excluded"} — cached, cheap enough to call for
    every source on every dashboard load."""
    return _markers(cached_yaml(metadata_path(source_id, config)))


def update_source_markers(source_id: str, config: dict, **changes) -> dict:
    """Sets any of notes/flagged/excluded, leaving the rest of metadata.yaml
    alone. Reads the file fresh (not via the cache) since it writes it back."""
    unknown = set(changes) - {"notes", *BOOLEAN_FIELDS}
    if unknown:
        raise ValueError(f"unknown source marker(s): {', '.join(sorted(unknown))}")
    path = metadata_path(source_id, config)
    if not path.exists():
        raise FileNotFoundError(f"{source_id} has no metadata.yaml")

    data = yaml.safe_load(path.read_text()) or {}
    markers = _markers(data)
    if "notes" in changes:
        markers["notes"] = (changes["notes"] or "").strip()
    for field in BOOLEAN_FIELDS:
        if field in changes:
            markers[field] = bool(changes[field])

    marker_items = {"notes": markers["notes"], **{f: True for f in BOOLEAN_FIELDS if markers[f]}}
    out = {}
    for key, value in data.items():
        if key in BOOLEAN_FIELDS:
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
