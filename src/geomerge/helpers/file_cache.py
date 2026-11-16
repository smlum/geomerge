"""In-memory parse cache for the status helpers, which run for every source on
every dashboard load. A file is re-parsed only once its mtime or size changes,
so an edit from anywhere (a save in the UI, a text editor, a pipeline run) is
picked up on the next read. Process-lifetime only, same as column_mapping/
status.py's raw column cache.

Returned values are shared between callers, so they must be treated as
read-only. Anything that edits and saves a file should read it fresh instead
(each status module's own load_yaml).

persist=True also keeps the result on disk (<repo>/.geomerge/cache/, one
pickle per key), so an expensive read — raw-file column names, unique value
combos — survives a server restart. Same (mtime, size) check; bump
CACHE_VERSION whenever a persisted parser's output changes shape or meaning.
Deleting the folder is always safe.
"""

import hashlib
import pickle
from pathlib import Path

import yaml

from geomerge.helpers.paths import find_repo_root

CACHE_VERSION = 1
_cache: dict = {}  # (path, parser, args) -> (stamp, parsed value)


def _disk_path(path: Path, parser, args) -> Path | None:
    try:
        root = find_repo_root()
    except FileNotFoundError:
        return None
    key = f"{path}|{parser.__module__}.{parser.__qualname__}|{args!r}|v{CACHE_VERSION}"
    return root / ".geomerge" / "cache" / f"{hashlib.sha1(key.encode()).hexdigest()}.pickle"


def _disk_get(disk: Path, stamp):
    try:
        with open(disk, "rb") as f:
            saved_stamp, value = pickle.load(f)
    except Exception:  # missing, partial or from an incompatible version — just recompute
        return None
    return (value,) if saved_stamp == stamp else None


def _disk_put(disk: Path, stamp, value):
    try:
        disk.parent.mkdir(parents=True, exist_ok=True)
        tmp = disk.with_suffix(".tmp")
        with open(tmp, "wb") as f:
            pickle.dump((stamp, value), f)
        tmp.replace(disk)
    except OSError:
        pass  # a cache that can't be written is just a slower cache


def cached_read(path: Path, parser, *args, persist: bool = False):
    """parser(path, *args), cached. parser must be a stable (module-level)
    function, since it's part of the cache key. persist=True: also on disk."""
    # Stat before parsing: if the file changes mid-read, this older stamp
    # fails to match on the next call and the file just gets re-read.
    stat = path.stat()
    stamp = (stat.st_mtime_ns, stat.st_size)
    key = (str(path), parser, args)
    cached = _cache.get(key)
    if cached and cached[0] == stamp:
        return cached[1]
    disk = _disk_path(path, parser, args) if persist else None
    hit = _disk_get(disk, stamp) if disk else None
    if hit:
        value = hit[0]
    else:
        value = parser(path, *args)
        if disk:
            _disk_put(disk, stamp, value)
    _cache[key] = (stamp, value)
    return value


def _parse_yaml(path: Path):
    return yaml.safe_load(path.read_text()) or {}


def cached_yaml(path: Path) -> dict:
    """{} for a missing or empty file, same as each status module's load_yaml."""
    return cached_read(path, _parse_yaml) if path.exists() else {}
