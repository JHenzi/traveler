# National Camp Forecast Bureau

Find the driest campground near you. Enter your location, set your rain tolerance and heat ceiling, and the Bureau ranks every campground within your radius by forecast quality — dry-day window, trip score, and compass bearing from your origin.

![National Camp Forecast Bureau](Screenshot%202026-06-28.png)

---

## How It Works

Weather data is **pre-fetched and cached** — no API calls at query time.

1. **Ingestion (daily):** Campground locations are pulled from Recreation.gov (RIDB) and OpenStreetMap (Overpass) and stored in SQLite. ~50,000 campgrounds across the US.
2. **Forecast refresh (every 6h):** A background scheduler fetches 10-day forecasts from [Open-Meteo](https://open-meteo.com) for every campground in batches of 300. Free, no key required.
3. **Query (instant):** User enters a zip or city → client geocodes with Nominatim → server does a Haversine radius query against SQLite → scores and ranks results → returns JSON. Zero external API calls on the hot path.
4. **On-demand fill:** If a user requests an area with missing or stale forecasts (e.g. first boot, new region), the server fetches just those campgrounds from Open-Meteo in real time (~2s) before responding.

### Scoring

Each campground gets a **Trip Quality Index (0–100)**:

```
score = 100 - rain_penalty - heat_penalty

rain_penalty = precip_prob[dep+0] × 0.50
             + precip_prob[dep+1] × 0.35
             + precip_prob[dep+2] × 0.15

heat_penalty = Σ max(0, temp_max[i] - heat_ceiling) × weight[i] × 1.2
```

The **dry-window** counts consecutive days at or below your rain threshold starting from your departure day.

---

## Stack

| Layer | Tech |
|---|---|
| Web | Flask + Gunicorn (2 workers) |
| Database | SQLite with WAL mode |
| Campground data | RIDB (Recreation.gov) + Overpass (OpenStreetMap) + curated YAML |
| Weather | [Open-Meteo](https://open-meteo.com) batch API |
| Geocoding | Nominatim (client-side JS) |
| Container | Docker Compose — `web` + `scheduler` services, shared volume |
| Design | Bureau Bulletin — Oswald + Space Mono, tan/khaki palette |

---

## Running Locally

**Prerequisites:** Docker, Docker Compose

```bash
git clone <repo>
cd traveler

# Optional: add your free RIDB key for federal campground data
# Sign up at https://ridb.recreation.gov/docs
echo "RIDB_API_KEY=your_key_here" > .env

docker compose up --build
```

Open [http://localhost:5847](http://localhost:5847).

On first boot the scheduler seeds the 50 curated campgrounds immediately and begins ingesting from RIDB + Overpass. Forecasts for your local area are fetched on your first request if the scheduler hasn't reached them yet.

---

## Configuration

All controls are in the sidebar — no config files needed.

| Control | What it does |
|---|---|
| **Your Location** | City, state, or zip. Geocoded client-side via Nominatim. |
| **Rain Risk Tolerance** | Max acceptable precipitation probability (0–90%). |
| **Heat Ceiling** | Flag days above this temp (°F). Penalizes the trip score. |
| **Forecast Horizon** | 5, 7, or 10 days. |
| **Departure Day** | Which day you're leaving. Scoring window starts here. |
| **Search Radius** | Distance from your origin in miles (50–500). |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_PATH` | Yes (set by Compose) | Path to the SQLite file inside the container |
| `RIDB_API_KEY` | No | Free key from [recreation.gov](https://ridb.recreation.gov/docs). Enables federal campground ingestion (~3,500 facilities). App works without it. |

---

## Project Structure

```
app/
  __init__.py     Flask app factory, calls db.init_db()
  routes.py       / and /api/forecast endpoints
  db.py           SQLite layer — campgrounds, forecasts, api_log tables
  weather.py      Open-Meteo fetching, scoring, on-demand refresh
  ingest.py       Campground ingestion — curated YAML, RIDB, Overpass
  jobs.py         Scheduler entrypoint (python -m app.jobs)
  destinations.py Loads destinations.yml (curated fallback)
  templates/      Jinja2 HTML
static/
  app.js          All client-side logic — geocoding, rendering, sliders
  style.css       Bureau Bulletin design system
destinations.yml  50 curated campgrounds (OH/KY/IN) — always present
docker-compose.yml  web + scheduler services, shared db_data volume
deploy/           Nginx config for travel.henzi.org
```

---

## Data Sources

- **[RIDB](https://ridb.recreation.gov)** — Recreation.gov federal facilities. National Forests, BLM, NPS. Free API key. ~3,500 campgrounds.
- **[Overpass API](https://overpass-api.de)** — OpenStreetMap `tourism=camp_site` nodes. Covers state parks, private campgrounds, everything else. No key. ~20,000–50,000 nodes.
- **[Open-Meteo](https://open-meteo.com)** — Free weather API, no key. 10-day forecasts, batch up to 300 locations per request.
- **Curated YAML** — 50 hand-picked campgrounds in the Ohio/Kentucky/Indiana area. Always present as a seed and fallback.

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full plan. Short version:

| Version | What ships |
|---|---|
| v1 | Live at `travel.henzi.org`, configurable origin |
| **v2** | **← current** — SQLite DB, pre-cached forecasts, radius slider, any US user |
| v3 | Saved favorites in `localStorage` |
| v4 | Shareable URLs |
| v5 | Mobile card view |
