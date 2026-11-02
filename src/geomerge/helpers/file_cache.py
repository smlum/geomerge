"""In-memory parse cache for the status helpers, which run for every source on
every dashboard load. A file is re-parsed only once its mtime or size changes,
so an edit from anywhere (a save in the UI, a text editor, a pipeline run) is
picked up on the next read. Process-lifetime only, same as column_mapping/
status.py's raw column cache.

Returned values are shared between callers, so they must be treated as
read-only. Anything that edits and saves a file should read it fresh instead
(each status module's own load_yaml).
"""

from pathlib import Path

import yaml

_cache: dict = {}  # (path, parser, args) -> (stamp, parsed value)


def cached_read(path: Path, parser, *args):
    """parser(path, *args), cached. parser must be a stable (module-level)
    function, since it's part of the cache key."""
    # Stat before parsing: if the file changes mid-read, this older stamp
    # fails to match on the next call and the file just gets re-read.
    stat = path.stat()
    stamp = (stat.st_mtime_ns, stat.st_size)
    key = (str(path), parser, args)
    cached = _cache.get(key)
    if cached and cached[0] == stamp:
        return cached[1]
    value = parser(path, *args)
    _cache[key] = (stamp, value)
    return value


def _parse_yaml(path: Path):
    return yaml.safe_load(path.read_text()) or {}


def cached_yaml(path: Path) -> dict:
    """{} for a missing or empty file, same as each status module's load_yaml."""
    return cached_read(path, _parse_yaml) if path.exists() else {}
