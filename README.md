# lode

The lode package is a collection of tools for creating lode datasets.

Currently developed inside the `bikeways` repo, installed editable from this path; the intent
is to split it into its own repo once the interface stabilizes (see `pyproject.toml` — it's
already a standalone installable package, just physically nested here for now).

## What are LODE datasets?

LODE datasets are collections of geospatial data collected from open data sources in Canada. They are grouped by domain (e.g. bikeways, pedestrian, healthcare facilities).

Some common characteristics are:

- They may include point, line, or polygon data. 
- They may ingest a data of variety of formats (e.g. geopackage, parquet, geojson, json, csv, shp).
- They require that all data be released under an open license (e.g. ODbL, CC-BY, CC0, etc).
- They generally aim to standardize the data to a common schema.

## Aims for a `lode` package

To help with these common tasks across datasets, this packaged is intended to provide:

1. A common data providers list
2. Tools to assist with manual steps in the workflow ()
3. A pipeline to automate the processing of data from raw to processed
4. Reference data and fetch scripts (CSDs, population, etc)

## Orchestration

The package has a single CLI entrypoint, `lode`, which dispatches to tools (human-reviewed
decisions) and the pipeline (mechanical processing driven by those decisions):

```bash
lode tools checklist sync|review|process|scaffold
lode tools column-mapping
lode pipeline run [--stage NAME] [--source ID]
lode pipeline <stage-name> [--source ID]   # sugar for 'run --stage <stage-name>'
```

Repo-root/config discovery (`lode.config.yaml`) is based on the current working directory, not
on where `lode`'s own code lives — like `git`/`npm`, it's a tool you run *against* a project,
not something tied to a single checkout. Run `lode` commands from inside the project repo (here,
`bikeways`).

### Pipeline

Stages and steps are defined in `lode.config.yaml`'s `pipeline.stages`. Each configured stage
name becomes its own `lode pipeline <stage-name>` subcommand automatically.

### Tools

`statcan/` and `classification-review/` aren't part of the `lode` package yet — they're one-off/
self-contained scripts living in the parent repo's `tools/` directory, run directly with
`python`, until they're built out enough to become proper `lode tools` subcommands.

## Installation

```bash
# from the bikeways repo root, editable install
pip install -e ./lode
```

## Setup

```bash
# deps for the standalone scripts in tools/ (statcan, classification-review),
# which aren't installed as part of the lode package
pip install -r requirements.txt
```

