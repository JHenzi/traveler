# Weather Horizon — Product Roadmap

**Hosted at:** `travel.henzi.org`
**Stack:** Python / Flask / Open-Meteo / RIDB / Overpass / SQLite
**Cost to run:** $0 (VPS you already have)

---

## The Scaling Problem We're Solving Up Front

The original plan fetched weather on demand: user arrives → app calls Open-Meteo for N campgrounds → returns results. That works for one user. It falls apart the moment two users from different cities arrive simultaneously — every request is a cache miss, and the number of Open-Meteo calls grows with traffic, not with the size of the dataset.

**The fix:** invert the data flow.

- **Campground locations** are pre-fetched from RIDB + Overpass once and stored in SQLite. They don't change.
- **Weather forecasts** are pre-fetched for every known campground by a background job, refreshed every 6 hours. This is a fixed cost (~30–150 Open-Meteo batch requests per refresh cycle), independent of user traffic.
- **Query time does zero external API calls.** User enters zip → geocode → filter campgrounds from DB by radius → score from cached forecasts → return. Fast, consistent, scales to any traffic.

Database size is not a concern: 10,000 campgrounds × 7 days × ~100 bytes ≈ **7MB**. Even 50,000 campgrounds fits in ~35MB. SQLite handles this effortlessly.

---

## Current State (v0 — Cincinnati-Hardcoded)

Working Flask app:
- 50+ curated campgrounds across OH, KY, IN loaded from `destinations.yml`
- Batch weather fetch via Open-Meteo (no API key)
- Dry-window algorithm: consecutive days under a rain threshold
- Trip scoring: rain penalty + heat penalty weighted by departure day
- Top 3 recommendations panel + full destination grid
- Radar chart showing dry-window scores by compass direction
- 30-minute in-memory cache, instant slider re-render via `/api/forecast`

**What's missing before anyone else can use it:** origin and destination list are hardcoded to Cincinnati; no persistent storage; in-memory cache dies on restart.

---

## v1 — Ship It (1–2 weekends)

**Goal:** A real URL. Real users. Cincinnati default. Zero friction.

### 1.1 — Configurable Origin
- Replace hardcoded "Cincinnati, OH" with an address/zip input field in the sidebar
- Geocode with **Nominatim** (OpenStreetMap — free, no key)
- Store origin in session or pass through the forecast API call
- Default stays Cincinnati for first load

### 1.2 — Static SEO Landing Page
- Nginx serves `landing/index.html` at `travel.henzi.org/` — Flask never touches it
- Address input → Nominatim geocode (client-side JS) → builds URL and redirects to `/plan`:
  ```
  /plan?origin=Cincinnati+OH&lat=39.10&lon=-84.51&radius=200&threshold=30
  ```

### 1.3 — Deploy to travel.henzi.org
- DNS, Nginx config (`deploy/travel.henzi.org.conf` already written), SSL via certbot
- Flask runs in Docker on port 5000, Nginx proxies `/plan` and `/api/`

**Deliverables:** Live URL, shareable with anyone. Still using `destinations.yml` as the source — that's fine for v1.

---

## v2 — Pre-Cached Parks + Scalable Architecture (the big one)

**Goal:** Works for any US user. Zero API calls at query time. Handles viral traffic.

### 2.1 — SQLite Database

Two tables:

```sql
CREATE TABLE campgrounds (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    source      TEXT,        -- 'ridb', 'overpass', 'curated'
    state       TEXT,
    url         TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE forecasts (
    campground_id  INTEGER REFERENCES campgrounds(id),
    date           TEXT,       -- YYYY-MM-DD
    temp_max       REAL,
    precip_prob    INTEGER,
    weathercode    INTEGER,
    refreshed_at   TEXT,
    PRIMARY KEY (campground_id, date)
);

CREATE INDEX idx_campgrounds_latlon ON campgrounds(lat, lon);
```

SQLite with WAL mode handles thousands of concurrent reads without locking. No Postgres needed unless you're running on multiple servers.

### 2.2 — Campground Ingestion (runs once, then daily)

Fetch all known campgrounds from two sources and store them:

**RIDB (Recreation.gov)** — federal lands, authoritative, has reservation links:
```
GET https://ridb.recreation.gov/api/v1/facilities
    ?activity=CAMPING&latitude=X&longitude=Y&radius=500&apikey=YOUR_KEY
```
Free key, instant email signup. Covers National Forest, NPS, BLM — ~3,500 facilities.

**Overpass API** — OpenStreetMap, no key, covers state parks and private sites:
```python
query = '[out:json][timeout:60]; node["tourism"="camp_site"]({{bbox}}); out body;'
```
Run over a US bounding box in regional chunks. Returns ~20,000–50,000 nodes.

Deduplication: if two sources return a campground within 0.1 miles of each other, keep the RIDB record (it has better metadata). Store `source` field so curated YAML entries survive as `'curated'`.

