# Dev Plan: Weather Horizon Route Planner

## Stack

- **Runtime:** Python 3.11
- **Framework:** Flask
- **Server:** Gunicorn
- **Container:** Docker + docker-compose
- **Database:** SQLite (WAL mode) — persistent, file-based, survives restarts
- **Background jobs:** `APScheduler` (in-process scheduler, no Celery/Redis needed for this scale)
- **Core libs:** `requests`, `pyyaml`, `apscheduler`
- **Data sources:**
  - Open-Meteo API (weather forecasts, no key required)
  - RIDB Recreation.gov API (federal campgrounds, free key)
  - Overpass API (OSM campgrounds, no key)
  - Nominatim (geocoding, no key)

---

## Project Structure

```
traveler/
├── app/
│   ├── __init__.py          # Flask app factory — starts scheduler on first worker
│   ├── routes.py            # GET /plan, GET /api/forecast
│   ├── weather.py           # Open-Meteo batch fetch + dry-window algorithm
│   ├── destinations.py      # Loads destinations.yml (used in v1, fallback in v2)
│   ├── db.py                # SQLite connection, schema init, campground/forecast queries
│   ├── ingest.py            # RIDB + Overpass fetch → insert into campgrounds table
│   ├── jobs.py              # Background scheduler: refresh_all_forecasts() every 6h
│   └── templates/
│       ├── index.html
│       ├── top3.html
│       └── grid.html
├── static/
│   ├── style.css
│   └── app.js
├── destinations.yml          # Curated Cincinnati campgrounds (source='curated' in DB)
├── data/                     # Docker volume mount point
│   └── traveler.db           # SQLite database (gitignored)
├── requirements.txt
├── Dockerfile
└── docker-compose.yml
```

---

## Database Schema (`db.py`)

```sql
-- Run once at startup if tables don't exist
CREATE TABLE IF NOT EXISTS campgrounds (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    source      TEXT,        -- 'ridb', 'overpass', 'curated'
    state       TEXT,
    url         TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS forecasts (
    campground_id  INTEGER REFERENCES campgrounds(id) ON DELETE CASCADE,
    date           TEXT,        -- YYYY-MM-DD
    temp_max       REAL,
    precip_prob    INTEGER,
    weathercode    INTEGER,
    refreshed_at   TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (campground_id, date)
);

CREATE INDEX IF NOT EXISTS idx_campgrounds_latlon ON campgrounds(lat, lon);
PRAGMA journal_mode=WAL;  -- concurrent read-safe, required for multi-worker Gunicorn
```

---

## Phase 1 — Database Layer (`db.py`)

Key functions:

```python
def init_db()                                   # create tables + WAL mode
def get_campgrounds_near(lat, lon, radius_mi)   # returns list of {id,name,lat,lon,...}
def get_forecasts(campground_ids)               # returns {id: [day_dicts]}
def upsert_campgrounds(records)                 # insert or ignore by (name, lat, lon)
def upsert_forecasts(campground_id, days)       # INSERT OR REPLACE
def campground_count()                          # for health check endpoint
def forecast_last_refreshed()                   # for UI "data as of" display
```

Radius filtering uses the Haversine approximation in Python after a bounding-box pre-filter in SQL (fast index scan), then exact distance check in Python. No PostGIS needed.

---

## Phase 2 — Campground Ingestion (`ingest.py`)

Runs once on first startup (if campgrounds table is empty), then nightly.

```python
def ingest_curated()     # load destinations.yml → upsert with source='curated'
def ingest_ridb(lat, lon, radius_mi)   # RIDB API → upsert with source='ridb'
def ingest_overpass(lat, lon, radius_mi)  # Overpass API → upsert with source='overpass'
def dedup_campgrounds()  # remove overpass/ridb duplicates within 0.1mi of a curated entry
```

For v1, only `ingest_curated()` runs (populates from YAML). For v2, all three run.

---

## Phase 3 — Weather Pipeline (`weather.py`)

Mostly unchanged from v0. Key difference: `fetch_forecasts()` now accepts a list of campground dicts and returns results the same way — the caller (jobs.py) handles writing to DB.

`build_grid()` and `build_top3()` are unchanged — they take the same input format whether it came from a live API call or a DB read.

---

## Phase 4 — Background Refresh Job (`jobs.py`)

```python
from apscheduler.schedulers.background import BackgroundScheduler

def refresh_all_forecasts():
    campgrounds = db.get_all_campgrounds()
    for batch in chunks(campgrounds, 300):       # Open-Meteo max ~300 per request
        data = weather.fetch_open_meteo_batch(batch)
        for cg_id, days in data.items():
            db.upsert_forecasts(cg_id, days)

def start_scheduler():
    scheduler = BackgroundScheduler()
    scheduler.add_job(refresh_all_forecasts, 'interval', hours=6, id='weather_refresh')
    scheduler.start()
    refresh_all_forecasts()  # run immediately on startup
```

Started in `app/__init__.py` inside the Flask app factory, guarded by `os.environ.get('WERKZEUG_RUN_MAIN')` so it doesn't double-start in dev mode.

---

## Phase 5 — Flask Routes (`routes.py`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/plan` | Renders dashboard; reads campgrounds + forecasts from DB |
| GET | `/api/forecast` | Returns scored grid JSON; accepts `lat, lon, radius, threshold, horizon, departure` params |
| GET | `/api/health` | Returns campground count + forecast last-refreshed timestamp |

Query-time flow in `/api/forecast`:
1. Geocode origin (Nominatim) if lat/lon not already in params
2. `db.get_campgrounds_near(lat, lon, radius)` — pure DB read
3. `db.get_forecasts(campground_ids)` — pure DB read
4. `build_grid()` → `build_top3()` — pure Python
5. Return JSON

Zero external API calls in the hot path.

---

## Phase 6 — Docker

**`docker-compose.yml`** — adds a named volume for the SQLite database:

```yaml
services:
  web:
    build: .
    ports:
      - "5000:5000"
    volumes:
      - db_data:/app/data
    environment:
      - DATABASE_PATH=/app/data/traveler.db
      - RIDB_API_KEY=${RIDB_API_KEY:-}   # optional; skips RIDB ingest if absent

volumes:
  db_data:
```

The `data/` directory is the only stateful thing. Backup = copy `traveler.db`.

---

## Build Order

| # | Phase | Deliverable |
|---|-------|-------------|
| 1 | DB layer | `db.py` — schema, queries, WAL mode |
| 2 | Ingest | `ingest.py` — curated YAML → DB (v1), RIDB + Overpass (v2) |
| 3 | Weather pipeline | `weather.py` — unchanged logic, batch-friendly interface |
| 4 | Background job | `jobs.py` + scheduler wired into app factory |
| 5 | Flask routes | `routes.py` — reads from DB instead of live fetch |
| 6 | UI | Templates + JS (same as v0) |
| 7 | Docker | Add volume mount, env var for DB path |

---

## Definition of Done

- App runs via `docker compose up` with no API keys required (RIDB key is optional)
- On first start: curated destinations ingested from YAML, forecasts fetched for all of them
- Adjusting sliders re-scores from cached DB data — no external API calls
- Forecast data survives container restarts (volume-mounted SQLite)
- `/api/health` returns campground count and last refresh timestamp
- Gunicorn workers can read DB concurrently without locking (WAL mode)
- Background refresh job runs every 6 hours without blocking request workers
