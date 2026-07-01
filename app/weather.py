import logging
import requests
from . import db

log = logging.getLogger(__name__)
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
BATCH_SIZE = 100  # keeps GET URLs well under server URI limits (~2.6KB at 100 coords)

# Open-Meteo free tier is "fair use" — ~10k requests/day is safe.
# We self-impose a per-hour cap to prevent runaway loops, not to stay under their limit.
# A full scheduler refresh of 500 previously-cached camps = 5 calls.
# On-demand fetches add a handful more. 600/hour gives plenty of headroom.
OPEN_METEO_HOURLY_CAP = 600


def _check_rate_limit():
    """Raise if we've exceeded our self-imposed hourly cap."""
    count = db.api_call_count('open-meteo', window_seconds=3600)
    if count >= OPEN_METEO_HOURLY_CAP:
        raise RuntimeError(
            f'Open-Meteo rate cap reached: {count} calls in the last hour '
            f'(cap={OPEN_METEO_HOURLY_CAP}). Skipping fetch.'
        )


def is_rate_limited():
    """True if we're currently at the hourly cap. Used by routes.py to avoid useless thread spawns."""
    return db.api_call_count('open-meteo', window_seconds=3600) >= OPEN_METEO_HOURLY_CAP


def cache_last_updated():
    return db.cache_last_updated()


def cache_invalidate():
    db.cache_invalidate()


def refresh_campground_forecasts(horizon=10):
    """
    Refresh forecasts only for campgrounds that have been previously fetched (have existing
    forecast rows). New campgrounds get their first forecast via on-demand fetch when a user
    queries their area — the scheduler only keeps already-active camps fresh.

    This keeps scheduler load proportional to actual usage, not total DB size.
    With 15k+ Overpass camps in the DB, fetching all of them every 6h would blow
    through any rate cap. Only fetching the ~few-hundred that users have actually
    queried is sustainable indefinitely.
    """
    campgrounds = db.get_campgrounds_with_forecasts()
    if not campgrounds:
        log.info('No previously-fetched campgrounds — skipping scheduler refresh (on-demand will populate)')
        return

    total = 0
    for i in range(0, len(campgrounds), BATCH_SIZE):
        try:
            _check_rate_limit()
        except RuntimeError as exc:
            log.warning('Bulk refresh paused at batch %d: %s', i, exc)
            break
        batch = campgrounds[i:i + BATCH_SIZE]
        try:
            _fetch_and_store_batch(batch, horizon)
            total += len(batch)
        except Exception as exc:
            log.error('Batch %d-%d failed: %s', i, i + len(batch), exc)

    log.info('Forecast refresh complete — %d campgrounds updated', total)


def refresh_forecasts_for(campgrounds, horizon=10):
    """
    On-demand fetch for a specific list of campgrounds.
    Called from routes.py when a user requests an area with stale/missing forecasts.
    Respects the hourly rate cap before fetching.
    """
    try:
        _check_rate_limit()
    except RuntimeError as exc:
        log.warning('On-demand fetch blocked: %s', exc)
        return

    for i in range(0, len(campgrounds), BATCH_SIZE):
        batch = campgrounds[i:i + BATCH_SIZE]
        try:
            _fetch_and_store_batch(batch, horizon)
        except Exception as exc:
            log.error('On-demand batch failed: %s', exc)

    log.info('On-demand forecast fetch complete — %d campgrounds', len(campgrounds))


def _fetch_and_store_batch(campgrounds, horizon):
    lats = ','.join(str(c['lat']) for c in campgrounds)
    lons = ','.join(str(c['lon']) for c in campgrounds)
    params = {
        'latitude':      lats,
        'longitude':     lons,
        'daily':         'temperature_2m_max,precipitation_probability_max,weathercode',
        'forecast_days': horizon,
        'timezone':      'America/New_York',
        'temperature_unit': 'fahrenheit',
    }
    db.log_api_call('open-meteo')
    resp = requests.get(OPEN_METEO_URL, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict):
        data = [data]

    for camp, forecast in zip(campgrounds, data):
        daily = forecast.get('daily', {})
        times = daily.get('time', [])
        days = [
            {
                'date':        times[j],
                'temp_max':    daily['temperature_2m_max'][j],
                'precip_prob': daily['precipitation_probability_max'][j],
                'weathercode': daily['weathercode'][j],
            }
            for j in range(len(times))
        ]
        db.upsert_forecasts(camp['id'], days)

WMO_CODES = {
    0: ("Clear sky", "☀️"),
    1: ("Mainly clear", "🌤️"),
    2: ("Partly cloudy", "⛅"),
    3: ("Overcast", "☁️"),
    45: ("Fog", "🌫️"),
    48: ("Icy fog", "🌫️"),
    51: ("Light drizzle", "🌦️"),
    53: ("Drizzle", "🌦️"),
    55: ("Heavy drizzle", "🌧️"),
    61: ("Light rain", "🌧️"),
    63: ("Rain", "🌧️"),
    65: ("Heavy rain", "🌧️"),
    71: ("Light snow", "🌨️"),
    73: ("Snow", "❄️"),
    75: ("Heavy snow", "❄️"),
    77: ("Snow grains", "❄️"),
    80: ("Light showers", "🌦️"),
    81: ("Showers", "🌧️"),
    82: ("Violent showers", "⛈️"),
    85: ("Snow showers", "🌨️"),
    86: ("Heavy snow showers", "❄️"),
    95: ("Thunderstorm", "⛈️"),
    96: ("Thunderstorm w/ hail", "⛈️"),
    99: ("Thunderstorm w/ heavy hail", "⛈️"),
}


