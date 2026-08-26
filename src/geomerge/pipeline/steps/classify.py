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

import yaml

from geomerge.helpers.constants import NOT_INCLUDED


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

        if not source_columns:
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

        keys = data.apply(lambda row: tuple(_stringify(row[c]) for c in source_columns), axis=1)
        data[target] = keys.map(target_lookup)

        if target == "canbics_class":
            data["classification_method"] = keys.map(method_lookup)
            data["classification_notes"] = keys.map(notes_lookup).fillna("")

        unmapped = int(data[target].isna().sum())
        if unmapped:
            warnings.append(
                f"{unmapped} row(s) have no {target} mapping for their {source_columns} "
                "combination — run 'geomerge tools classification review'"
            )

        target_excluded = data[target] == NOT_INCLUDED
        excluded = target_excluded if excluded is None else (excluded | target_excluded)

    if excluded is not None and excluded.any():
        n_excluded = int(excluded.sum())
        data = data[~excluded]
        warnings.append(f"{n_excluded} row(s) dropped — marked 'not included' during classification")

    return data, {"warnings": warnings}
