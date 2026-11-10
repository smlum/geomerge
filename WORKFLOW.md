# Workflow

This document explains the intended workflow to create a new dataset with geomerge.

## Workflow overview

While each dataset has different needs, there are some common steps to each data processing workflow. 

A broad overview of the workflow is:

1. Collection
2. Inspection
3. Preprocessing (standardize columns, geometry, CRS, formatting, etc)
4. Classification 
5. Processing (filtering, assigning CSD, calculating lengths, merging, deduplication)
6. Validation
7. Data visualization
8. Dissemination 


## 1. Data collection

Providers live wherever `geomerge.config.yaml`'s `providers_csv` points (this project:
`ca-data-providers/providers.csv`). Checklist + per-source files live in `sources/`
(`checklist.csv`, `<source_id>/metadata.yaml`); the tools that manage them are in
`src/geomerge/tools/collection/`.

**Data model**
- One checklist row per **provider**, always — never duplicated per dataset. A provider with
  more than one relevant dataset (e.g. a separate multi-use-trails layer) keeps a single row
  whose `source_ids` column is a comma-separated list; the metadata modal shows one independent
  field-block per source_id, with a "+ Add another source" button to append more.
- `metadata_status`/`raw_data_status` on a row are the **worst case across all its source_ids**
  (e.g. `missing` if any source has none, `complete` only once every one of them is).
- `provider_id` is assigned once, at creation, and never changes. Each source's own id
  (`{provider_id}_cycling` by default, or `{provider_id}_{slugify(label)}` once a label is set)
  is baked in at creation too, but can be changed via a gated "Rename" control in the metadata
  modal — only offered while no downstream work exists yet for that source (no
  `column_map.yaml`/`classification_map.yaml`, no preprocessing/processing output).

**Workflow**
- `geomerge tools collection sync` — builds/updates `checklist.csv` from `providers.csv`. Safe to
  re-run any time; never loses progress.