def wmo_to_emoji(code):
    entry = WMO_CODES.get(code)
    if entry:
        return entry[1]
    return "🌡️"


def wmo_to_label(code):
    entry = WMO_CODES.get(code)
    if entry:
        return entry[0]
    return "Unknown"


def fetch_forecasts(destinations, horizon=7, force=False):
    if not force:
        cached = db.cache_get(horizon)
        if cached is not None:
            return cached

    lats = ",".join(str(d["lat"]) for d in destinations)
    lons = ",".join(str(d["lon"]) for d in destinations)

    params = {
        "latitude": lats,
        "longitude": lons,
        "daily": "temperature_2m_max,precipitation_probability_max,weathercode",
        "forecast_days": horizon,
        "timezone": "America/New_York",
        "temperature_unit": "fahrenheit",
    }

    db.log_api_call('open-meteo')
    resp = requests.get(OPEN_METEO_URL, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()

    if isinstance(data, dict):
        data = [data]

    results = {}
    for dest, forecast in zip(destinations, data):
        daily = forecast["daily"]
        days = []
        for i in range(len(daily["time"])):
            code = daily["weathercode"][i]
            days.append({
                "date": daily["time"][i],
                "temp_max": daily["temperature_2m_max"][i],
                "precip_prob": daily["precipitation_probability_max"][i],
                "emoji": wmo_to_emoji(code),
                "label": wmo_to_label(code),
            })
        results[dest["name"]] = days

    db.cache_set(horizon, results)
    return results


def calc_dry_window(precip_probs, threshold):
    count = 0
    for p in precip_probs:
        if p is not None and p <= threshold:
            count += 1
        else:
            break
    return count


def calc_trip_score(days, departure_idx, threshold, temp_threshold=82):
    """
    Returns (score, filtered_out) for a 3-day window starting at departure_idx.
    filtered_out=True if the departure day itself exceeds the rain threshold.
    Score = 100 - rain_penalty - heat_penalty
    Heat penalty: excess degrees above temp_threshold weighted by day (0.50/0.35/0.15).
    """
    window = days[departure_idx: departure_idx + 3]
    if not window:
        return None, True

    d0 = window[0]["precip_prob"] if len(window) > 0 else 0
    d1 = window[1]["precip_prob"] if len(window) > 1 else 0
    d2 = window[2]["precip_prob"] if len(window) > 2 else 0

    if d0 > threshold:
        return None, True

    rain_penalty = d0 * 0.50 + d1 * 0.35 + d2 * 0.15

    weights = [0.50, 0.35, 0.15]
    heat_penalty = sum(
        max(0, day["temp_max"] - temp_threshold) * weights[j] * 1.2
        for j, day in enumerate(window[:3])
    )

    score = max(0, round(100 - rain_penalty - heat_penalty, 1))
    return score, False


def build_grid_from_db(campgrounds, db_forecasts, threshold=30):
    """
    Build the same row format as build_grid() but from pre-loaded DB data.
    campgrounds: list of {id, name, direction, lat, lon, distance_mi, ...}
    db_forecasts: {campground_id: [day_dicts]} from db.get_forecasts_for_camps()
    """
    rows = []
    for camp in campgrounds:
        raw_days = db_forecasts.get(camp['id'], [])
        days = [
            {
                'date':        d['date'],
                'temp_max':    d['temp_max'],
                'precip_prob': d['precip_prob'],
                'emoji':       wmo_to_emoji(d.get('weathercode', 0)),
                'label':       wmo_to_label(d.get('weathercode', 0)),
            }
            for d in raw_days
        ]
        precip_probs = [d['precip_prob'] for d in days]
        dry_window = calc_dry_window(precip_probs, threshold)
        rows.append({
            'name':        camp['name'],
            'direction':   camp.get('direction', ''),
            'distance_mi': camp.get('distance_mi'),
            'dry_window':  dry_window,
            'days':        days,
        })
    rows.sort(key=lambda r: r['dry_window'], reverse=True)
    return rows


def build_grid(destinations, horizon=7, threshold=30, force=False):
    forecasts = fetch_forecasts(destinations, horizon, force=force)
    rows = []
    for dest in destinations:
        name = dest["name"]
        days = forecasts.get(name, [])
        precip_probs = [d["precip_prob"] for d in days]
        dry_window = calc_dry_window(precip_probs, threshold)
        rows.append({
            "name": name,
            "direction": dest["direction"],
            "dry_window": dry_window,
            "days": days,
        })
    rows.sort(key=lambda r: r["dry_window"], reverse=True)
    return rows


def build_top3(rows, departure_day, threshold, temp_threshold=82):
    """
    departure_day is 1-indexed (1 = today, 2 = tomorrow, etc.).
    Returns top 3 scored destinations after filtering.
    """
    departure_idx = departure_day - 1
    scored = []
    for row in rows:
        score, filtered = calc_trip_score(row["days"], departure_idx, threshold, temp_threshold)
        if filtered:
            continue
        scored.append({
            "name": row["name"],
            "direction": row["direction"],
            "score": score,
            "dry_window": row["dry_window"],
            "departure_day": departure_day,
            "days": row["days"],
        })

    scored.sort(key=lambda r: (r["score"], r["dry_window"]), reverse=True)
    return scored[:3]
