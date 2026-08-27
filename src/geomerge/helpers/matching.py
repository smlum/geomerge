"""Generic column/value name matching: normalize, then try exact match before
substring match. Domain-agnostic — the alias dictionary (target -> known raw
name variants) is supplied by the caller, not baked in here, so this is
reusable for column mapping now and classification later."""

import re


def normalize(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def match_name(raw_name: str, aliases: dict) -> tuple:
    """Returns (target_or_None, confidence), confidence in {"exact", "substring", "none"}.

    Each target's rules have an "exact" bucket (only ever matches a raw name
    equal to the term — for short/generic terms where a substring match
    would false-positive too easily), a "contains" bucket (matches when the
    term is found within the raw name — e.g. term "obj" matches raw name
    "OBJECTID"), and an "excludes" bucket (a raw name equal to one of these
    terms never matches this target, overriding exact/contains/the target's
    own implicit name-alias — e.g. "Road_Class" excluded from source_class
    so it doesn't get swallowed by that target's "class" contains-term, even
    though every OTHER raw name containing "class" still should). A target's
    own name is always an implicit exact alias for itself.

    Deliberately one-directional for "contains": only "term found inside raw
    name", never the reverse. Checking both directions (as this used to)
    lets a short, unrelated raw name get swallowed by a longer term that
    happens to contain it as a substring — e.g. raw name "GRADE" would match
    term "upgrade_date" purely because "upgrade" (normalized "upgradedate")
    ends in "grade", nothing to do with either word's actual meaning.
    Confirmed against every raw column name already seen in this project:
    the one-directional version drops exactly that class of accidental
    match and nothing else — no case where a real match was lost.

    Exact equality always wins over any substring match, regardless of which
    bucket or target it came from — checked as a first pass over everything
    before any substring is considered, so target iteration order can't let
    a weaker substring hit beat a real exact match.
    """
    normalized_raw = normalize(raw_name)
    if not normalized_raw:
        return None, "none"

    def excluded(rules: dict) -> bool:
        return any(normalize(term) == normalized_raw for term in rules.get("excludes", []))

    for target, rules in aliases.items():
        if excluded(rules):
            continue
        exact_terms = [target, *rules.get("exact", []), *rules.get("contains", [])]
        if any(normalize(term) == normalized_raw for term in exact_terms):
            return target, "exact"

    for target, rules in aliases.items():
        if excluded(rules):
            continue
        for term in rules.get("contains", []):
            normalized_term = normalize(term)
            if normalized_term and normalized_term in normalized_raw:
                return target, "substring"

    return None, "none"
