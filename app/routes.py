import time
from flask import Blueprint, render_template, request, jsonify
from .destinations import load_destinations
from .weather import build_grid, build_top3, cache_last_updated

bp = Blueprint('main', __name__)

DEFAULTS = dict(threshold=30, horizon=7, departure_day=2, temp_threshold=82)


def _format_updated(ts):
    if ts is None:
        return 'Never'
    delta = int(time.time() - ts)
    if delta < 60:
        return 'Just now'
    if delta < 3600:
        return f'{delta // 60}m ago'
    return f'{delta // 3600}h {(delta % 3600) // 60}m ago'


@bp.route('/')
def index():
    destinations = load_destinations()
    t, h, dep = DEFAULTS['threshold'], DEFAULTS['horizon'], DEFAULTS['departure_day']
    tt = DEFAULTS['temp_threshold']
    rows = build_grid(destinations, horizon=h, threshold=t)
    top3 = build_top3(rows, departure_day=dep, threshold=t, temp_threshold=tt)
    best = rows[0] if rows else None
    return render_template(
        'index.html',
        rows=rows,
        horizon=h,
        threshold=t,
        departure_day=dep,
        temp_threshold=tt,
        top3=top3,
        best=best,
        last_updated=_format_updated(cache_last_updated()),
    )


@bp.route('/api/forecast', methods=['POST'])
def forecast():
    body = request.get_json(force=True)
    threshold     = int(body.get('threshold', DEFAULTS['threshold']))
    horizon       = int(body.get('horizon', DEFAULTS['horizon']))
    departure_day = int(body.get('departure_day', DEFAULTS['departure_day']))
    temp_threshold = int(body.get('temp_threshold', DEFAULTS['temp_threshold']))
    force         = bool(body.get('force', False))
    destinations  = load_destinations()
    rows = build_grid(destinations, horizon=horizon, threshold=threshold, force=force)
    top3 = build_top3(rows, departure_day=departure_day, threshold=threshold, temp_threshold=temp_threshold)
    best = rows[0] if rows else None
    return jsonify({
        'rows': rows,
        'horizon': horizon,
        'threshold': threshold,
        'departure_day': departure_day,
        'temp_threshold': temp_threshold,
        'top3': top3,
        'best': best,
        'last_updated': _format_updated(cache_last_updated()),
    })
