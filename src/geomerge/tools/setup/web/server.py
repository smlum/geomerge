#!/usr/bin/env python3
"""Domain-bootstrap config, distinct from every other tool's per-source
workflow — a home for the config that's usually decided once, before a
single source exists, rather than reviewed source-by-source.

Currently just the target-schema editor (schema/ccnd.yaml — the harmonized
fields every source's raw data maps onto). A matching-rules editor
(column_matching_rules.yaml / classification_matching_rules.yaml) is planned
as a second card on this tool's index page — routes are namespaced under
/api/schema/* rather than flat /api/* so that addition won't collide.

Schema edits are uniquely dangerous compared to every other editor in this
app: a field's name and a categorical field's category codes are referenced
as bare, unvalidated strings from every source's column_map.yaml/classification_map.yaml,
from geomerge.config.yaml's classification targets, and from the two
matching-rules files (see usage.py). Nothing else in the codebase checks any
of this before a schema change, so this is the first place that does.

Mounted under geomerge serve at /setup/ — see geomerge.tools.home.web.server.
Not part of that dashboard's per-source /api/sources loop — this tool is
project-level, not per-source, and has no status column of its own.
"""

from pathlib import Path

import yaml
from flask import Blueprint, jsonify, request, send_from_directory

from geomerge.helpers.config import load_config
from geomerge.tools.setup.usage import build_usage_index, enum_value_sources, usage_detail, usage_summary

# Canonical key order for a field dict written back to disk — GET responses
# go through Flask's jsonify, which sorts keys alphabetically by default, so
# a client that echoes a field object back on save (this editor's whole
# "preserve unknown keys" design, see schema.js) would otherwise silently
# scramble the schema file's deliberate name/type/required/... ordering into
# alphabetical. Any key not listed here (i.e. genuinely unforeseen) is kept,
# just appended after these in whatever order it arrived.
FIELD_KEY_ORDER = ["name", "type", "required", "source_mappable", "description", "categories", "geometry_type", "crs"]


def _ordered_field(f: dict) -> dict:
    ordered = {k: f[k] for k in FIELD_KEY_ORDER if k in f}
    ordered.update({k: v for k, v in f.items() if k not in FIELD_KEY_ORDER})
    return ordered


