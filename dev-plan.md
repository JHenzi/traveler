# Dev Plan — Weather Horizon / National Camp Forecast Bureau

**Last updated:** 2026-06-28  
**Live at:** `192.168.1.220:5847` (local VPS, not yet public)  
**Target domain:** `travel.henzi.org`

---

## What's Already Done

| Feature | Status |
|---|---|
| Core Flask app — dry-window algorithm, trip score, Top 3 | ✅ |
| Bureau Bulletin design system (Oswald + Space Mono, full UI) | ✅ |
| Location input — Nominatim geocoding, bearing recompute | ✅ |
| Heat ceiling visual — amber cells, HEAT badge in picks | ✅ |
| Park Forecast click-to-focus panel | ✅ |
| Dry window bug fixed — counts from departure day, not day 0 | ✅ |
| SQLite shared cache — replaces per-worker in-memory dict | ✅ |
| Scheduler container — only service that calls Open-Meteo | ✅ |
| Docker Compose: `web` + `scheduler` + shared `db_data` volume | ✅ |

---

## Sprint 1 — Deploy to travel.henzi.org
**Effort:** 1 afternoon  
**Goal:** Public URL. Anyone can use it today.

The app is ready. This is pure infrastructure.

### Steps

**1. DNS**
In your registrar for henzi.org, add:
```
travel    A    YOUR_VPS_IP
```
TTL: 300 (5 min). Confirm with `dig travel.henzi.org` once propagated.

**2. Nginx**
The config is already written at `deploy/travel.henzi.org.conf`.
On the VPS:
```bash
sudo cp deploy/travel.henzi.org.conf /etc/nginx/sites-available/travel.henzi.org
sudo ln -s /etc/nginx/sites-available/travel.henzi.org /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**3. SSL**
```bash
sudo certbot --nginx -d travel.henzi.org
```
Auto-renews via the certbot systemd timer already on your VPS.

**4. Deploy**
On the VPS, in the project directory:
```bash
git pull
docker compose up --build -d
```
The scheduler container runs the initial Open-Meteo fetch (~8 sec), then web workers serve from SQLite.

**5. Smoke test**
- `https://travel.henzi.org` loads
- Location input geocodes a zip code
- Sliders update the grid without page reload
- `/api/forecast` returns JSON
- `docker logs traveler-scheduler-1` shows "Sleeping 6h"

**Deliverable:** Public URL you can share.

---

## Sprint 2 — Radius + Real Park Discovery (v2)
**Effort:** 2–3 weekends  
**Goal:** Works for any US user, not just Midwest campers. Campground list grows from 50 to thousands.

This is the biggest architectural lift. The current `destinations.yml` is replaced by a live-queried campground database. The location input already geocodes — now it needs to query parks near that point instead of just recomputing direction on a fixed list.

### 2A — Expand the SQLite Schema

Add a `campgrounds` table alongside the existing `forecast_cache`:

```sql
CREATE TABLE IF NOT EXISTS campgrounds (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    source      TEXT,    -- 'curated', 'ridb', 'overpass'
    state       TEXT,
    url         TEXT,
    UNIQUE(name, lat, lon)
);

CREATE TABLE IF NOT EXISTS forecasts (
    campground_id  INTEGER REFERENCES campgrounds(id) ON DELETE CASCADE,
    forecast_date  TEXT,
    temp_max       REAL,
    precip_prob    INTEGER,
    weathercode    INTEGER,
    refreshed_at   REAL,
    PRIMARY KEY (campground_id, forecast_date)
);

CREATE INDEX IF NOT EXISTS idx_campgrounds_latlon ON campgrounds(lat, lon);
```

**Important:** Keep `forecast_cache` as-is for now (the curated 50-camp fast path). Add the new tables alongside it. Migrate fully once ingestion is working.

### 2B — Campground Ingestion (`app/ingest.py`)

Three sources, in priority order:

**1. Curated YAML** (seed on startup, always present)
```python
def ingest_curated(db_conn):
    destinations = load_destinations()  # existing YAML loader
    for d in destinations:
        db_conn.execute('INSERT OR IGNORE INTO campgrounds (name,lat,lon,source) VALUES (?,?,?,?)',
                        (d['name'], d['lat'], d['lon'], 'curated'))
```

**2. RIDB — Recreation.gov** (federal lands, authoritative)
- Free API key: sign up at recreation.gov/webform/get-api-access
- Query: `GET /api/v1/facilities?activity=CAMPING&latitude=X&longitude=Y&radius=500&apikey=KEY`
- Returns: name, lat, lon, facility type, reservation link
- Run once daily via scheduler. Query by state bounding box to cover all of US.
- ~3,500 facilities total.

**3. Overpass API** (OSM — state parks, private sites, everything else)
- No key required.
- Query by US region bounding boxes to avoid timeout (split into ~20 regional chunks).
- Filter: `tourism=camp_site` with a name tag (skip unnamed nodes — low quality).
- ~20,000–50,000 nodes.
- Deduplicate: if within 0.15 miles of a curated or RIDB entry, skip.

Add `RIDB_API_KEY` env var to `docker-compose.yml`. If absent, skip RIDB ingestion and use curated + Overpass only. The app still works without it.

### 2C — Scheduler: Weather Refresh for All Campgrounds

Replace the current `forecast_cache` blob approach with per-campground per-date rows in the `forecasts` table. Scheduler logic:

