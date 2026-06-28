import logging
import time
import math
from datetime import datetime
from flask import Blueprint, render_template, request, jsonify

log = logging.getLogger(__name__)
from .destinations import load_destinations
from .weather import build_grid, build_top3, build_grid_from_db, refresh_forecasts_for, cache_last_updated
from . import db

bp = Blueprint('main', __name__)

DEFAULTS = dict(threshold=30, horizon=7, departure_day=2, temp_threshold=82, radius=200)
CINCINNATI = (39.1031, -84.5120)


def _bearing(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    x = math.sin(lon2 - lon1) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _bearing_to_dir(b):
    dirs = ['North', 'Northeast', 'East', 'Southeast', 'South', 'Southwest', 'West', 'Northwest']
    return dirs[round(b / 45) % 8]


def _recompute_directions(destinations, olat, olon):
    for d in destinations:
        if 'lat' in d and 'lon' in d:
            d['direction'] = _bearing_to_dir(_bearing(olat, olon, d['lat'], d['lon']))
    return destinations


def _format_updated(ts):
    if ts is None:
        return 'Never'
    delta = int(time.time() - ts)
    if delta < 60:
        return 'Just now'
    if delta < 3600:
        return f'{delta // 60}m ago'
    return f'{delta // 3600}h {(delta % 3600) // 60}m ago'


def _rows_from_db(olat, olon, radius, horizon, threshold):
    """
    Query campgrounds within radius, attach pre-computed forecasts, build grid.
    If any campgrounds have stale/missing forecasts, triggers an on-demand fetch
    before returning — so the first user in a new area always gets real data.
    Returns None if the DB has no campgrounds at all.
    """
    campgrounds = db.get_campgrounds_near(olat, olon, radius)
    if not campgrounds:
        return None

    for camp in campgrounds:
        camp['direction'] = _bearing_to_dir(_bearing(olat, olon, camp['lat'], camp['lon']))

    camp_ids = [c['id'] for c in campgrounds]

    stale = db.stale_camp_ids(camp_ids)
    if stale:
        stale_camps = [c for c in campgrounds if c['id'] in set(stale)]
        log.info('On-demand fetch for %d stale campgrounds near (%.4f, %.4f)',
                 len(stale_camps), olat, olon)
        refresh_forecasts_for(stale_camps, horizon=horizon)

    db_forecasts = db.get_forecasts_for_camps(camp_ids, horizon)
    return build_grid_from_db(campgrounds, db_forecasts, threshold)


@bp.route('/')
def index():
    destinations = load_destinations()
    t, h, dep = DEFAULTS['threshold'], DEFAULTS['horizon'], DEFAULTS['departure_day']
    tt = DEFAULTS['temp_threshold']
    rows = build_grid(destinations, horizon=h, threshold=t)
    top3 = build_top3(rows, departure_day=dep, threshold=t, temp_threshold=tt)
    best = rows[0] if rows else None
    now  = datetime.now()
    return render_template(
        'index.html',
        rows=rows,
        horizon=h,
        threshold=t,
        departure_day=dep,
        temp_threshold=tt,
        radius=DEFAULTS['radius'],
        top3=top3,
        best=best,
        last_updated=_format_updated(cache_last_updated()),
        bulletin_no=f"{now.strftime('%y')}-{now.timetuple().tm_yday:03d}",
        today=now.strftime('%m·%d'),
    )


@bp.route('/api/forecast', methods=['POST'])
def forecast():
    body = request.get_json(force=True)
    threshold      = int(body.get('threshold', DEFAULTS['threshold']))
    horizon        = int(body.get('horizon', DEFAULTS['horizon']))
    departure_day  = int(body.get('departure_day', DEFAULTS['departure_day']))
    temp_threshold = int(body.get('temp_threshold', DEFAULTS['temp_threshold']))
    radius         = int(body.get('radius', DEFAULTS['radius']))
    force          = bool(body.get('force', False))
    origin_lat     = body.get('origin_lat')
    origin_lon     = body.get('origin_lon')

    rows = None

    if origin_lat is not None and origin_lon is not None:
        olat, olon = float(origin_lat), float(origin_lon)
        rows = _rows_from_db(olat, olon, radius, horizon, threshold)

    if rows is None:
        # fallback: curated YAML + legacy forecast_cache
        destinations = load_destinations()
        if origin_lat is not None and origin_lon is not None:
            _recompute_directions(destinations, float(origin_lat), float(origin_lon))
        rows = build_grid(destinations, horizon=horizon, threshold=threshold, force=force)

    top3 = build_top3(rows, departure_day=departure_day, threshold=threshold, temp_threshold=temp_threshold)
    best = rows[0] if rows else None

    return jsonify({
        'rows': rows,
        'horizon': horizon,
        'threshold': threshold,
        'departure_day': departure_day,
        'temp_threshold': temp_threshold,
        'radius': radius,
        'top3': top3,
        'best': best,
        'last_updated': _format_updated(cache_last_updated()),
    })
