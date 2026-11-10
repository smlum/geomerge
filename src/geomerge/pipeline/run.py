#!/usr/bin/env python3
"""Runs pipeline stages/steps from geomerge.config.yaml, per source. Steps are
dotted import paths, resolved and run in order; output persists only at
stage boundaries.

Usage:
    geomerge pipeline run                                # everything, all sources
    geomerge pipeline run --stage preprocessing          # one stage, all sources
    geomerge pipeline run --source on_toronto_cycling    # one source, all stages
"""

import argparse
import importlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import pandas as pd
import yaml

from geomerge.helpers.config import load_config
from geomerge.helpers.readers import read_source_file

# Sentinel work unit for a `merge: true` stage — such a stage runs its steps
# once, over every source's data combined, instead of once per source.
MERGED_UNIT = "_merged"


def list_source_ids(config: dict) -> list:
    sources_dir = config["repo_root"] / config["sources_dir"]
    if not sources_dir.is_dir():
        return []
    return sorted(p.name for p in sources_dir.iterdir() if p.is_dir())


def load_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text()) or {} if path.exists() else {}


def resolve_step(ref: str):
    """'module.path:function_name' -> the actual function."""
    module_path, _, func_name = ref.partition(":")
    module = importlib.import_module(module_path)
    return getattr(module, func_name)


def _excluded(source_id: str, config: dict) -> bool:
    from geomerge.helpers.source_notes import source_markers
    return source_markers(source_id, config)["excluded"]


def _classification_incomplete(source_id: str, config: dict) -> bool:
    # Unfinished classification would otherwise go through with a blank
    # class and only a warning from classify:apply.
    from geomerge.helpers.status import COMPLETE, classification_overall
    from geomerge.tools.classification.status import source_status
    return classification_overall(source_status(source_id, config)["targets"]) != COMPLETE


# What can hold a source back, by the name a stage's `blocked_by` list uses
# in geomerge.config.yaml. A source's `flagged` (helpers/source_notes.py) is
# deliberately not one of these — it means "something needs doing", not
# "keep this out". Imported lazily: classification's status lives in tools/,
# which the pipeline otherwise doesn't depend on.
GATES = {
    "excluded": _excluded,
    "classification_incomplete": _classification_incomplete,
}

GATE_DESCRIPTIONS = {
    "excluded": "excluded from pipeline",
    "classification_incomplete": "classification incomplete",
}


def blocked_by(stage: dict, source_id: str, config: dict):
    """The first gate in the stage's `blocked_by` list this source fails,
    or None. Every later stage repeats the earlier stages' gates, so a
    source held back at one stage goes no further either."""
    for name in stage.get("blocked_by", []):
        if name not in GATES:
            raise ValueError(f"stage '{stage['name']}': unknown blocked_by '{name}' (known: {', '.join(GATES)})")
        if GATES[name](source_id, config):
            return name
    return None


def stage_work_units(stage: dict, source_ids: list) -> list:
    """A normal stage runs its steps once per source. A `merge: true` stage
    runs them once, over every source's data combined — it has exactly one
    unit of work, not one per source."""
    if stage.get("merge"):
        return [MERGED_UNIT]
    return source_ids


def _as_text(value):
    if value is None or (not isinstance(value, str) and pd.isna(value)):
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))  # an int ID that became float via NaN: "123", not "123.0"
    return str(value)


def _cast_schema_strings(data, config: dict):
    """Each source keeps its own raw dtypes (a verbatim source_feature_id is
    an int in one source, text in another; a column that's all-null in one
    source is float64), so a plain concat leaves mixed-type object columns
    that parquet refuses to write. Every column the target schema declares
    `type: string` is cast to text here, nulls kept as nulls."""
    schema = load_yaml(config["repo_root"] / config["target_schema"])
    string_fields = {f["name"] for f in schema.get("fields", []) if f.get("type") == "string"}
    for column in data.columns:
        if column in string_fields:
            data[column] = data[column].map(_as_text).astype("string")
    return data