- `geomerge serve` (http://localhost:8640/collection/) — one tool, three things:
  - **+ Add provider** — add a row not yet in `providers.csv`/`checklist.csv` directly (name,
    province, provider_id with a "Generate" button + exact-match duplicate check, geography
    level, portal URL, portal license name/URL, contact, notes). Clicking a row's provider name
    reopens this same modal to edit those fields in place (provider_id locked once created).
  - Browse each row's portal and record what you find: Found → `source_url`, Nothing → `checked`.
    `prior_url` (e.g. a 2024 CCND lead) is offered as a starting point but never overwritten by
    these actions, so a mistaken "not found" can't destroy it. As soon as a row is Found,
    `data/raw/{provider_id}_cycling/` is speculatively created (the id a first, unlabeled source
    would get) so there's somewhere to land the download before any yaml exists.
  - Once found, the row's Metadata column opens a modal to fill in each source's fields
    (`format`, `raw_filename`, license, dates, etc.) — generation of `sources/<source_id>/metadata.yaml`
    itself is deferred until Save, prefilled from the checklist row's own `source_url`/portal
    license/contact fields. A "Detect" button reads whatever's sitting in the source's raw
    folder to fill in `raw_filename`/`format` — it works even pre-save, since the folder can
    already exist (see above). The Open-license checkbox auto-follows the license URL field
    live until manually touched, then stops overriding it.
  - **Show:** filter partitions every row into exactly one of **Not found** / **Incomplete** /
    **Complete** (Complete requires metadata *and* raw data both complete — not just metadata),
    plus a cross-cutting **Flagged** view for anything checked off for attention (paired with a
    per-row note explaining why, e.g. "no portal URL, need to email their contact").
- `geomerge tools collection process` — just stamps `checked_date` for rows checked off by hand
  outside the UI (e.g. direct CSV edits). Never touches yaml.

**Notes**
- `checked`/`checked_date` are tracked distinctly from what was found, so future years know
  what's already been reviewed, not just what's been found so far.
- `provider_id` must stay unique in `providers.csv`/`checklist.csv` — when two distinct providers
  share a name (e.g. a city and the surrounding region/county), disambiguate with a suffix rather
  than merging them onto one id; it's also the basis for `source_id` and the
  `data/raw/<source_id>/` folder, so a collision there would collide downstream too. The Add/Edit
  provider modal only catches *exact* id collisions, not near-duplicates (e.g. "Region of York"
  vs. "York Region") — a known gap, not yet solved.
- `scaffold_source.py` was removed — the web UI's "+ Add another source" replaced its job
  entirely once the one-row-per-provider model was settled on.

## 2. Data inspection

**Input**
- Raw data files

**Output**
- Log file with report for each raw data file:
  - Number of rows
  - Loaded correctly
  - For each column:
    - Number of unique values
    - Type
    - Number of nulls
    - 3 sample points in a comma separated list (max 25 chars each)
  - Geometry
  - CRS
  - Formatting (UTF-8?)
- Column mapping file(s) (automated)
- Column mapping file(s) (manually reviewed and locked in)

**Workflow**
- `geomerge serve` (http://localhost:8640/column-mapping/) — inspects each source's raw file,
  suggests targets via rule-based matching, and saves reviewed/corrected mappings to
  `sources/<source_id>/column_map.yaml`

## 3. Data preprocessing

**Input**
- Raw data files

**Output**
- Cleaned data files
  - Standardize format
  - Standardize column names (using column mapping from previous step)
  - Standardize geometry
  - Standardize CRS
  - Standardize formatting (UTF-8?)
  - Deal with special characters
  - Standardize nulls, blank spaces, etc
  - Basic deduplication (within files)
  - Assign ID (unique within a run only — not stable across years/vintages, segments can change)
- Log of results
  - Rows per file

**Workflow**
- `geomerge pipeline preprocessing` (or `geomerge pipeline run --stage preprocessing`)

## 4. Data classification

**Input**
- Cleaned data files
- Previous classification files (e.g. 2024 mapping)
- Classification rules config (project-specific, rules-based matching)

**Output**
- Automated classification mapping
- Reviewed/locked classification mapping

**Workflow**
- `geomerge serve` (http://localhost:8640/classification/) — rule-based first pass (single
  primary source column per target, see geomerge.config.yaml's tools.classification.targets),
  then manual review/correction, saved to `sources/<source_id>/classification_map.yaml`
  - For each unique raw value combination:
    - Number of rows
    - Google Street View, on demand — optional per target attribute, since it's only really
      needed for canbics_class (embedded via the Maps Embed API, or mock/link-only mode with
      no key required — see geomerge.config.yaml's tools.classification.street_view)
  - A value can be marked "not included", which `classify:apply` filters out of the pipeline
    entirely — not just left unclassified

`scripts/classification-review/` is a separate, standalone tool (project-specific, not in
`geomerge/`) for post-hoc spot-checking the *merged* dataset's classification — a different job
from driving the initial per-source assignment above.

**Notes**
- Source class may need multiple source columns combined to assign one target class (not always a single 1:1 column)
- May need to classify more than one target attribute — e.g. Can-BICS class and surface material/type — not just one
- **Idea, not committed to — reference-network enrichment.** A recurring gap: a source's own
  attributes often can't separate classes that differ only in context it doesn't record —
  MUP vs gravel path with no surface column, local vs major shared lane (or shared lane vs
  local street bikeway) with no road class/speed/traffic-calming info (e.g. Montreal's
  "Chaussée désignée", "Sentier polyvalent"). Possible fix: a step that matches each segment
  to a reference network (OpenStreetMap; maybe NRN for road class) and adds derived columns
  — e.g. `ref_surface` (paved/unpaved/unknown), `ref_road_class` (local/collector/arterial),
  maybe `ref_maxspeed` / nearby traffic-calming count — configurable as extra classification
  `source_columns` so review groups split on them. Open questions: geometry matching
  (offset paths, cycle tracks beside the road — buffer + bearing), bucketing to keep group
  counts sane, and that adding columns re-keys every group, so affected sources' saved
  classifications need re-review.
- **Idea, not committed to — derived columns from a source's own attributes.** Lighter-weight
  complement to the above, for when the signal *is* in the source but not in a usable shape:
  - *Keyword buckets from a free-text column* — e.g. Ville de Québec's single "Piste cyclable"
    type covers cycle tracks, off-street paths and MUPs, but its route name (`NOM_TOPOGRAPHIE`,
    ~160 unique) says which: "Corridor …", "Parc …", "Piste cyclo-piétonne …" vs street names.
    Mapping the raw name as `source_class_secondary` explodes groups (~480 across all types);
    bucketing it first (`mup` / `corridor` / `park` / default `street`, matched with the same
    accent-folding substring rules as `helpers/matching.py`) gives ~12.
  - *Combining boolean flag columns* — e.g. York Region's CYCLING / PEDESTRIAN_ONLY /
    SHARED_USE / MTN_BIKE into one `COL=VALUE; …` secondary value (normalizing TRUE/True/blank).
    Turned out redundant for York itself, but the pattern recurs.
  Sketch: a `derived:` (buckets) / `combined:` (flags) block in `column_map.yaml`, applied by
  the column_map step, with the input columns counted as accounted-for. Same re-keying caveat
  as above.

## 5. Data processing

**Input**
- Cleaned data files
- StatCan CSD file

**Output**
- Processed data files
- Logs
  - Summary from each step — what changed
  - Summary before/after filtering. Transparent on rows dropped for what reason

**Workflow**
- `geomerge pipeline run` (runs each configured stage in order) — not yet built beyond preprocessing

**Steps**
- Per provider file, processed concurrently:
  - Apply classifications (using classification mapping file from previous step)
  - Filter unwanted data
  - Calculate lengths along line geometry
  - Assign CSD (using StatCan CSD geometry file)
- Merge — combine all provider files into one dataset
- Deduplication — spatial, across the merged data

**Notes**
- These steps are specific to bikeways. Package should be able to accommodate new steps, or choice to not run certain steps — i.e. modular.
- If some steps are very long, option to produce intermediate data?
- Still missing: final aggregation/output step (summary CSV by municipality, concordance dictionary, metadata dictionary) — TBD

## 6. Data validation

**Input**
- Processed data
- Previous data (optional) — prior vintage's completed output, loaded as a static file (e.g. 2019, 2024), not from a shared/live pipeline
- OSM data (optional)

**Output**
- Pass/fail result
- Logs

**Workflow**
- Run automated sanity checks/tests against the data, report yes/no plus details in the log
- Specific checks TBD

## 7. Data visualization & comparison

*Planned, not built. Replaces the earlier idea of a separate Plotly Dash app: these are
tools inside the existing `geomerge serve` app (one process, shared page shell/theming/
source card), each a Blueprint under `tools/` like every other tab.*

**Input**
- `data/merged/network_segments.parquet` by default
- Later: any pipeline stage's per-source output (raw → processed), for troubleshooting one
  source without a GIS tool — the original intent of this section
- Past vintages for comparison (`data/reference/canadian_cycling_network_database/` for
  2024; 2019 possibly later)

**Config** — an `explore:` block in `geomerge.config.yaml`, so nothing bikeways-specific is
hardcoded: which field colours the map (`canbics_class`), which fields summaries group by
(province, source_id, canbics_class), the length field (`length_km`), and the comparison
datasets plus how their columns line up with the target schema.

### Explore tab — one top-level tab, four views (this year's results)

1. **Overview** (build first — no new dependencies)
   - Headline numbers: total km, segments, sources, provinces
   - Km by class × province (table + stacked bar); km by source, sortable (outliers like
     Hamilton's 25× duplication jump out here)
   - Column profile, one row per schema field: % filled, distinct values, top values,
     min/max for numeric — the old "column inspection" idea. Validate can reuse it
     (e.g. "required field is blank" checks), but Overview describes, Validate judges
   - Per-source sanity table: km, segments, mean/max segment length, km in 2024
   - Computed once per merge, cached until the merged file changes
2. **Map**
   - MapLibre GL + OpenFreeMap basemap (free, no API key, OpenMapTiles schema)
   - Lines coloured by `canbics_class`; legend toggles classes; filter by province/source
   - Click a segment → popup of column: value pairs + Google Street View link (new tab)
   - **Open choice — how to get ~157k+ lines to the browser:**
     - *PMTiles (leaning this way)*: a `tiles` pipeline stage after merge runs
       `tippecanoe` → one `.pmtiles` file, served by Flask with HTTP range requests.
       Handles every zoom level natively; the standard MapLibre route. Needs
       `brew install tippecanoe` (external binary).
     - *GeoParquet in the browser*: serve a slimmed GeoParquet (geometry + a few columns,
       simplified) and render with deck.gl over MapLibre via geoarrow/parquet-wasm. No
       build step or binary; but the whole file downloads up front (~10–20 MB est.) and
       adds JS dependencies.
     - *GeoParquet bbox queries on the server*: Flask reads only rows in the current
       viewport (GeoParquet per-row bbox) and returns GeoJSON. Good zoomed in, but the
       national view still needs everything — would need a separate low-zoom view
       (e.g. per-city dots).
3. **Table**
   - Server-side paging/filtering over the merged file (pandas in memory is fine at this
     size); sort; filter by source/class/province + text search
   - Shares filters with Map; click a row → zoom Map to that segment
4. **Compare** — see below; its own tab, linked from here

### Compare tab — its own top-level tab (this year vs past vintages)

Separate from Explore: different inputs (past years) and its own map. Reuses Explore's map
and summary components.

- **City level**: km by municipality × class, this year vs 2024 (later 2019), with deltas;
  "in 2024 but missing now" and "new this year" lists of municipalities
- **Map level**: both vintages on one map for a chosen city — side-by-side, swipe, or
  overlaid with distinct styling — to see *where* the network changed
- Out of scope for now: matching individual segments across years (the same hard spatial
  problem as cross-provider dedup)
- **Dependency**: clean municipality-level comparison needs `assign_csd` (csduid/csdname)
  — until then, compare by `metadata.yaml`'s `provider_id`, which is rougher for regional
  sources (York Region, Peel, Durham)

### Suggested build order

1. Explore → Overview — **built** (headline tiles; breakdown by province-from-provider /
   provider / source × any categorical field, km or segments, share or absolute bars;
   sortable per-source table; column profile). Click any province/provider/source to filter
   the whole page (URL params, linkable; breakdown steps one level down, ending at the raw
   source_class for a single source); colours per value configurable (explore.colors —
   canbics_class by comfort tier). Province comes from providers.csv for now —
   switch to (and cross-check against) assign_csd's province once that exists
2. Explore → Map (after the PMTiles vs GeoParquet choice)
3. Explore → Table
4. Compare (city level first, then map; best after `assign_csd`)

Every view gets more trustworthy once within-source dedup (`dedupe_within_source`) exists.
