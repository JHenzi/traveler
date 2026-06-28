"""
Standalone scheduler process.
Run as: python -m app.jobs
Refreshes all forecast horizons every 6 hours and writes to the shared SQLite DB.
The web workers only read — they never call Open-Meteo directly.
"""
import logging
import time

log = logging.getLogger(__name__)

REFRESH_INTERVAL = 6 * 60 * 60  # 6 hours
HORIZONS = [5, 7, 10]


def refresh_all():
    from .destinations import load_destinations
    from .weather import fetch_forecasts
    destinations = load_destinations()
    for h in HORIZONS:
        try:
            fetch_forecasts(destinations, horizon=h, force=True)
            log.info('Refreshed horizon=%d for %d destinations', h, len(destinations))
        except Exception as exc:
            log.error('Refresh failed horizon=%d: %s', h, exc)


def run():
    from . import db
    db.init_db()
    log.info('Scheduler started — initial refresh')
    refresh_all()
    while True:
        log.info('Sleeping %dh until next refresh', REFRESH_INTERVAL // 3600)
        time.sleep(REFRESH_INTERVAL)
        log.info('Scheduled refresh starting')
        refresh_all()


if __name__ == '__main__':
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [scheduler] %(levelname)s %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S',
    )
    run()