def load_stage_input(stage_index: int, unit_id: str, config: dict) -> tuple:
    """(data, warnings) — warnings so far only from a merge unit skipping
    sources with no input, surfaced in that unit's log entry."""
    repo_root = config["repo_root"]
    stages = config["pipeline"]["stages"]
    stage = stages[stage_index]

    if stage_index == 0:
        sources_dir = repo_root / config["sources_dir"]
        metadata = load_yaml(sources_dir / unit_id / "metadata.yaml")
        raw_filename = metadata.get("raw_filename")
        fmt = metadata.get("format")
        if not raw_filename or not fmt:
            raise ValueError("metadata.yaml is missing raw_filename and/or format")
        raw_path = repo_root / config["raw_dir"] / unit_id / raw_filename
        if not raw_path.exists():
            raise FileNotFoundError(f"raw file not found: {raw_path}")
        return read_source_file(raw_path, fmt), []

    prev_stage = stages[stage_index - 1]
    input_dir = repo_root / stage.get("input_dir", prev_stage["output_dir"])

    # Files at a stage boundary are always ones this pipeline wrote itself,
    # with one unambiguous "geometry" column already typed correctly — unlike
    # raw source files (see helpers/readers.py), so gpd.read_parquet is safe
    # here and saves every downstream step from re-deriving geometry from WKB.
    if prev_stage.get("merge"):
        # The previous stage collapsed every source into one file — there's
        # no per-source data left to select from, merged or not.
        input_path = input_dir / prev_stage.get("output_filename", f"{prev_stage['name']}.parquet")
        if not input_path.exists():
            raise FileNotFoundError(f"expected {input_path} — did the '{prev_stage['name']}' stage run?")
        return gpd.read_parquet(input_path), []

    if unit_id == MERGED_UNIT:
        # Held-back sources (the merge stage's own blocked_by) are left out
        # even if an old output file is still on disk from before they were
        # held back. A source with no output from the previous stage (it
        # errored, or never ran) is skipped too, rather than failing the
        # whole merge — one unusable source shouldn't hold up everyone else's.
        frames, held_back, missing = [], [], []
        for source_id in list_source_ids(config):
            source_path = input_dir / source_id / f"{source_id}.parquet"
            if blocked_by(stage, source_id, config):
                held_back.append(source_id)
            elif source_path.exists():
                frames.append(gpd.read_parquet(source_path))
            else:
                missing.append(source_id)
        if not frames:
            raise FileNotFoundError(f"no source has output in {input_dir} — did the previous stage run?")
        warnings = []
        if held_back:
            warnings.append(f"left out {len(held_back)} excluded or unclassified source(s): {', '.join(held_back)}")
        if missing:
            warnings.append(f"skipped {len(missing)} source(s) with no {prev_stage['name']} output: {', '.join(missing)}")
        merged = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=frames[0].crs)
        return _cast_schema_strings(merged, config), warnings

    input_path = input_dir / unit_id / f"{unit_id}.parquet"
    if not input_path.exists():
        raise FileNotFoundError(f"expected {input_path} — did the previous stage run for this source?")
    return gpd.read_parquet(input_path), []


def format_entry(entry: dict) -> str:
    header = f"{entry['timestamp']} [{entry['stage']}] {entry['source_id']}: {entry['status']}"
    if entry["status"] == "error":
        return f"{header} — {entry['error']}"
    if entry["status"] == "skipped":
        removed = f" (removed old output {entry['removed_output']})" if entry.get("removed_output") else ""
        return f"{header} — {GATE_DESCRIPTIONS.get(entry['blocked_by'], entry['blocked_by'])}{removed}"
    lines = [f"{header} ({entry['rows_before']} -> {entry['rows_after']} rows)"]
    for step_log in entry["steps"]:
        for warning in step_log.get("warnings", []):
            lines.append(f"    {step_log['step']}: {warning}")
    return "\n".join(lines)