```python
def refresh_all_forecasts():
    campgrounds = db.get_all_campgrounds()     # all rows from campgrounds table
    for batch in chunks(campgrounds, 300):     # Open-Meteo max ~300 lat/lon per request
        raw = fetch_open_meteo_batch(batch, horizon=10)
        db.upsert_forecasts(raw)              # write to forecasts table
    # 3,500 camps = 12 requests / 6h  ← trivial
    # 50,000 camps = 167 requests / 6h ← still fine
```

Open-Meteo is free for non-commercial use, no key required. At this volume, no rate limiting.

### 2D — Query-Time Route (zero external calls)

When a user submits a location, the flow becomes:

```
POST /api/forecast  { origin_lat, origin_lon, radius, threshold, horizon, departure_day }
  → SELECT campgrounds within radius (Haversine, bounding-box pre-filter in SQL)
  → JOIN forecasts WHERE forecast_date IN (...) AND refreshed_at > now - 6h
  → compute direction/distance from origin to each campground
  → run dry_window + trip_score  (unchanged Python functions)
  → return ranked JSON
```

No Nominatim call at query time — that's already done client-side. No Open-Meteo call at query time — forecasts come from DB. A single SQLite read returning hundreds of rows is sub-millisecond.

### 2E — Radius Slider in UI

Add to the sidebar control panel:
```
05 / SEARCH RADIUS
[──●──────] 200 mi
  50    300
```

Passes `radius` to the API. The SQL filters campgrounds by bounding box then Haversine. No new API calls — all data is already in the DB regardless of radius.

**Deliverable:** User in Denver types their zip, sees 200 Colorado campgrounds ranked by forecast quality. User in Maine sees Maine campgrounds. Cincinnati curated list is always present as the fallback/default.

---

## Sprint 3 — Shareable URLs (v4)
**Effort:** 1 day  
**Goal:** Send someone your exact view.

All controls serialized into URL params. Flask reads them on load and pre-populates the form. JS keeps the URL in sync as sliders change.

```
travel.henzi.org/?lat=39.10&lon=-84.51&origin=Cincinnati+OH&radius=200&threshold=30&horizon=7&dep=2
```

```python
# routes.py
origin_lat = request.args.get('lat', 39.1031, type=float)
origin_lon = request.args.get('lon', -84.5120, type=float)
# ... pre-populate all defaults
```

```javascript
// app.js — update URL on every slider change
function syncUrl() {
    const params = new URLSearchParams({ lat: originLat, lon: originLon, ... });
    history.replaceState(null, '', '?' + params.toString());
}
```

"Copy Link" button in sidebar. No backend work beyond reading query params.

**Deliverable:** Shareable URL that restores your exact session.

---

## Sprint 4 — Saved Favorites (v3)
**Effort:** 1 weekend  
**Goal:** Power users curate their go-to spots.

Pure client-side — no backend, no auth.

- Heart icon on each table row
- Saves `{name, lat, lon, direction}` to `localStorage`
- "My List" toggle button in sidebar filters the grid to saved camps only
- My List camps always appear in results even if outside the radius slider
- Optional: Export as `.yml` (same format as `destinations.yml` for self-hosters)

**Deliverable:** Returning users see their regular spots without re-filtering.

---

## Sprint 5 — Mobile (v5)
**Effort:** 1 weekend  
**Goal:** Usable on the trail.

The current grid is data-dense and desktop-first. A card view for phones:
- Each camp gets a compact card: name, direction badge, score, 3-day strip
- Sorted by score
- Toggle between grid and card view (saved to localStorage)
- No backend changes

**Deliverable:** Works from a campsite parking lot on a 375px screen.

---

## Milestone Summary

| Sprint | Ships | Effort | Blocker |
|---|---|---|---|
| **1 — Deploy** | `travel.henzi.org` live, SSL | 1 afternoon | DNS propagation (5–30 min) |
| **2 — Discovery** | Any US location, radius slider, thousands of parks | 2–3 weekends | RIDB API key (free, instant) |
| **3 — Share** | Copy link, URL-encoded state | 1 day | None |
| **4 — Favorites** | Heart icon, My List, localStorage | 1 weekend | None |
| **5 — Mobile** | Card view, touch-friendly | 1 weekend | None |

---

## Architecture at Each Stage

**Now (post Sprint 1):**
```
User → Nginx → Flask/Gunicorn (2 workers) → SQLite (read)
Scheduler container → Open-Meteo → SQLite (write, every 6h)
Campground source: destinations.yml (50 curated camps)
```

**After Sprint 2:**
```
User → Nginx → Flask/Gunicorn → SQLite campgrounds + forecasts (read)
Scheduler → RIDB + Overpass (daily, campground ingestion)
Scheduler → Open-Meteo (every 6h, forecasts for all ~50k campgrounds)
Campground source: SQLite (curated + RIDB + OSM)
```

**If it goes viral:**
```
Same stack. Add Redis to cache scored results per (geohash + settings).
Scale Flask workers horizontally. Swap SQLite for Postgres only if
you need multi-server writes (forecast data > single-server).
```

---

## Files to Build in Sprint 2

| File | What it does |
|---|---|
| `app/ingest.py` | YAML + RIDB + Overpass → `campgrounds` table |
| `app/db.py` (extend) | `campgrounds` table, `forecasts` table, Haversine query |
| `app/jobs.py` (extend) | Run ingestion daily, weather refresh every 6h |
| `app/weather.py` (extend) | `fetch_open_meteo_batch` that writes to `forecasts` table |
| `app/routes.py` (extend) | Accept `radius`, query campgrounds from DB instead of YAML |
| `docker-compose.yml` | Add `RIDB_API_KEY` env var |
