import time
import requests

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
CACHE_TTL = 30 * 60  # 30 minutes

_cache = {}  # key: horizon -> {fetched_at, data}


def _cache_get(horizon):
    entry = _cache.get(horizon)
    if entry and (time.time() - entry["fetched_at"]) < CACHE_TTL:
        return entry["data"]
    return None


def _cache_set(horizon, data):
    _cache[horizon] = {"fetched_at": time.time(), "data": data}


def cache_last_updated():
    if not _cache:
        return None
    return max(e["fetched_at"] for e in _cache.values())


def cache_invalidate():
    _cache.clear()

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
        cached = _cache_get(horizon)
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

    _cache_set(horizon, results)
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
