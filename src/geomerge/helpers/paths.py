"""Shared repo-root resolution. Walks up from cwd, not from this file's own
location — geomerge is an installed package operated on whatever project
directory you run it from (like git/npm/terraform), so "where the code lives"
and "which project it's operating on" are deliberately different things."""

from pathlib import Path


def find_repo_root(start: Path = None) -> Path:
    start = start or Path.cwd()
    for parent in [start, *start.parents]:
        if (parent / ".git").exists():
            return parent
    raise FileNotFoundError(f"No .git directory found above {start}")
