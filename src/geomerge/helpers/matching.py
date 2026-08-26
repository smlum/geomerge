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
    would false-positive too easily) and a "contains" bucket (matches equal
    OR substring, either direction — for terms distinctive enough to loosen).
    A target's own name is always an implicit exact alias for itself.

    Exact equality always wins over any substring match, regardless of which
    bucket or target it came from — checked as a first pass over everything
    before any substring is considered, so target iteration order can't let
    a weaker substring hit beat a real exact match.
    """
    normalized_raw = normalize(raw_name)
    if not normalized_raw:
        return None, "none"

    for target, rules in aliases.items():
        exact_terms = [target, *rules.get("exact", []), *rules.get("contains", [])]
        if any(normalize(term) == normalized_raw for term in exact_terms):
            return target, "exact"

    for target, rules in aliases.items():
        for term in rules.get("contains", []):
            normalized_term = normalize(term)
            if normalized_term and (normalized_term in normalized_raw or normalized_raw in normalized_term):
                return target, "substring"

    return None, "none"
