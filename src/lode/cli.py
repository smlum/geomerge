#!/usr/bin/env python3
"""Top-level `lode` CLI — dispatches to tools/ (human-reviewed decisions) and
pipeline/ (mechanical processing driven by those decisions).

    lode tools home                            # every tool's web UI, one process/port
    lode tools collection sync|process [-- script args]
    lode pipeline run [--stage NAME] [--source ID]
    lode pipeline <stage-name> [--source ID]   # sugar for 'run --stage <stage-name>'
"""

import argparse
import sys

from lode.helpers.config import load_config

# collection commands whose flags are defined by their own script, not by this
# CLI — see main()'s use of parse_known_args.
PASSTHROUGH_COLLECTION_COMMANDS = {"sync", "process"}


def _pipeline_argv(stage, source):
    argv = []
    if stage:
        argv += ["--stage", stage]
    if source:
        argv += ["--source", source]
    return argv


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lode", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    subparsers = parser.add_subparsers(dest="command", required=True)

    tools_parser = subparsers.add_parser("tools", help="Interactive review tools (human in the loop)")
    tools_sub = tools_parser.add_subparsers(dest="tool", required=True)

    tools_sub.add_parser("home", help="Every tool's web UI, mounted under one process/port")

    collection_parser = tools_sub.add_parser("collection", help="Provider/source collection scripts (web UI is under 'home')")
    collection_sub = collection_parser.add_subparsers(dest="collection_command", required=True)
    collection_sub.add_parser("sync", help="Refresh checklist.csv from providers.csv")
    collection_sub.add_parser("process", help="Stamp checked_date for rows checked outside the web UI")

    pipeline_parser = subparsers.add_parser("pipeline", help="Mechanical, no-human-in-the-loop data processing")
    pipeline_sub = pipeline_parser.add_subparsers(dest="pipeline_command", required=True)

    run_parser = pipeline_sub.add_parser("run", help="Run pipeline stages (all stages, or --stage to pick one)")
    run_parser.add_argument("--stage", help="Only run this stage (by name)")
    run_parser.add_argument("--source", help="Only run this source (by source_id)")

    # Sugar: one subcommand per configured stage, e.g. `lode pipeline preprocessing`.
    # Best-effort — falls back to just `run` if lode.config.yaml isn't found from
    # cwd (e.g. `lode --help` run outside a project); `run` surfaces that error clearly.
    try:
        stage_names = [s["name"] for s in load_config()["pipeline"]["stages"]]
    except Exception:
        stage_names = []
    for stage_name in stage_names:
        stage_parser = pipeline_sub.add_parser(stage_name, help=f"Sugar for 'run --stage {stage_name}'")
        stage_parser.add_argument("--source", help="Only run this source (by source_id)")

    return parser


def main(argv=None):
    parser = build_parser()
    args, extras = parser.parse_known_args(argv)
    passthrough = (
        args.command == "tools"
        and args.tool == "collection"
        and args.collection_command in PASSTHROUGH_COLLECTION_COMMANDS
    )
    if extras and not passthrough:
        parser.error(f"unrecognized arguments: {' '.join(extras)}")

    if args.command == "tools":
        if args.tool == "home":
            from lode.tools.home.web import server as home_server
            home_server.main()
        elif args.tool == "collection":
            from lode.tools.collection import process_checklist, sync_checklist
            script = {
                "sync": sync_checklist.main,
                "process": process_checklist.main,
            }[args.collection_command]
            script(extras)

    elif args.command == "pipeline":
        from lode.pipeline import run as pipeline_run
        if args.pipeline_command == "run":
            pipeline_run.main(_pipeline_argv(args.stage, args.source))
        else:
            pipeline_run.main(_pipeline_argv(args.pipeline_command, args.source))


if __name__ == "__main__":
    sys.exit(main())
