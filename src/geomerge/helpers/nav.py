"""The top nav's tab list — one definition, used by tools/home/web/templates/
base.html (every tool's page extends it) via an app-wide context_processor
(see tools/home/web/server.py). Was seven copies of the same six <a> tags,
one hand-typed per tool page; a new/renamed/reordered tab now only needs
changing here."""

NAV_TABS = [
    {"id": "home", "label": "Home", "href": "/", "color": "blue"},
    {"id": "setup", "label": "Setup", "href": "/setup/", "color": "lavender"},
    {"id": "collect", "label": "Collect", "href": "/collection/", "color": "peach"},
    {"id": "prepare", "label": "Prepare", "href": "/prep/", "color": "purple"},
    {"id": "process", "label": "Process", "href": "/pipeline/", "color": "teal"},
    {"id": "validate", "label": "Validate", "href": "/validate/", "color": "pink"},
]
