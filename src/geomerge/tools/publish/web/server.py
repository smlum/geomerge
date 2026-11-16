"""Publish tab — placeholder. Planned: the final release (output files and
formats, source list with licence attribution, a dated snapshot per vintage
for Compare). Mounted at /publish/ by geomerge.tools.home.web.server."""

from flask import Blueprint, render_template


def create_blueprint(config: dict = None) -> Blueprint:
    bp = Blueprint("publish", __name__, template_folder="templates")

    @bp.route("/")
    def index():
        return render_template("publish/index.html", active_tab="publish")

    return bp
