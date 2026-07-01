import logging
import threading
import time
import math
from datetime import datetime
from flask import Blueprint, render_template, request, jsonify

log = logging.getLogger(__name__)
from .destinations import load_destinations
from .weather import build_grid, build_top3, build_grid_from_db, refresh_forecasts_for, is_rate_limited, cache_last_updated
from . import db

bp = Blueprint('main', __name__)

DEFAULTS = dict(threshold=30, horizon=7, departure_day=2, temp_threshold=82, radius=150)
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
    If any campgrounds have stale/missing forecasts, kicks off a background fetch
    and returns immediately with whatever data is already in the DB.
    Returns (rows, stale_count) — stale_count > 0 means the client should poll.
    Returns (None, 0) if the DB has no campgrounds at all.
    """
    campgrounds = db.get_campgrounds_near(olat, olon, radius)
    if not campgrounds:
        return None, 0

    for camp in campgrounds:
        camp['direction'] = _bearing_to_dir(_bearing(olat, olon, camp['lat'], camp['lon']))

    camp_ids = [c['id'] for c in campgrounds]
    stale = db.stale_camp_ids(camp_ids)

    if stale:
        stale_camps = [c for c in campgrounds if c['id'] in set(stale)]
        if is_rate_limited():
            # Cap already hit — don't spawn a doomed thread, don't tell the UI to poll.
            log.info('Stale camps (%d) exist but rate-limited — serving cached data without poll banner',
                     len(stale_camps))
            stale = []
        else:
            log.info('Background fetch started for %d stale campgrounds near (%.4f, %.4f)',
                     len(stale_camps), olat, olon)
            threading.Thread(
                target=refresh_forecasts_for,
                args=(stale_camps,),
                kwargs={'horizon': horizon},
                daemon=True,
            ).start()

    db_forecasts = db.get_forecasts_for_camps(camp_ids, horizon)
    rows = build_grid_from_db(campgrounds, db_forecasts, threshold)
    rows = [r for r in rows if r['days']]  # hide campgrounds with no forecast yet
    return rows, len(stale)


@bp.route('/')
def index():
    t   = int(request.args.get('threshold', DEFAULTS['threshold']))
    h   = int(request.args.get('horizon',   DEFAULTS['horizon']))
    dep = int(request.args.get('dep',       DEFAULTS['departure_day']))
    tt  = int(request.args.get('temp',      DEFAULTS['temp_threshold']))
    r   = int(request.args.get('radius',    DEFAULTS['radius']))

    olat_s = request.args.get('lat')
    olon_s = request.args.get('lon')
    olabel = request.args.get('origin', 'Cincinnati, OH')
    olat   = float(olat_s) if olat_s else CINCINNATI[0]
    olon   = float(olon_s) if olon_s else CINCINNATI[1]

    destinations = load_destinations()
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
        radius=r,
        top3=top3,
        best=best,
        last_updated=_format_updated(cache_last_updated()),
        bulletin_no=f"{now.strftime('%y')}-{now.timetuple().tm_yday:03d}",
        today=now.strftime('%m·%d'),
        origin_lat=olat,
        origin_lon=olon,
        origin_label=olabel,
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
    stale_count = 0

    if origin_lat is not None and origin_lon is not None:
        olat, olon = float(origin_lat), float(origin_lon)
        rows, stale_count = _rows_from_db(olat, olon, radius, horizon, threshold)

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
        'fetching': stale_count > 0,
        'stale_count': stale_count,
    })
