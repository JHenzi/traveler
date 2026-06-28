# Weather Horizon Route Planner — Vision & Roadmap

## What It Is (And Why It's Different)

Every weather app answers the wrong question. They ask "what's the weather at X?" when what you actually want to know is "where should I go?"

This app flips the paradigm. Give it your tolerance for rain and heat, tell it when you want to leave, and it tells you **which direction to drive** and **exactly which campground wins**. It scores destinations algorithmically — consecutive dry days, departure-window rain probability, heat penalty — and surfaces a ranked Top 3 with a single API call, no key required.

The destination list is already remarkable: 50+ real campgrounds across OH, KY, and IN, organized by cardinal direction from Cincinnati, covering everything from Hocking Hills to Red River Gorge to Mammoth Cave. The radar chart showing dry-window scores by direction is genuinely beautiful data. The grid view is what a seasoned camper's whiteboard looks like — every site, every day, color-coded at a glance.

**The core insight — "where is dry?" instead of "is here dry?" — is the whole product.** Most people don't have it. This does.

---

## The Gap Between Here and Proud-of-It

### 1. It's Hardcoded to Cincinnati
The app is excellent for one person. To be useful to anyone else, the origin needs to be an input, and the destination list needs to match their geography. That's the unlock.

### 2. The Destination List Is Manual
The YAML is lovingly curated but requires someone (you) to maintain it. New parks don't appear. Parks you've never heard of don't appear. A user in Denver gets nothing.

### 3. No Setup Path for Strangers
Right now: clone the repo, run Docker, open localhost. That's fine for a developer. It's a hard stop for a camper.

---

## The Dream: One Address → Full Trip Planner

### What the Ideal Flow Looks Like

```
Enter your address or zip code: [                    ]
Search radius: [──●────────] 200 miles
[Find Campgrounds & Check Weather →]
```

The app geocodes the address, queries a parks API for campgrounds within the radius, fetches batch weather for all of them, runs the dry-window algorithm, and returns a ranked grid — all in one shot. No YAML to edit. Works for anyone, anywhere in the US.

---

## Roadmap

### Phase 1 — Polish What Exists (1–2 weekends)
Make the current app genuinely shippable as a demo for Midwest campers.

- [ ] Make the origin configurable in the UI (input field, not hardcoded sidebar note)
- [ ] Geocode the origin with Nominatim (free, no key) so users can type a city or zip
- [ ] Add a "Camping Score" legend explaining the 0–100 score formula
- [ ] README with one-command Docker setup (`docker compose up`)
- [ ] Deploy to Fly.io or Railway (free tier, ~5 min setup) — give it a real URL

**Outcome:** A link you can share. People from Cincinnati can actually use it today.

---

### Phase 2 — Auto-Discover Parks from an Address (the big one)

Replace or supplement the hardcoded YAML with live park discovery.

**Option A: Recreation.gov / RIDB API**
- Free API (requires key, but instant approval)
- Returns federal campgrounds: National Forest, NPS, BLM — the good stuff
- Query: `GET /api/facilities?activity=9&latitude=X&longitude=Y&radius=200`
- Returns name, lat/lon, facility type, reservable sites

**Option B: Overpass API (OpenStreetMap)**
- Truly free, no key, incredible coverage
- Query campgrounds tagged `tourism=camp_site` within a bounding box
- Returns everything from primitive sites to RV parks
- Slower but comprehensive

**Option C: Both**
- RIDB for federal lands (authoritative, has reservation links)
- Overpass as fallback/supplement for state parks and private sites

**Implementation sketch:**
```python
def discover_campgrounds(lat, lon, radius_miles):
    # 1. Query RIDB API for federal campgrounds
    # 2. Query Overpass for OSM camp_sites
    # 3. Merge, deduplicate by proximity
    # 4. Assign direction (bearing from origin)
    # 5. Return as destinations list (same schema as YAML)
```

The rest of the app — `build_grid`, `build_top3`, weather fetching — doesn't change at all. That's how clean the architecture is.

---

### Phase 3 — Make It Yours (Saved Favorites)

- Save favorite destinations to browser localStorage (no backend needed)
- "My List" tab shows only your curated spots + their weather
- Optional: export/import your list as a YAML file (same format as `destinations.yml`)

---

### Phase 4 — Share a Trip

- Shareable URL encodes origin + settings: `/?lat=39.10&lon=-84.51&radius=200&threshold=30`
- Anyone with the link sees your exact view
- Simple "Copy Link" button

---

### Phase 5 — Mobile-First UI

The grid is dense and data-rich — great on desktop, tight on mobile. A "card view" mode for phones where each destination gets a compact weather card would make this usable on the trail, not just at the desk.

---

## The Pitch (If You Ever Wanted One)

> **Weather Horizon** is a trip planner for people who camp based on weather, not dates. Enter your zip code, set how much rain you'll tolerate, and it finds every campground within driving distance and ranks them by how dry the next week looks. No ads. No subscriptions. No API key. Just open it and go.

---

## What Makes It Special (Don't Lose These)

- **The dry-window algorithm** is the core IP. It's simple but nobody does it.
- **Pre-cached weather for every campground** — forecasts are refreshed on a schedule, not fetched per user. Any traffic level hits the same DB reads.
- **The trip score** (rain penalty + heat penalty weighted by day) is genuinely sophisticated for what looks like a simple slider UI.
- **No auth, no API key for users** — zero friction to open and use.
- **The radar chart** showing dry windows by direction is a visual that no weather app has.

---

## Architecture at Scale

The naive approach fetches weather on demand per user request. That breaks at scale: N users × M campgrounds = unbounded API calls.

The right approach inverts the data flow:

```
Background job (every 6h):
  RIDB + Overpass → campgrounds table (SQLite)
  Open-Meteo batch → forecasts table (SQLite)

User request (hot path):
  zip → Nominatim geocode → filter campgrounds from DB → score from cached forecasts → return
  (zero external API calls)
```

**Database size:** 10,000 campgrounds × 7-day forecasts ≈ 7MB. Even 50,000 campgrounds fits in ~35MB. SQLite handles this with WAL mode for concurrent Gunicorn workers.

**Open-Meteo cost at scale:** ~34–170 batch requests per 6-hour refresh cycle. Fixed cost, independent of user traffic. Free tier is fine even at high volume.

**Scaling path when traffic grows:**
- SQLite + WAL → handles thousands of concurrent readers, no changes needed until very high traffic
- Add Redis → cache scored results per (geohash + settings), 30-min TTL, reduces DB reads further
- Swap SQLite → PostgreSQL → same schema, same queries, multi-server deployable
- The scoring logic (`calc_dry_window`, `calc_trip_score`, `build_grid`) is stateless Python — scales horizontally without any changes

---

## Immediate Next Step

**Wire up the DB layer.** Add `db.py` (SQLite schema + WAL mode), `jobs.py` (background refresh), and `ingest.py` (load `destinations.yml` into the DB for v1). Then swap the route handlers to read from the DB instead of calling Open-Meteo live. The scoring logic doesn't change at all.

v1 uses only the curated YAML entries. v2 adds RIDB + Overpass ingestion. The architecture is the same either way — that's the point.
