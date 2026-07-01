(function () {
  /* ── ELEMENTS ── */
  const thresholdInput  = document.getElementById('threshold');
  const thresholdVal    = document.getElementById('threshold-val');
  const tempInput       = document.getElementById('temp-threshold');
  const tempVal         = document.getElementById('temp-threshold-val');
  const radiusInput     = document.getElementById('radius');
  const radiusVal       = document.getElementById('radius-val');
  const horizonBtns     = document.querySelectorAll('.bur-horizon-btn');
  const departGrid      = document.getElementById('depart-btns');
  const picksContainer  = document.getElementById('picks-container');
  const verdictLine     = document.getElementById('verdict-line');
  const tripPlanWrap    = document.getElementById('trip-plan-wrap');
  const gridContainer   = document.getElementById('grid-container');
  const radarContainer  = document.getElementById('radar-container');
  const refreshBtn      = document.getElementById('refresh-btn');
  const lastUpdatedEl   = document.getElementById('last-updated');
  const lastUpdatedFt   = document.getElementById('last-updated-footer');
  const stationCount    = document.getElementById('station-count');
  const tickerText      = document.getElementById('ticker-text');
  const fetchingBanner  = document.getElementById('fetching-banner');
  const locationInput   = document.getElementById('location-input');
  const locationBtn     = document.getElementById('location-btn');
  const locationStatus  = document.getElementById('location-status');
  const headerStation   = document.getElementById('header-station');

  const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const COMPASS = [
    { label: 'N',  match: ['north'] },
    { label: 'NE', match: ['northeast', 'ne'] },
    { label: 'E',  match: ['east'] },
    { label: 'SE', match: ['southeast', 'se'] },
    { label: 'S',  match: ['south'] },
    { label: 'SW', match: ['southwest', 'sw'] },
    { label: 'W',  match: ['west'] },
    { label: 'NW', match: ['northwest', 'nw'] },
  ];

  /* ── STATE ── */
  let forecastDates = [];
  let currentRows   = [];
  let focusName     = null;
  let debounceTimer  = null;
  let fetchingTimer  = null;

  // Seed state from server-rendered __INIT__ (supports shareable URLs)
  const _I = window.__INIT__ || {};
  let originLat   = _I.lat       || 39.1031;
  let originLon   = _I.lon       || -84.5120;
  let originLabel = _I.origin    || 'Cincinnati, OH';
  let horizon     = _I.horizon   || parseInt(document.querySelector('.bur-horizon-btn.active')?.dataset.val || '7', 10);
  let departIdx   = (_I.dep != null ? _I.dep : parseInt(document.querySelector('.bur-depart-btn.active')?.dataset.day || '2', 10)) - 1;
  let radius      = _I.radius    || parseInt(radiusInput?.value || '150', 10);

  // Apply any URL-seeded slider values
  if (_I.threshold  && thresholdInput) thresholdInput.value = _I.threshold;
  if (_I.temp       && tempInput)       tempInput.value      = _I.temp;
  if (_I.radius     && radiusInput)     radiusInput.value    = _I.radius;
  if (_I.threshold  && thresholdVal)    thresholdVal.textContent  = _I.threshold + '%';
  if (_I.temp       && tempVal)         tempVal.textContent        = _I.temp + '°F';
  if (_I.radius     && radiusVal)       radiusVal.textContent      = _I.radius + ' mi';

  /* ── HELPERS ── */
  function dayName(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return SHORT_DAYS[new Date(y, m - 1, d).getDay()];
  }

  function dateShort(dateStr) {
    return dateStr.slice(5); // "MM-DD"
  }

  function getThreshold() { return parseInt(thresholdInput.value, 10); }
  function getTempThreshold() { return parseInt(tempInput.value, 10); }

  function computeScore(days, depIdx, threshold, tempThreshold) {
    if (depIdx >= days.length) return null;
    if (days[depIdx].precip_prob > threshold) return null;
    const win = days.slice(depIdx, depIdx + 3);
    const d0 = win[0] ? win[0].precip_prob : 0;
    const d1 = win[1] ? win[1].precip_prob : 0;
    const d2 = win[2] ? win[2].precip_prob : 0;
    const rain = d0 * 0.50 + d1 * 0.35 + d2 * 0.15;
    const heat = win.slice(0, 3).reduce((s, day, j) =>
      s + Math.max(0, day.temp_max - tempThreshold) * [0.50, 0.35, 0.15][j] * 1.2, 0);
    return Math.max(0, +(100 - rain - heat).toFixed(1));
  }

  function dryWindowFrom(days, startIdx, threshold) {
    let count = 0;
    for (let i = startIdx; i < days.length; i++) {
      if (days[i] && days[i].precip_prob <= threshold) count++;
      else break;
    }
    return count;
  }

  function scoreClass(score) {
    if (score === null) return 'bur-score--none';
    if (score >= 85) return 'bur-score--good';
    if (score >= 72) return 'bur-score--mid';
    return 'bur-score--low';
  }

  function dryClass(n) {
    if (n >= 5) return 'bur-dry--good';
    if (n >= 3) return 'bur-dry--ok';
    return 'bur-dry--bad';
  }

  function verdictLabel(row, threshold) {
    const w = row.dry_window;
    const avg = row.days.length
      ? Math.round(row.days.reduce((s, d) => s + d.precip_prob, 0) / row.days.length)
      : 50;
    if (w >= 5) return ['CLEAR — EXTENDED DRY WINDOW CONFIRMED.', 'bur-trip-verdict'];
    if (w >= 3) return ['MARGINAL — DRY EARLY, WATCH LATTER DAYS.', 'bur-trip-verdict bur-trip-verdict--marginal'];
    if (avg > 50) return ['WET — ADVISE RAIN CONTINGENCY.', 'bur-trip-verdict bur-trip-verdict--wet'];
    return ['VARIABLE — ROUTE WITH FLEXIBILITY.', 'bur-trip-verdict bur-trip-verdict--marginal'];
  }

  /* ── LOCATION / GEOCODING ── */
  function geocodeLocation(query) {
    if (locationStatus) locationStatus.textContent = 'Looking up…';
    if (locationBtn)    locationBtn.disabled = true;
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query);
    fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'WeatherHorizonApp/1.0' } })
      .then(r => r.json())
      .then(results => {
        if (!results || results.length === 0) {
          if (locationStatus) locationStatus.textContent = 'Location not found. Try again.';
          if (locationBtn) locationBtn.disabled = false;
          return;
        }
        const r = results[0];
        originLat   = parseFloat(r.lat);
        originLon   = parseFloat(r.lon);
        originLabel = r.display_name.split(',').slice(0, 2).join(',').trim();
        if (locationStatus) locationStatus.textContent = 'Showing camps near: ' + originLabel;
        if (headerStation) headerStation.textContent = originLabel.toUpperCase();
        if (locationBtn) locationBtn.disabled = false;
        refresh(false);
      })
      .catch(() => {
        if (locationStatus) locationStatus.textContent = 'Geocode failed. Check your connection.';
        if (locationBtn) locationBtn.disabled = false;
      });
  }

  /* ── DEPARTURE BUTTONS ── */
  function renderDepartBtns() {
    if (!departGrid) return;
    const today = new Date();
    departGrid.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const dow = SHORT_DAYS[d.getDay()];
      const md  = (d.getMonth() + 1) + '/' + d.getDate();
      const btn = document.createElement('button');
      btn.className = 'bur-depart-btn' + (i === departIdx ? ' active' : '');
      btn.dataset.idx = i;
      btn.innerHTML = `<span class="bur-depart-dow">${dow}</span><span class="bur-depart-md">${md}</span>`;
      btn.addEventListener('click', () => {
        departIdx = i;
        document.querySelectorAll('.bur-depart-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        refresh(false);
        syncUrl();
      });
      departGrid.appendChild(btn);
    }
  }

  /* ── TICKER ── */
  function renderTicker(rows, top3) {
    if (!rows || rows.length === 0) return;
    const threshold = getThreshold();
    const wet = rows.filter(r => {
      const avg = r.days.reduce((s, d) => s + d.precip_prob, 0) / (r.days.length || 1);
      return avg > 55;
    }).length;
    const top = top3 && top3[0];
    const topDry = top ? dryWindowFrom(top.days, departIdx, threshold) : 0;
    const parts = [
      wet + ' CAMPS SHOW RAIN RISK',
      top ? 'BEST DIRECTION: ' + top.direction.toUpperCase() : '',
      top ? top.name.toUpperCase() + ' — ' + topDry + ' DRY DAYS FROM DEPARTURE' : '',
    ].filter(Boolean);
    if (tickerText) tickerText.textContent = parts.join(' · ');
  }

  /* ── VERDICT LINE ── */
  function renderVerdict(top3) {
    if (!verdictLine) return;
    if (!top3 || top3.length === 0) {
      verdictLine.textContent = 'No qualifying routes for current parameters.';
      return;
    }
    const top = top3[0];
    const topDry = dryWindowFrom(top.days, departIdx, getThreshold());
    verdictLine.textContent =
      'ROUTE ' + top.direction.toUpperCase() +
      ' — ' + top.name +
      ' HOLDS ' + topDry + ' DRY DAYS.';
  }

  /* ── PICK CARDS (Priority Dispatch) ── */
  function renderPicks(top3) {
    if (!picksContainer) return;
    if (!top3 || top3.length === 0) {
      picksContainer.innerHTML =
        '<div class="bur-picks-empty">NO QUALIFYING ROUTES FOR CURRENT PARAMETERS. ' +
        'RAISE RAIN TOLERANCE OR SELECT A DIFFERENT DEPARTURE DAY.</div>';
      return;
    }
    const threshold = getThreshold();
    const tempThreshold = getTempThreshold();

    const cards = top3.map((rec, i) => {
      const isTop = i === 0;
      const label = 'A-' + (i + 1);
      const score = rec.score !== undefined ? rec.score
        : (computeScore(rec.days, departIdx, threshold, tempThreshold) || '—');
      const dryFromDep = dryWindowFrom(rec.days, departIdx, threshold);
      // heat warning: any day in 3-day departure window exceeds ceiling
      const win3 = rec.days.slice(departIdx, departIdx + 3);
      const hasHeat = win3.some(d => d && d.temp_max > tempThreshold);
      const heatBadge = hasHeat
        ? `<span class="bur-pick-heat-badge">&#9650; HEAT WARNING</span>` : '';
      return `<button class="bur-pick-card${isTop ? ' bur-pick-card--top' : ''}" data-name="${esc(rec.name)}">
        <div class="bur-pick-tag">
          <span>${label}</span>
          <span class="bur-pick-tag-dir">${rec.direction.toUpperCase()}</span>
        </div>
        <div class="bur-pick-body">
          <div class="bur-pick-name">${esc(rec.name)}</div>
          ${heatBadge}
          <div class="bur-pick-foot">
            <div>
              <span class="bur-pick-score">${typeof score === 'number' ? score.toFixed(1) : score}</span>
              <span class="bur-pick-score-denom">/100</span>
            </div>
            <div class="bur-pick-meta">
              <div>${dryFromDep}D DRY</div>
            </div>
          </div>
        </div>
      </button>`;
    }).join('');

    picksContainer.innerHTML = `<div class="bur-picks">${cards}</div>`;
    picksContainer.querySelectorAll('.bur-pick-card').forEach(btn => {
      btn.addEventListener('click', () => setFocus(btn.dataset.name));
    });
  }

  /* ── PARK FORECAST ── */
  function renderTripPlan(rows) {
    if (!tripPlanWrap) return;
    if (!focusName || !rows || rows.length === 0) {
      tripPlanWrap.innerHTML = `<div class="bur-trip-plan bur-trip-plan--empty">
        <div class="bur-trip-empty-msg">&#9654; Click any row in the table below to see its full forecast here.</div>
      </div>`;
      return;
    }
    const threshold    = getThreshold();
    const tempThresh   = getTempThreshold();
    const row = rows.find(r => r.name === focusName);
    if (!row) return;

    const depIdx = departIdx;
    const days   = row.days;

    // find best start (longest consecutive dry window)
    let bestStart = 0, bestLen = 0, cur = 0, curStart = 0;
    days.forEach((d, i) => {
      if (d.precip_prob <= threshold) {
        if (cur === 0) curStart = i;
        cur++;
        if (cur > bestLen) { bestLen = cur; bestStart = curStart; }
      } else { cur = 0; }
    });

    const dayCells = days.map((day, i) => {
      const dry   = day.precip_prob <= threshold;
      const hot   = day.temp_max > tempThresh;
      const inWin = i >= bestStart && i < bestStart + bestLen;
      const dow   = forecastDates[i] ? dayName(forecastDates[i]) : ('D' + (i + 1));
      const md    = forecastDates[i] ? dateShort(forecastDates[i]) : '';
      let cls = 'bur-trip-day';
      if (inWin) cls += ' bur-trip-day--win';
      if (hot)   cls += ' bur-trip-day--hot';
      return `<div class="${cls}">
        <div class="bur-trip-day-dow">${dow.toUpperCase()}</div>
        <div class="bur-trip-day-md">${md}</div>
        <div class="bur-trip-day-temp">${Math.round(day.temp_max)}°${hot ? '<span class="bur-heat-tag">HEAT</span>' : ''}</div>
        <div class="bur-trip-day-rain${dry ? '' : ' bur-trip-day-rain--wet'}">${day.precip_prob}%</div>
        <div class="bur-trip-day-code">${day.emoji || ''}</div>
      </div>`;
    }).join('');

    const [vText, vClass] = verdictLabel(row, threshold);
    const winStart = forecastDates[bestStart]
      ? dayName(forecastDates[bestStart]) + ' ' + dateShort(forecastDates[bestStart]) : '—';

    tripPlanWrap.innerHTML = `
      <div class="bur-trip-plan">
        <div class="bur-trip-plan-hdr">
          <div class="bur-trip-plan-name">
            <span class="bur-trip-plan-label">Park Forecast — </span>
            <span class="bur-trip-plan-dest">${esc(row.name)}</span>
          </div>
          <div class="bur-trip-plan-meta">${row.direction.toUpperCase()}</div>
        </div>
        <div class="bur-trip-days">${dayCells}</div>
        <div class="bur-trip-footer">
          <span class="${vClass}">${vText}</span>
          <span class="bur-trip-window-meta">
            BEST WINDOW ${winStart} · ${bestLen}D · AVG RAIN ${Math.round(days.reduce((s,d)=>s+d.precip_prob,0)/days.length)}%
          </span>
        </div>
      </div>`;
  }

  /* ── TABLE (Station Data Sheet) ── */
  function renderTable(rows) {
    if (!gridContainer) return;
    if (!rows || rows.length === 0) {
      gridContainer.innerHTML = '<p style="padding:16px;color:var(--soft);font-size:11px;">No forecast data available.</p>';
      return;
    }
    const threshold   = getThreshold();
    const tempThresh  = getTempThreshold();

    // compute scores and re-rank
    const scored = rows.map(row => ({
      ...row,
      computedScore: computeScore(row.days, departIdx, threshold, tempThresh),
    }));
    scored.sort((a, b) => {
      if (b.computedScore === null && a.computedScore === null) return b.dry_window - a.dry_window;
      if (b.computedScore === null) return -1;
      if (a.computedScore === null) return 1;
      return b.computedScore - a.computedScore;
    });

    const sampleDays = rows[0].days;
    const dayThs = sampleDays.map((d, i) => {
      const dow = forecastDates[i] ? dayName(forecastDates[i]) : ('D' + (i + 1));
      const md  = forecastDates[i] ? dateShort(forecastDates[i]) : '';
      return `<th class="col-day bur-table-th">
        <span class="bur-th-day-dow">${dow.toUpperCase()}</span>
        <span class="bur-th-day-md">${md}</span>
      </th>`;
    }).join('');

    const bodyRows = scored.map((row, ri) => {
      const isTop  = ri < 3 && row.computedScore !== null;
      const sel    = row.name === focusName;
      const dayCells = row.days.map((day, i) => {
        const dry = day.precip_prob <= threshold;
        const hot = day.temp_max > tempThresh;
        let cls = 'col-day';
        if (hot)       cls += ' col-day--hot';
        else if (dry)  cls += ' col-day--dry';
        else           cls += ' col-day--wet';
        const heatTag = hot ? '<div class="bur-cell-heat-tag">HEAT</div>' : '';
        return `<td class="${cls}">
          <div class="bur-cell-temp">${Math.round(day.temp_max)}°</div>
          ${heatTag}
          <div class="bur-cell-rain${dry ? '' : ' bur-cell-rain--wet'}">${day.precip_prob}%</div>
        </td>`;
      }).join('');

      const scoreDisp = row.computedScore !== null
        ? `<span class="${scoreClass(row.computedScore)}">${row.computedScore.toFixed(1)}</span>`
        : `<span class="bur-score--none">—</span>`;

      const dist = row.distance_mi != null ? row.distance_mi + 'mi' : '—';
      return `<tr class="${sel ? 'bur-row--focused' : ''}" data-name="${esc(row.name)}">
        <td class="col-rank ${isTop ? 'col-rank--top' : ''}">${ri + 1}</td>
        <td class="col-name">${esc(row.name)}</td>
        <td class="col-dir">${row.direction.toUpperCase()}</td>
        <td class="col-center col-dist">${dist}</td>
        ${dayCells}
        <td class="col-dry ${dryClass(row.dry_window)}">${row.dry_window}D</td>
        <td class="col-score">${scoreDisp}</td>
      </tr>`;
    }).join('');

    const mobileCards = scored.map((row, ri) => {
      const isTop = ri < 3 && row.computedScore !== null;
      const sel   = row.name === focusName;
      const scoreDisp = row.computedScore !== null
        ? `<span class="${scoreClass(row.computedScore)}">${row.computedScore.toFixed(1)}</span>`
        : `<span class="bur-score--none">—</span>`;
      const dist = row.distance_mi != null ? row.distance_mi + 'mi' : '—';
      const dayPills = row.days.map((day, i) => {
        const dry = day.precip_prob <= threshold;
        const hot = day.temp_max > tempThresh;
        const dow = forecastDates[i] ? dayName(forecastDates[i]) : ('D' + (i + 1));
        const md  = forecastDates[i] ? dateShort(forecastDates[i]) : '';
        let cls = 'bur-mday';
        if (hot) cls += ' bur-mday--hot';
        else if (dry) cls += ' bur-mday--dry';
        else cls += ' bur-mday--wet';
        return `<div class="${cls}">
          <div class="bur-mday-dow">${dow.toUpperCase()}</div>
          <div class="bur-mday-date">${md}</div>
          <div class="bur-mday-temp${hot ? ' bur-mday-temp--hot' : ''}">${Math.round(day.temp_max)}°</div>
          <div class="bur-mday-rain${dry ? '' : ' bur-mday-rain--wet'}">${day.precip_prob}%</div>
        </div>`;
      }).join('');
      return `<div class="bur-mcard${sel ? ' bur-mcard--focused' : ''}" data-name="${esc(row.name)}">
        <div class="bur-mcard-top">
          <span class="bur-mcard-rank${isTop ? ' bur-mcard-rank--top' : ''}">${ri + 1}</span>
          <span class="bur-mcard-name">${esc(row.name)}</span>
          <span class="bur-mcard-score">${scoreDisp}</span>
        </div>
        <div class="bur-mcard-meta">${row.direction.toUpperCase()} · ${dist} · ${row.dry_window}D DRY</div>
        <div class="bur-mcard-days bur-scroll">${dayPills}</div>
      </div>`;
    }).join('');

    const minW = Math.max(700, 430 + sampleDays.length * 60);
    gridContainer.innerHTML = `
      <table class="bur-table" style="min-width:${minW}px;">
        <thead>
          <tr>
            <th class="col-rank">#</th>
            <th>Station</th>
            <th>Bearing</th>
            <th class="col-center">Dist</th>
            ${dayThs}
            <th class="col-center">Dry</th>
            <th class="col-right">Index</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
      <div class="bur-mobile-list">${mobileCards}</div>`;

    gridContainer.querySelectorAll('tbody tr, .bur-mcard').forEach(el => {
      el.addEventListener('click', () => setFocus(el.dataset.name));
    });
  }

  /* ── SVG RADAR ── */
  function renderRadar(rows) {
    if (!radarContainer) return;

    const threshold  = getThreshold();
    const tempThresh = getTempThreshold();
    const dirMap = {};
    (rows || []).forEach(row => {
      const key   = row.direction.toLowerCase();
      const score = computeScore(row.days, departIdx, threshold, tempThresh);
      if (score === null) return;
      COMPASS.forEach(c => {
        if (c.match.includes(key)) {
          if (dirMap[c.label] === undefined || score > dirMap[c.label]) {
            dirMap[c.label] = score;
          }
        }
      });
    });

    const values = COMPASS.map(c => dirMap[c.label] || 0);
    const cx = 140, cy = 128, R = 92;
    const ang = i => (i * 45) * Math.PI / 180;
    const pt  = (i, r) => [cx + r * Math.sin(ang(i)), cy - r * Math.cos(ang(i))];

    const poly = values.map((v, i) => pt(i, R * (v / 100)).join(',')).join(' ');

    // concentric reference rings
    const rings = [0.33, 0.66].map((f, k) => {
      const pts = COMPASS.map((_, i) => pt(i, R * f).join(',')).join(' ');
      return `<polygon points="${pts}" fill="none" stroke="#3a5a78" stroke-width="0.6" opacity="0.4"/>`;
    }).join('');

    // outer octagon
    const outerPts = COMPASS.map((_, i) => pt(i, R).join(',')).join(' ');

    // spoke lines
    const spokes = COMPASS.map((_, i) => {
      const [x, y] = pt(i, R);
      return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#3a5a78" stroke-width="0.5" opacity="0.35"/>`;
    }).join('');

    // data polygon
    const dataDots = values.map((v, i) => {
      const [x, y] = pt(i, R * (v / 100));
      return `<rect x="${x - 2}" y="${y - 2}" width="4" height="4" fill="#b2402c"/>`;
    }).join('');

    // direction labels
    const labels = COMPASS.map((c, i) => {
      const [x, y] = pt(i, R + 14);
      return `<text x="${x}" y="${y + 3.5}" text-anchor="middle" font-family="Oswald,sans-serif" font-size="11" font-weight="600" fill="#23211c">${c.label}</text>`;
    }).join('');

    // best direction
    const bestIdx = values.indexOf(Math.max(...values));
    const bestDir = COMPASS[bestIdx].label;

    radarContainer.innerHTML = `
      <svg viewBox="0 0 280 268">
        <circle cx="${cx}" cy="${cy}" r="${R}" fill="#eef0e6" stroke="#23211c" stroke-width="1.4"/>
        ${rings}
        ${spokes}
        <polygon points="${poly}" fill="#2f6b4f" fill-opacity="0.18" stroke="#2f6b4f" stroke-width="1.8" stroke-linejoin="round"/>
        ${dataDots}
        ${labels}
      </svg>
      <div class="bur-radar-best">PEAK BEARING: <span>${bestDir}</span></div>`;
  }

  /* ── FOCUS ── */
  function setFocus(name) {
    focusName = name;
    renderTripPlan(currentRows);
    renderTable(currentRows);
  }

  /* ── MAIN REFRESH ── */
  function refresh(force) {
    const threshold    = getThreshold();
    const tempThreshold = getTempThreshold();

    gridContainer?.classList.add('bur-loading');
    picksContainer?.classList.add('bur-loading');
    if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = '↻ REFRESHING…'; }

    fetch('/api/forecast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threshold,
        temp_threshold: tempThreshold,
        horizon,
        departure_day: departIdx + 1,
        force: !!force,
        origin_lat: originLat,
        origin_lon: originLon,
        radius,
      }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.rows && data.rows[0]) {
          forecastDates = data.rows[0].days.map(d => d.date);
        }
        currentRows = data.rows || [];

        // if focused row is gone, reset
        if (focusName && !currentRows.find(r => r.name === focusName)) {
          focusName = null;
        }

        renderDepartBtns();
        renderVerdict(data.top3);
        renderTicker(currentRows, data.top3);
        renderPicks(data.top3);
        renderTripPlan(currentRows);
        renderTable(currentRows);
        renderRadar(currentRows);

        const n = currentRows.length;
        if (stationCount) {
          stationCount.textContent = n >= 300
            ? n + ' CAMPS (MAX — REDUCE RADIUS)'
            : n + ' CAMPS LOADED';
        }

        clearTimeout(fetchingTimer);
        if (data.fetching && data.stale_count > 0) {
          if (fetchingBanner) {
            fetchingBanner.textContent =
              '⟳ ACQUIRING SIGNAL — FETCHING FORECASTS FOR ' + data.stale_count +
              ' NEW STATIONS. AUTO-UPDATE IN 12s.';
            fetchingBanner.style.display = 'block';
          }
          fetchingTimer = setTimeout(() => refresh(false), 12000);
        } else {
          if (fetchingBanner) fetchingBanner.style.display = 'none';
        }
        if (lastUpdatedEl) lastUpdatedEl.textContent = data.last_updated;
        if (lastUpdatedFt) lastUpdatedFt.textContent = data.last_updated;

        gridContainer?.classList.remove('bur-loading');
        picksContainer?.classList.remove('bur-loading');
        if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '↻ REFRESH'; }
      })
      .catch(() => {
        gridContainer?.classList.remove('bur-loading');
        picksContainer?.classList.remove('bur-loading');
        if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '↻ REFRESH'; }
      });
  }

  /* ── ESCAPE HELPER ── */
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── SHAREABLE URL ── */
  function syncUrl() {
    const params = new URLSearchParams({
      lat:       originLat.toFixed(4),
      lon:       originLon.toFixed(4),
      origin:    originLabel,
      threshold: getThreshold(),
      temp:      getTempThreshold(),
      horizon,
      dep:       departIdx + 1,
      radius,
    });
    history.replaceState(null, '', '?' + params.toString());
  }

  /* ── SIDEBAR TOGGLE (mobile) ── */
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const sidebarBody   = document.getElementById('sidebar-body');
  if (sidebarToggle && sidebarBody) {
    if (window.innerWidth <= 768) {
      sidebarBody.classList.add('bur-collapsed');
      sidebarToggle.classList.remove('open');
    }
    sidebarToggle.addEventListener('click', () => {
      const collapsed = sidebarBody.classList.toggle('bur-collapsed');
      sidebarToggle.classList.toggle('open', !collapsed);
    });
  }

  /* ── COPY LINK ── */
  const copyBtn = document.getElementById('copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      syncUrl();
      navigator.clipboard.writeText(window.location.href).then(() => {
        const orig = copyBtn.textContent;
        copyBtn.textContent = '✓ COPIED';
        setTimeout(() => { copyBtn.textContent = orig; }, 1800);
      }).catch(() => {
        window.prompt('Copy this link:', window.location.href);
      });
    });
  }

  /* ── EVENT WIRING ── */
  thresholdInput?.addEventListener('input', () => {
    if (thresholdVal) thresholdVal.textContent = thresholdInput.value + '%';
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { refresh(false); syncUrl(); }, 300);
  });

  tempInput?.addEventListener('input', () => {
    if (tempVal) tempVal.textContent = tempInput.value + '°F';
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { refresh(false); syncUrl(); }, 300);
  });

  radiusInput?.addEventListener('input', () => {
    radius = parseInt(radiusInput.value, 10);
    if (radiusVal) radiusVal.textContent = radius + ' mi';
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { refresh(false); syncUrl(); }, 400);
  });

  horizonBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      horizon = parseInt(btn.dataset.val, 10);
      horizonBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      refresh(false);
      syncUrl();
    });
  });

  refreshBtn?.addEventListener('click', () => refresh(true));

  locationBtn?.addEventListener('click', () => {
    const q = locationInput?.value.trim();
    if (q) geocodeLocation(q);
  });

  locationInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const q = locationInput.value.trim();
      if (q) geocodeLocation(q);
    }
  });

  // auto-refresh every 30 min
  setInterval(() => refresh(true), 30 * 60 * 1000);

  // boot
  renderDepartBtns();
  refresh(false);
})();
