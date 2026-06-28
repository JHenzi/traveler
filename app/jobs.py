"""
Standalone scheduler process — run as: python -m app.jobs

Timeline:
  startup  → ingest campgrounds (YAML + RIDB + Overpass) + fetch all forecasts
  every 6h → refresh forecasts for all campgrounds
  every 24h → re-run campground ingestion (picks up new parks)
"""
import logging
import time

log = logging.getLogger(__name__)

FORECAST_INTERVAL = 6 * 60 * 60   # 6 hours
INGEST_INTERVAL   = 24 * 60 * 60  # 24 hours


def _ingest():
    from . import ingest
    ingest.run_full_ingestion()


def _refresh():
    from .weather import refresh_campground_forecasts
    refresh_campground_forecasts(horizon=10)

    # Also keep the legacy forecast_cache warm for the YAML fallback path
    from .destinations import load_destinations
    from .weather import fetch_forecasts
    destinations = load_destinations()
    for h in [5, 7, 10]:
        try:
            fetch_forecasts(destinations, horizon=h, force=True)
        except Exception as exc:
            log.error('Legacy cache refresh failed horizon=%d: %s', h, exc)


def run():
    from . import db
    db.init_db()

    log.info('Scheduler started')
    _ingest()
    _refresh()

    last_ingest = time.time()

    while True:
        time.sleep(FORECAST_INTERVAL)
        log.info('Scheduled forecast refresh starting')
        _refresh()

        if time.time() - last_ingest >= INGEST_INTERVAL:
            log.info('Scheduled campground ingestion starting')
            _ingest()
            last_ingest = time.time()


if __name__ == '__main__':
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [scheduler] %(levelname)s %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S',
    )
    run()
