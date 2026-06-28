"""
Campground ingestion from three sources:
  1. curated   — destinations.yml (always present, seeds on startup)
  2. ridb      — Recreation.gov federal lands (requires RIDB_API_KEY env var)
  3. overpass  — OpenStreetMap camp_sites, US coverage by region

Run via jobs.py on startup and then daily.
"""
import logging
import math
import os
import time

import requests

from . import db
from .destinations import load_destinations

log = logging.getLogger(__name__)

RIDB_BASE = 'https://ridb.recreation.gov/api/v1'
OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

US_STATES = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
    'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
    'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
    'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]

# Nine bounding boxes covering the contiguous US + AK + HI
OVERPASS_REGIONS = [
    ('NW',  43, 49, -125, -110),
    ('NC',  43, 49, -110,  -95),
    ('NE',  40, 49,  -95,  -67),
    ('W',   32, 43, -125, -110),
    ('C',   32, 43, -110,  -95),
    ('E',   32, 43,  -95,  -77),
    ('SW',  25, 32, -117, -100),
    ('S',   25, 32, -100,  -83),
    ('SE',  25, 32,  -83,  -67),
    ('AK',  51, 72, -170, -130),
    ('HI',  18, 23, -161, -154),
]


# ── 1. CURATED ───────────────────────────────────────────────────────────────

def seed_curated():
    destinations = load_destinations()
    records = [{'name': d['name'], 'lat': d['lat'], 'lon': d['lon'], 'source': 'curated'}
               for d in destinations]
    db.upsert_campgrounds(records)
    log.info('Seeded %d curated campgrounds', len(records))


# ── 2. RIDB ──────────────────────────────────────────────────────────────────

def ingest_ridb():
    api_key = os.environ.get('RIDB_API_KEY')
    if not api_key:
        log.info('RIDB_API_KEY not set — skipping RIDB ingestion')
        return

    total = 0
    for state in US_STATES:
        try:
            records = _fetch_ridb_state(state, api_key)
            if records:
                db.upsert_campgrounds(records)
                total += len(records)
            time.sleep(0.25)  # be polite to RIDB
        except Exception as exc:
            log.warning('RIDB state %s failed: %s', state, exc)

    log.info('RIDB ingestion complete — %d campgrounds upserted', total)


def _fetch_ridb_state(state, api_key):
    params = {
        'activity': 'CAMPING',
        'state':    state,
        'apikey':   api_key,
        'limit':    500,
        'offset':   0,
    }
    records = []
    while True:
        resp = requests.get(f'{RIDB_BASE}/facilities', params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        facilities = data.get('RECDATA', [])
        for f in facilities:
            lat = f.get('FacilityLatitude')
            lon = f.get('FacilityLongitude')
            name = f.get('FacilityName', '').strip().title()
            if not lat or not lon or not name or lat == 0.0:
                continue
            records.append({
                'name':   name,
                'lat':    float(lat),
                'lon':    float(lon),
                'source': 'ridb',
                'state':  state,
                'url':    f'https://www.recreation.gov/camping/campgrounds/{f.get("FacilityID", "")}',
            })
        if len(facilities) < params['limit']:
            break
        params['offset'] += params['limit']
    return records


# ── 3. OVERPASS ──────────────────────────────────────────────────────────────

def ingest_overpass():
    total = 0
    for label, s, n, w, e in OVERPASS_REGIONS:
        try:
            records = _fetch_overpass_region(s, n, w, e)
            if records:
                db.upsert_campgrounds(records)
                total += len(records)
            time.sleep(2)  # Overpass asks for a pause between requests
        except Exception as exc:
            log.warning('Overpass region %s failed: %s', label, exc)

    log.info('Overpass ingestion complete — %d campgrounds upserted', total)


def _fetch_overpass_region(south, north, west, east):
    query = f'''
    [out:json][timeout:60];
    (
      node["tourism"="camp_site"]["name"]({south},{west},{north},{east});
      way["tourism"="camp_site"]["name"]({south},{west},{north},{east});
    );
    out center;
    '''
    resp = requests.post(OVERPASS_URL, data={'data': query}, timeout=90)
    resp.raise_for_status()
    elements = resp.json().get('elements', [])

    records = []
    for el in elements:
        name = el.get('tags', {}).get('name', '').strip()
        if not name:
            continue
        if el['type'] == 'node':
            lat, lon = el.get('lat'), el.get('lon')
        else:
            center = el.get('center', {})
            lat, lon = center.get('lat'), center.get('lon')
        if lat is None or lon is None:
            continue
        records.append({'name': name, 'lat': lat, 'lon': lon, 'source': 'overpass'})
    return records


# ── ORCHESTRATOR ─────────────────────────────────────────────────────────────

def run_full_ingestion():
    log.info('Starting campground ingestion')
    seed_curated()
    ingest_ridb()
    ingest_overpass()
    log.info('Ingestion complete — %d total campgrounds in DB', db.campground_count())
