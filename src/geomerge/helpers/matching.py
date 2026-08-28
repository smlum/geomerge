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
    "OBJECTID"), an "excludes" bucket (a raw name equal to one of these terms
    never matches this target, overriding exact/contains/the target's own
    implicit name-alias), and an "excludes_contains" bucket (same idea, but
    a raw name merely *containing* one of these terms is enough to block
    it — e.g. "revt" excluded-by-contains from source_class so a raw name
    like "TypeRevtCyc" never gets claimed by that target's "type" term, even
    though it isn't equal to "revt" itself). The two exclude buckets exist
    separately, not merged into one substring-always exclude, because a
    plain equality exclude (e.g. "road" on source_class) must NOT also block
    an unrelated raw name like "road_date" that merely contains it — only an
    explicit excludes_contains entry should have that broader reach. A
    target's own name is always an implicit exact alias for itself.

    Deliberately one-directional for "contains" (and excludes_contains):
    only "term found inside raw name", never the reverse. Checking both
    directions (as this used to) lets a short, unrelated raw name get
    swallowed by a longer term that happens to contain it as a substring —
    e.g. raw name "GRADE" would match term "upgrade_date" purely because
    "upgrade" (normalized "upgradedate") ends in "grade", nothing to do with
    either word's actual meaning. Confirmed against every raw column name
    already seen in this project: the one-directional version drops exactly
    that class of accidental match and nothing else — no case where a real
    match was lost.

    Exact equality always wins over any substring match, regardless of which
    bucket or target it came from — checked as a first pass over everything
    before any substring is considered, so target iteration order can't let
    a weaker substring hit beat a real exact match.

    Among substring matches, the longest (most specific) matching term wins,
    not whichever target happens to be iterated first — e.g. raw name
    "Surface_Type" matches both source_class's "type" and
    source_surface_type's "surface"; "surface" is longer, so it wins, without
    needing target ordering or an exclude to settle it. A genuine tie in
    length falls back to iteration order, same as before this was added.
    """
    normalized_raw = normalize(raw_name)
    if not normalized_raw:
        return None, "none"

    def excluded(rules: dict) -> bool:
        if any(normalize(term) == normalized_raw for term in rules.get("excludes", [])):
            return True
        return any(
            normalize(term) and normalize(term) in normalized_raw
            for term in rules.get("excludes_contains", [])
        )

    for target, rules in aliases.items():
        if excluded(rules):
            continue
        exact_terms = [target, *rules.get("exact", []), *rules.get("contains", [])]
        if any(normalize(term) == normalized_raw for term in exact_terms):
            return target, "exact"

    best_target = None
    best_len = -1
    for target, rules in aliases.items():
        if excluded(rules):
            continue
        for term in rules.get("contains", []):
            normalized_term = normalize(term)
            if normalized_term and normalized_term in normalized_raw and len(normalized_term) > best_len:
                best_target = target
                best_len = len(normalized_term)

    if best_target:
        return best_target, "substring"

    return None, "none"
