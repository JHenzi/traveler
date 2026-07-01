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

    # Camps to show the user in poll banner: only those with NO forecast rows yet.
    # Old-but-present forecasts are still displayed immediately; we refresh them
    # silently in the background without asking the user to wait 12 seconds.
    missing = db.camps_with_no_forecasts(camp_ids) if stale else []
    banner_count = len(missing)

    if stale:
        stale_camps = [c for c in campgrounds if c['id'] in set(stale)]
        if is_rate_limited():
            log.info('Stale camps (%d) exist but rate-limited — serving cached data without poll banner',
                     len(stale_camps))
            banner_count = 0
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
    return rows, banner_count


def _clamp(val, lo, hi):
    return max(lo, min(hi, val))


def _int_param(key, default, lo, hi):
    try:
        return _clamp(int(request.args.get(key, default)), lo, hi)
    except (ValueError, TypeError):
        return default


def _float_param(key, default, lo, hi):
    try:
        return _clamp(float(request.args.get(key, default)), lo, hi)
    except (ValueError, TypeError):
        return default


@bp.route('/health')
def health():
    return {'ok': True}, 200


@bp.route('/')
def index():
    t   = _int_param('threshold', DEFAULTS['threshold'],   0,   90)
    h   = _int_param('horizon',   DEFAULTS['horizon'],     1,   16)
    dep = _int_param('dep',       DEFAULTS['departure_day'], 1, 14)
    tt  = _int_param('temp',      DEFAULTS['temp_threshold'], 60, 120)
    r   = _int_param('radius',    DEFAULTS['radius'],      10,  500)

    olat_s = request.args.get('lat')
    olon_s = request.args.get('lon')
    olabel = request.args.get('origin', 'Cincinnati, OH')[:80]
    olat   = _float_param('lat', CINCINNATI[0], -90.0, 90.0) if olat_s else CINCINNATI[0]
    olon   = _float_param('lon', CINCINNATI[1], -180.0, 180.0) if olon_s else CINCINNATI[1]

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
    body = request.get_json(force=True, silent=True) or {}

    def _i(key, default, lo, hi):
        try:
            return _clamp(int(body.get(key, default)), lo, hi)
        except (ValueError, TypeError):
            return default

    def _f(key, lo, hi):
        v = body.get(key)
        if v is None:
            return None
        try:
            return _clamp(float(v), lo, hi)
        except (ValueError, TypeError):
            return None

    threshold      = _i('threshold',      DEFAULTS['threshold'],      0,    90)
    horizon        = _i('horizon',        DEFAULTS['horizon'],        1,    16)
    departure_day  = _i('departure_day',  DEFAULTS['departure_day'],  1,    14)
    temp_threshold = _i('temp_threshold', DEFAULTS['temp_threshold'], 60,  120)
    radius         = _i('radius',         DEFAULTS['radius'],         10,  500)
    force          = bool(body.get('force', False))
    origin_lat     = _f('origin_lat', -90.0,  90.0)
    origin_lon     = _f('origin_lon', -180.0, 180.0)

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
