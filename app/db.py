import json
import math
import os
import sqlite3
import time

DB_PATH = os.environ.get('DATABASE_PATH', 'data/traveler.db')
CACHE_TTL = 30 * 60  # 30 minutes


def _conn():
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    return conn


def init_db():
    conn = _conn()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS forecast_cache (
            horizon     INTEGER PRIMARY KEY,
            data        TEXT    NOT NULL,
            fetched_at  REAL    NOT NULL
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS campgrounds (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            lat         REAL NOT NULL,
            lon         REAL NOT NULL,
            source      TEXT DEFAULT 'curated',
            state       TEXT,
            url         TEXT,
            UNIQUE(name, lat, lon)
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS forecasts (
            campground_id  INTEGER REFERENCES campgrounds(id) ON DELETE CASCADE,
            forecast_date  TEXT NOT NULL,
            temp_max       REAL,
            precip_prob    INTEGER,
            weathercode    INTEGER,
            refreshed_at   REAL NOT NULL,
            PRIMARY KEY (campground_id, forecast_date)
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_camps_latlon ON campgrounds(lat, lon)')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS api_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            service    TEXT NOT NULL,
            called_at  REAL NOT NULL
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_api_log_svc ON api_log(service, called_at)')
    conn.commit()
    conn.close()


def cache_get(horizon):
    try:
        conn = _conn()
        row = conn.execute(
            'SELECT data, fetched_at FROM forecast_cache WHERE horizon = ?', (horizon,)
        ).fetchone()
        conn.close()
        if row and (time.time() - row['fetched_at']) < CACHE_TTL:
            return json.loads(row['data'])
    except Exception:
        pass
    return None


def cache_set(horizon, data):
    conn = _conn()
    conn.execute(
        'INSERT OR REPLACE INTO forecast_cache (horizon, data, fetched_at) VALUES (?, ?, ?)',
        (horizon, json.dumps(data), time.time())
    )
    conn.commit()
    conn.close()


def cache_last_updated():
    try:
        conn = _conn()
        row = conn.execute('SELECT MAX(fetched_at) AS ts FROM forecast_cache').fetchone()
        conn.close()
        return row['ts'] if row and row['ts'] else None
    except Exception:
        return None


def cache_invalidate():
    conn = _conn()
    conn.execute('DELETE FROM forecast_cache')
    conn.commit()
    conn.close()


# ── CAMPGROUNDS ──────────────────────────────────────────────────────────────

def _haversine_mi(lat1, lon1, lat2, lon2):
    R = 3958.8
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def upsert_campgrounds(records):
    """records: list of {name, lat, lon, source?, state?, url?}"""
    conn = _conn()
    conn.executemany(
        'INSERT OR IGNORE INTO campgrounds (name, lat, lon, source, state, url) VALUES (?,?,?,?,?,?)',
        [(r['name'], r['lat'], r['lon'], r.get('source', 'curated'),
          r.get('state'), r.get('url')) for r in records],
    )
    conn.commit()
    conn.close()


def get_all_campgrounds():
    conn = _conn()
    rows = conn.execute('SELECT id, name, lat, lon, source, state, url FROM campgrounds').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def campground_count():
    conn = _conn()
    n = conn.execute('SELECT COUNT(*) FROM campgrounds').fetchone()[0]
    conn.close()
    return n


def get_campgrounds_near(lat, lon, radius_mi):
    """Bounding-box pre-filter in SQL, exact Haversine in Python."""
    dlat = radius_mi / 69.0
    dlon = radius_mi / (69.0 * math.cos(math.radians(lat)) + 1e-9)
    conn = _conn()
    rows = conn.execute(
        '''SELECT id, name, lat, lon, source, state, url FROM campgrounds
           WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?''',
        (lat - dlat, lat + dlat, lon - dlon, lon + dlon),
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        dist = _haversine_mi(lat, lon, r['lat'], r['lon'])
        if dist <= radius_mi:
            result.append({**dict(r), 'distance_mi': round(dist, 1)})
    result.sort(key=lambda x: x['distance_mi'])
    return result


# ── FORECASTS ────────────────────────────────────────────────────────────────

def upsert_forecasts(campground_id, day_rows):
    """day_rows: list of {date, temp_max, precip_prob, weathercode}"""
    now = time.time()
    conn = _conn()
    conn.executemany(
        '''INSERT OR REPLACE INTO forecasts
           (campground_id, forecast_date, temp_max, precip_prob, weathercode, refreshed_at)
           VALUES (?,?,?,?,?,?)''',
        [(campground_id, d['date'], d['temp_max'], d['precip_prob'],
          d.get('weathercode', 0), now) for d in day_rows],
    )
    conn.commit()
    conn.close()


def get_forecasts_for_camps(camp_ids, horizon):
    """Returns {camp_id: [day_dicts sorted by date]} for up to horizon days."""
    if not camp_ids:
        return {}
    placeholders = ','.join('?' * len(camp_ids))
    conn = _conn()
    rows = conn.execute(
        f'''SELECT campground_id, forecast_date, temp_max, precip_prob, weathercode
            FROM forecasts
            WHERE campground_id IN ({placeholders})
            ORDER BY campground_id, forecast_date''',
        camp_ids,
    ).fetchall()
    conn.close()
    result = {}
    for r in rows:
        cid = r['campground_id']
        result.setdefault(cid, [])
        if len(result[cid]) < horizon:
            result[cid].append({
                'date':        r['forecast_date'],
                'temp_max':    r['temp_max'],
                'precip_prob': r['precip_prob'],
                'weathercode': r['weathercode'],
            })
    return result


def forecasts_fresh(max_age_hours=7):
    """True if any forecast was written within max_age_hours."""
    conn = _conn()
    row = conn.execute('SELECT MAX(refreshed_at) AS ts FROM forecasts').fetchone()
    conn.close()
    if not row or not row['ts']:
        return False
    return (time.time() - row['ts']) < max_age_hours * 3600


def forecasts_fresh_for(camp_ids, max_age_hours=7):
    """True if every camp_id in the list has at least one fresh forecast row."""
    if not camp_ids:
        return False
    cutoff = time.time() - max_age_hours * 3600
    placeholders = ','.join('?' * len(camp_ids))
    conn = _conn()
    row = conn.execute(
        f'''SELECT COUNT(DISTINCT campground_id) FROM forecasts
            WHERE campground_id IN ({placeholders}) AND refreshed_at > ?''',
        (*camp_ids, cutoff),
    ).fetchone()
    conn.close()
    return (row[0] if row else 0) >= len(camp_ids)


def stale_camp_ids(camp_ids, max_age_hours=7):
    """Return subset of camp_ids whose forecasts are missing or older than max_age_hours."""
    if not camp_ids:
        return []
    cutoff = time.time() - max_age_hours * 3600
    placeholders = ','.join('?' * len(camp_ids))
    conn = _conn()
    fresh = set(
        r[0] for r in conn.execute(
            f'''SELECT DISTINCT campground_id FROM forecasts
                WHERE campground_id IN ({placeholders}) AND refreshed_at > ?''',
            (*camp_ids, cutoff),
        ).fetchall()
    )
    conn.close()
    return [cid for cid in camp_ids if cid not in fresh]


# ── API RATE TRACKING ─────────────────────────────────────────────────────────

def log_api_call(service):
    conn = _conn()
    conn.execute('INSERT INTO api_log (service, called_at) VALUES (?, ?)',
                 (service, time.time()))
    conn.commit()
    conn.close()


def api_call_count(service, window_seconds=3600):
    conn = _conn()
    n = conn.execute(
        'SELECT COUNT(*) FROM api_log WHERE service=? AND called_at > ?',
        (service, time.time() - window_seconds),
    ).fetchone()[0]
    conn.close()
    return n