def create_blueprint(config: dict = None) -> Blueprint:
    config = config or load_config()
    repo_root = config["repo_root"]
    target_schema_path = repo_root / config["target_schema"]
    column_matching_rules_path = repo_root / config["tools"]["column_mapping"]["matching_rules"]

    bp = Blueprint("setup", __name__, static_folder=str(Path(__file__).parent), static_url_path="")

    def load_schema() -> dict:
        return yaml.safe_load(target_schema_path.read_text())

    def load_column_matching_rules() -> dict:
        return yaml.safe_load(column_matching_rules_path.read_text()) or {} if column_matching_rules_path.exists() else {}

    @bp.route("/")
    def index():
        return send_from_directory(bp.static_folder, "index.html")

    @bp.route("/schema.html")
    def schema_page():
        return send_from_directory(bp.static_folder, "schema.html")

    @bp.route("/column_matching_rules.html")
    def column_matching_rules_page():
        return send_from_directory(bp.static_folder, "column_matching_rules.html")

    @bp.route("/api/schema/fields")
    def api_schema_get():
        schema = load_schema()
        index = build_usage_index(config)
        fields = []
        for f in schema["fields"]:
            f = dict(f)
            f["_usage"] = usage_summary(f["name"], index)
            fields.append(f)
        return jsonify({"name": schema.get("name", ""), "description": schema.get("description", ""), "fields": fields})

    # Full-document replace, same as every other tool's save endpoint
    # (collection/column_mapping/classification all read-whole -> mutate ->
    # write-whole-file-back) — a schema is small enough that a per-field
    # PATCH API isn't worth being the only one in the codebase.
    #
    # Two-phase confirm: the server never trusts a bare "confirmed" flag.
    # A field name that existed before this save and doesn't exist after it
    # covers both delete and rename (indistinguishable by name alone) — if
    # real sources/config reference it, save is refused with the real
    # affected list attached, UNLESS that exact field name already appears
    # in acknowledged_removed_fields (i.e. the client is re-submitting after
    # showing the user this same list and getting a yes). Same shape for
    # enum values dropped from a field that's kept. Usage is recomputed
    # fresh on every call — never cached, never taken on faith from the
    # client — so a stale first response can't be replayed to sneak past a
    # change that happened in between the two requests.
    @bp.route("/api/schema/fields", methods=["POST"])
    def api_schema_save():
        body = request.get_json()
        new_fields = body.get("fields") or []
        acknowledged_removed_fields = set(body.get("acknowledged_removed_fields") or [])
        acknowledged_removed_enum_values = body.get("acknowledged_removed_enum_values") or {}

        old_schema = load_schema()
        old_fields_by_name = {f["name"]: f for f in old_schema["fields"]}
        new_names = {f["name"] for f in new_fields}

        usage_index = build_usage_index(config)

        removed_names = set(old_fields_by_name) - new_names
        risky_removed = {n: usage_detail(n, usage_index) for n in removed_names if usage_summary(n, usage_index)["in_use"]}
        unacked_removed = {n: d for n, d in risky_removed.items() if n not in acknowledged_removed_fields}

        risky_enum_removed = {}
        for f in new_fields:
            # Looked up by _original_name, not the (possibly just-edited)
            # current name — a save that renames a field AND edits its
            # categories in the same request would otherwise never find the
            # old version to diff against, silently skipping this check.
            old = old_fields_by_name.get(f.get("_original_name") or f["name"])
            if not old or "categories" not in old:
                continue
            # Only the code is load-bearing (it's what's actually saved in
            # classification_map.yaml and keyed in classification_matching_
            # rules.yaml) — label/description are pure display metadata, so
            # dropping/editing those isn't a risky change worth gating.
            old_codes = {c["code"] for c in old.get("categories", [])}
            new_codes = {c["code"] for c in f.get("categories", [])}
            dropped_values = old_codes - new_codes
            for value in dropped_values:
                # Sources still reference this field by its original name on
                # disk (nothing renames them), so the usage lookup has to use
                # that — but the response is keyed by the current name, since
                # that's what the user's looking at when this fires.
                sources = enum_value_sources(f.get("_original_name") or f["name"], value, usage_index)
                if sources:
                    risky_enum_removed.setdefault(f["name"], {})[value] = sources
        unacked_enum = {}
        for fname, values in risky_enum_removed.items():
            acked = set(acknowledged_removed_enum_values.get(fname) or [])
            remaining = {v: sids for v, sids in values.items() if v not in acked}
            if remaining:
                unacked_enum[fname] = remaining

        if unacked_removed or unacked_enum:
            return jsonify({
                "error": "confirmation required — these changes affect real sources",
                "unacknowledged_removed_fields": unacked_removed,
                "unacknowledged_removed_enum_values": unacked_enum,
            }), 400

        # Strip client-side bookkeeping (_original_name, and _usage in case a
        # caller ever forgets to) before it can reach the actual file, and
        # restore a readable key order jsonify's alphabetical sort disturbed.
        clean_fields = [_ordered_field({k: v for k, v in f.items() if not k.startswith("_")}) for f in new_fields]

        with open(target_schema_path, "w") as f:
            yaml.dump(
                {
                    "name": body.get("name", old_schema.get("name", "")),
                    "description": body.get("description", old_schema.get("description", "")),
                    "fields": clean_fields,
                },
                f,
                sort_keys=False,
                allow_unicode=True,
            )
        return jsonify({"ok": True})

    # Read-only raw-file preview for the footer's clickable "editing: ..."
    # link (see file-preview.js) — same {content, path} shape as every other
    # tool's own /raw endpoint (collection, column_mapping, classification).
    @bp.route("/api/schema/raw")
    def api_schema_get_raw():
        return jsonify({"content": target_schema_path.read_text(), "path": str(target_schema_path.relative_to(repo_root))})

    # Every source_mappable schema field is listed, whether or not it has
    # rules yet — rules.get(name) defaults to empty buckets rather than
    # omitting the field, so "no rules defined" is visible instead of the
    # field just not appearing.
    @bp.route("/api/column-matching-rules")
    def api_column_matching_rules_get():
        schema = load_schema()
        rules = load_column_matching_rules()
        targets = []
        for f in schema["fields"]:
            if not f.get("source_mappable"):
                continue
            target_rules = rules.get(f["name"]) or {}
            targets.append({
                "name": f["name"],
                "description": f.get("description", ""),
                "exact": target_rules.get("exact") or [],
                "contains": target_rules.get("contains") or [],
                "excludes": target_rules.get("excludes") or [],
                "excludes_contains": target_rules.get("excludes_contains") or [],
            })
        return jsonify(targets)

    # Per-target upsert (not a full-document replace like schema/fields) —
    # unlike a schema field, a rules entry has no name of its own to rename
    # and nothing downstream keys off it directly (see usage.py: only
    # whether a target *has* rules at all is ever checked, not their
    # content), so there's no equivalent risk to gate with a confirm step.
    @bp.route("/api/column-matching-rules/<target>", methods=["POST"])
    def api_column_matching_rules_save(target):
        body = request.get_json()
        exact = [t.strip() for t in (body.get("exact") or []) if t.strip()]
        contains = [t.strip() for t in (body.get("contains") or []) if t.strip()]
        excludes = [t.strip() for t in (body.get("excludes") or []) if t.strip()]
        excludes_contains = [t.strip() for t in (body.get("excludes_contains") or []) if t.strip()]

        rules = load_column_matching_rules()
        rules[target] = {
            "exact": exact,
            "contains": contains,
            "excludes": excludes,
            "excludes_contains": excludes_contains,
        }

        column_matching_rules_path.parent.mkdir(parents=True, exist_ok=True)
        with open(column_matching_rules_path, "w") as f:
            yaml.dump(rules, f, sort_keys=False, allow_unicode=True)
        return jsonify({"ok": True})

    @bp.route("/api/column-matching-rules/raw")
    def api_column_matching_rules_get_raw():
        if not column_matching_rules_path.exists():
            return jsonify({"error": "not found"}), 404
        return jsonify({
            "content": column_matching_rules_path.read_text(),
            "path": str(column_matching_rules_path.relative_to(repo_root)),
        })

    return bp
