import json
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
