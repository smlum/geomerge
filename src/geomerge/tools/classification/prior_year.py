"""Reference lookup into a prior classification effort — for bikeways,
data/reference/canadian_cycling_network_database/classification_dictionary.csv
(the 2024 CCND vintage), config-driven via tools.classification.prior_year_dictionary
so geomerge itself doesn't hardcode this project's reference file. The
dictionary's own column shape (province_territory, municipality, source_class,
canbics_class, street_view_url) is assumed fixed here regardless — it's a
specific external artifact, not a general concept every geomerge project
would share.

Read-only reference material: it supplies an initial suggestion when a
source_class matches, as well as a visual cue in the review UI. Nothing here
writes to classification_map.yaml.
"""

from pathlib import Path

import pandas as pd
import yaml

from geomerge.helpers.matching import normalize

# A handful of municipality-name renames between this project's provider_id
# convention (ca-data-providers/providers.csv) and the 2024 CCND dictionary's
# own municipality column. Everything else matches after normalizing
# hyphens/underscores (e.g. "rouyn-noranda" vs "rouyn_noranda"). Keys are
# already in normalized (underscore-only) form, since _normalize() runs
# before this lookup.
PROVIDER_ID_ALIASES = {
    "qc_ville_de_quebec": "qc_quebec_city",
    "ns_halifax_regional_municipality": "ns_halifax",
}

_dictionary_cache: dict = {}  # path -> (mtime, DataFrame), process-lifetime only


def _normalize(provider_id: str) -> str:
    return provider_id.replace("-", "_")


def _load_dictionary(path: Path) -> pd.DataFrame:
    mtime = path.stat().st_mtime
    cached = _dictionary_cache.get(str(path))
    if cached and cached[0] == mtime:
        return cached[1]
    df = pd.read_csv(path, dtype=str).fillna("")
    df["_provider_id"] = (df["province_territory"] + "_" + df["municipality"]).map(_normalize)
    _dictionary_cache[str(path)] = (mtime, df)
    return df


def prior_year_rows(source_id: str, config: dict) -> list:
    """[{"source_class": ..., "canbics_class": ..., "street_view_url": ...}, ...]
    for this source's municipality — [] if the feature isn't configured, the
    source has no provider_id, or nothing in the dictionary matches it."""
    dict_config = config["tools"]["classification"].get("prior_year_dictionary")
    if not dict_config:
        return []

    repo_root = config["repo_root"]
    dict_path = repo_root / dict_config["path"]
    if not dict_path.exists():
        return []

    metadata_path = repo_root / config["sources_dir"] / source_id / "metadata.yaml"
    if not metadata_path.exists():
        return []
    metadata = yaml.safe_load(metadata_path.read_text()) or {}
    provider_id = metadata.get("provider_id")
    if not provider_id:
        return []

    provider_id = _normalize(provider_id)
    provider_id = PROVIDER_ID_ALIASES.get(provider_id, provider_id)

    df = _load_dictionary(dict_path)
    matched = df[df["_provider_id"] == provider_id]
    return matched[["source_class", "canbics_class", "street_view_url"]].to_dict("records")


def prior_year_lookup(source_id: str, config: dict) -> dict:
    """{normalize(source_class): {"value": canbics_class, "street_view_url": ...}}
    for suggesting and annotating individual review rows (see
    server.py's api_classification_get) — built from the same rows
    prior_year_rows() lists in full. If two rows normalize to the same key,
    the last one wins; not expected in practice since the dictionary is one
    row per distinct source_class already."""
    lookup = {}
    for row in prior_year_rows(source_id, config):
        key = normalize(row["source_class"])
        if key:
            lookup[key] = {"value": row["canbics_class"], "street_view_url": row["street_view_url"]}
    return lookup