### 2.3 — Background Weather Refresh Job

A thread that runs every 6 hours and refreshes forecasts for all campgrounds:

```python
def refresh_all_forecasts():
    campgrounds = db.get_all_campgrounds()          # read from SQLite
    for batch in chunks(campgrounds, 300):          # Open-Meteo handles ~300/request
        forecasts = fetch_open_meteo_batch(batch)  # one HTTP request per 300 sites
        db.upsert_forecasts(forecasts)             # write back to SQLite
    # 10,000 campgrounds = ~34 requests, ~2 min runtime, 4x/day = fine
```

Open-Meteo's batch API accepts comma-separated lat/lon pairs. At 10,000 campgrounds, this is ~34 requests per cycle — well within free-tier reasonable use. At 50,000, it's ~167 requests. Still fine.

### 2.4 — Query-Time Flow (zero external API calls)

```
User enters zip → Nominatim geocode (one fast HTTP call)
                → SELECT campgrounds WHERE distance(lat,lon) <= radius
                → JOIN forecasts ON campground_id
                → run dry-window + trip score algo in Python
                → return ranked results
```

The Nominatim geocode is the only external call at query time. Everything else is local SQLite reads.

### 2.5 — Radius Slider

Add radius control to sidebar: 50 / 100 / 150 / 200 / 300 miles. The DB query handles the filtering — no new API calls for wider radii.

**Deliverables:** Any US user enters their zip → sees local campgrounds ranked by weather. Handles 1,000 simultaneous users with no performance change because the hot path is pure DB reads.

---

## v3 — My List (Saved Favorites)

- Save/unsave destinations to browser `localStorage` — no backend, no auth
- "My List" toggle filters the grid to saved destinations only
- Heart icon on each row to save/remove
- Optional: export list as `.yml` (same format as `destinations.yml`)

---

## v4 — Shareable Links

- All controls (origin, radius, threshold, temp, horizon, departure day) encoded in URL params
  ```
  travel.henzi.org/plan?zip=45202&radius=200&threshold=30&horizon=7&dep=2
  ```
- "Copy Link" button in sidebar

---

## v5 — Mobile Card View

Each destination gets a compact card: name, direction, score badge, 3-day emoji strip. Toggle between grid and card view. No new backend work.

---

## Scaling Path (if it goes viral)

The architecture is designed so each tier upgrade is a drop-in swap, not a rewrite:

| Traffic level | What to do |
|---|---|
| < 10k users/day | SQLite + WAL mode. No changes needed. |
| 10k–100k users/day | Add Redis to cache scored results per (geohash bucket + settings). Cache TTL = 30 min. Hits the DB far less. |
| 100k+ users/day | Swap SQLite for PostgreSQL (same schema, same queries). Add a CDN in front of static assets. |
| Viral spike | Campground scoring is stateless CPU work — scale Flask horizontally behind a load balancer. The DB is the only shared state. |

The background refresh job runs on one node and writes to the DB. All Flask workers read from it. This doesn't change at any traffic tier.

**Open-Meteo commercial tier** exists if you need SLA guarantees. At the volumes this app needs (4 refreshes/day, ~170 requests each), the free tier is fine even at scale — the cost is fixed by campground count, not user count.

---

## Hosting Architecture (travel.henzi.org)

```
User → travel.henzi.org
         │
         └── VPS (Nginx)
               │
               ├── /           → static HTML landing page
               ├── /plan       → proxy → Flask/Gunicorn :5000
               ├── /api/*      → proxy → Flask/Gunicorn :5000
               └── /static/*   → proxy → Flask/Gunicorn :5000

Flask process:
  ├── Request workers (Gunicorn)   ← reads SQLite (WAL, concurrent-safe)
  └── Background thread            ← writes SQLite every 6h (refresh job)
```

**SQLite file:** `/data/traveler.db` — mount as a Docker volume so it survives container restarts.

---

## Milestone Summary

| Version | What Ships | Effort |
|---------|-----------|--------|
| v1 | Live at `travel.henzi.org`, configurable origin, Cincinnati default | 1–2 weekends |
| v2 | SQLite DB, pre-cached campgrounds + forecasts, background refresh, any US user | 2–3 weekends |
| v3 | Saved favorites in localStorage | 1 weekend |
| v4 | Shareable URLs | 1 day |
| v5 | Mobile card view | 1 weekend |

---

## What Never Changes

- `calc_dry_window()` and `calc_trip_score()` — the core algorithm is pure Python, no dependencies
- `build_grid()` and `build_top3()` — same logic, just reading from SQLite instead of live API
- The trip score formula
- Docker setup (add a volume mount for the DB)

The only structural change from v1 → v2 is **where the destination list and forecasts come from.** The scoring engine doesn't know or care.
