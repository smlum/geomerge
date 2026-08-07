#!/usr/bin/env python3
"""Runs pipeline stages/steps from lode.config.yaml, per source. Steps are
dotted import paths, resolved and run in order; output persists only at
stage boundaries.

Usage:
    lode pipeline run                                # everything, all sources
    lode pipeline run --stage preprocessing          # one stage, all sources
    lode pipeline run --source on_toronto_cycling    # one source, all stages
"""

import argparse
import importlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

from lode.helpers.config import load_config
from lode.helpers.readers import read_source_file


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


def load_stage_input(stage_index: int, source_id: str, config: dict):
    repo_root = config["repo_root"]
    sources_dir = repo_root / config["sources_dir"]
    stages = config["pipeline"]["stages"]

    if stage_index == 0:
        metadata = load_yaml(sources_dir / source_id / "metadata.yaml")
        raw_filename = metadata.get("raw_filename")
        fmt = metadata.get("format")
        if not raw_filename or not fmt:
            raise ValueError("metadata.yaml is missing raw_filename and/or format")
        raw_path = repo_root / config["raw_dir"] / source_id / raw_filename
        if not raw_path.exists():
            raise FileNotFoundError(f"raw file not found: {raw_path}")
        return read_source_file(raw_path, fmt)

    prev_output_dir = repo_root / stages[stage_index - 1]["output_dir"]
    input_path = prev_output_dir / source_id / f"{source_id}.parquet"
    if not input_path.exists():
        raise FileNotFoundError(f"expected {input_path} — did the previous stage run for this source?")
    return read_source_file(input_path, "parquet")


def format_entry(entry: dict) -> str:
    header = f"{entry['timestamp']} [{entry['stage']}] {entry['source_id']}: {entry['status']}"
    if entry["status"] == "error":
        return f"{header} — {entry['error']}"
    lines = [f"{header} ({entry['rows_before']} -> {entry['rows_after']} rows)"]
    for step_log in entry["steps"]:
        for warning in step_log.get("warnings", []):
            lines.append(f"    {step_log['step']}: {warning}")
    return "\n".join(lines)


def run_stage(stage: dict, stage_index: int, source_ids: list, config: dict) -> list:
    output_dir = config["repo_root"] / stage["output_dir"]
    steps = [(ref, resolve_step(ref)) for ref in stage.get("steps", [])]

    log_entries = []
    for source_id in source_ids:
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "stage": stage["name"],
            "source_id": source_id,
        }
        try:
            data = load_stage_input(stage_index, source_id, config)
            rows_before = len(data)

            step_logs = []
            for ref, step in steps:
                data, step_log = step(data, source_id=source_id, config=config)
                step_logs.append({"step": ref, **(step_log or {})})

            out_path = output_dir / source_id / f"{source_id}.parquet"
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
    source_ids = [args.source] if args.source else list_source_ids(config)

    all_log_entries = []
    for stage in stages_to_run:
        stage_index = stage_names.index(stage["name"])
        all_log_entries.extend(run_stage(stage, stage_index, source_ids, config))

    log_path = write_logs(all_log_entries, config["repo_root"])
    ok = sum(1 for e in all_log_entries if e["status"] == "ok")
    print(f"\n{ok}/{len(all_log_entries)} succeeded. Log: {log_path}")


if __name__ == "__main__":
    main()
