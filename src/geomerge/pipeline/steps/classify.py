"""Processing step: applies each source's classification_map.yaml (built via
`geomerge tools classification review`) to derive schema/ccnd.yaml's harmonized
target attributes (canbics_class, status, surface_type, snow_removal) from
raw source columns.

Each target is looked up on whichever of its configured source_columns
(geomerge.config.yaml's tools.classification.targets) are actually present in
this source's data — a source missing some of them still gets classified on
the ones it has.

canbics_class also drives classification_method/classification_notes
(schema/ccnd.yaml) — the only target attribute those track, since it's the
one every published segment must have.
"""

import pandas as pd
import yaml

from geomerge.helpers.constants import IGNORED, NOT_INCLUDED
from geomerge.helpers.schema import is_required


def _stringify(value) -> str:
    if value is None or (isinstance(value, float) and value != value):  # NaN
        return ""
    return str(value)


def apply(data, *, source_id: str, config: dict):
    repo_root = config["repo_root"]
    targets = config["tools"]["classification"]["targets"]

    classification_map_path = repo_root / config["sources_dir"] / source_id / "classification_map.yaml"
    saved = yaml.safe_load(classification_map_path.read_text()) if classification_map_path.exists() else {}
    saved = saved or {}

    warnings = []
    excluded = None  # boolean Series, OR'd across every target that resolves to NOT_INCLUDED

    for target, target_config in targets.items():
        source_columns = [c for c in target_config["source_columns"] if c in data.columns]

        # No source columns: skipped, unless the target schema marks the
        # target required — then the review UI offered a single whole-source
        # "all rows" group, saved as a mapping with values {}, applied below
        # to every row via the empty key ().
        if not source_columns and not is_required(repo_root / config["target_schema"], target):
            if target == "status":
                # schema/ccnd.yaml: "Absent means the source doesn't
                # distinguish status (treated as existing)."
                data["status"] = "existing"
            continue

        mappings = saved.get(target, {}).get("mappings", [])
        target_lookup = {}
        method_lookup = {}
        notes_lookup = {}
        for m in mappings:
            key = tuple(m["values"].get(c, "") for c in source_columns)
            target_lookup[key] = m["target"]
            method_lookup[key] = m.get("method", "manual")
            notes_lookup[key] = m.get("notes", "")

        if source_columns:
            keys = data.apply(lambda row: tuple(_stringify(row[c]) for c in source_columns), axis=1)
        else:
            keys = pd.Series([()] * len(data), index=data.index, dtype=object)
        data[target] = keys.map(target_lookup)

        if target == "canbics_class":
            data["classification_method"] = keys.map(method_lookup)
            data["classification_notes"] = keys.map(notes_lookup).fillna("")

        unmapped = int(data[target].isna().sum())
        if unmapped:
            what = f"their {source_columns} combination" if source_columns else "this source's all-rows group"
            warnings.append(
                f"{unmapped} row(s) have no {target} mapping for {what} "
                "— run 'geomerge tools classification review'"
            )

        target_excluded = data[target] == NOT_INCLUDED
        excluded = target_excluded if excluded is None else (excluded | target_excluded)

        # Unlike NOT_INCLUDED above, an IGNORED row keeps its place in the
        # dataset — it just has no value for this one target. Converted to a
        # real blank now, after the exclusion check, so the sentinel string
        # itself never reaches the merged output.
        data.loc[data[target] == IGNORED, target] = None

    if excluded is not None and excluded.any():
        n_excluded = int(excluded.sum())
        data = data[~excluded]
        warnings.append(f"{n_excluded} row(s) dropped — marked 'not included' during classification")

    return data, {"warnings": warnings}