def run_stage(stage: dict, stage_index: int, source_ids: list, config: dict) -> list:
    output_dir = config["repo_root"] / stage["output_dir"]
    steps = [(ref, resolve_step(ref)) for ref in stage.get("steps", [])]

    log_entries = []
    for unit_id in stage_work_units(stage, source_ids):
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "stage": stage["name"],
            "source_id": unit_id,
        }
        flag = None if unit_id == MERGED_UNIT else blocked_by(stage, unit_id, config)
        if flag:
            entry.update({"status": "skipped", "blocked_by": flag})
            # Output left over from before the source was held back would
            # otherwise still read as "complete" on every status page (they
            # compare mtimes) and could feed a later stage. Regenerated as
            # soon as the source is let through again, so nothing is lost.
            stale = output_dir / unit_id / f"{unit_id}.parquet"
            if stale.exists():
                stale.unlink()
                entry["removed_output"] = str(stale.relative_to(config["repo_root"]))
            log_entries.append(entry)
            print(format_entry(entry))
            continue
        try:
            data, input_warnings = load_stage_input(stage_index, unit_id, config)
            rows_before = len(data)

            step_logs = [{"step": "load_input", "warnings": input_warnings}] if input_warnings else []
            for ref, step in steps:
                data, step_log = step(data, source_id=unit_id, config=config)
                step_logs.append({"step": ref, **(step_log or {})})

            if unit_id == MERGED_UNIT:
                out_path = output_dir / stage.get("output_filename", f"{stage['name']}.parquet")
            else:
                out_path = output_dir / unit_id / f"{unit_id}.parquet"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            data.to_parquet(out_path)

            entry.update({
                "status": "ok",
                "rows_before": rows_before,
                "rows_after": len(data),
                "steps": step_logs,
            })
        except Exception as e:
            entry.update({"status": "error", "error": str(e)})

        log_entries.append(entry)
        print(format_entry(entry))

    return log_entries


def write_logs(log_entries: list, repo_root: Path) -> Path:
    log_dir = repo_root / "data" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    jsonl_path = log_dir / f"pipeline_{stamp}.jsonl"
    with open(jsonl_path, "w") as f:
        for entry in log_entries:
            f.write(json.dumps(entry, default=str) + "\n")

    log_path = log_dir / f"pipeline_{stamp}.log"
    with open(log_path, "w") as f:
        f.write("\n".join(format_entry(entry) for entry in log_entries) + "\n")

    return log_path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stage", help="Only run this stage (by name)")
    parser.add_argument("--source", help="Only run this source (by source_id)")
    args = parser.parse_args(argv)

    config = load_config()
    stages = config["pipeline"]["stages"]
    stage_names = [s["name"] for s in stages]
    if args.stage and args.stage not in stage_names:
        sys.exit(f"No such stage: {args.stage} (known: {', '.join(stage_names)})")
    stages_to_run = [s for s in stages if not args.stage or s["name"] == args.stage]

    merge_stage = next((s for s in stages_to_run if s.get("merge")), None)
    if args.source and merge_stage:
        sys.exit(
            f"--source can't be combined with the '{merge_stage['name']}' stage — "
            "merge stages always operate over every source's output."
        )

    source_ids = [args.source] if args.source else list_source_ids(config)

    all_log_entries = []
    for stage in stages_to_run:
        stage_index = stage_names.index(stage["name"])
        all_log_entries.extend(run_stage(stage, stage_index, source_ids, config))

    log_path = write_logs(all_log_entries, config["repo_root"])
    ok = sum(1 for e in all_log_entries if e["status"] == "ok")
    skipped = sum(1 for e in all_log_entries if e["status"] == "skipped")
    ran = len(all_log_entries) - skipped
    skipped_note = f" ({skipped} skipped — excluded or unclassified)" if skipped else ""
    print(f"\n{ok}/{ran} succeeded{skipped_note}. Log: {log_path}")


if __name__ == "__main__":
    main()
