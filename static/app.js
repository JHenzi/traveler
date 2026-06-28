(function () {
  const thresholdInput   = document.getElementById('threshold');
  const thresholdVal     = document.getElementById('threshold-val');
  const tempThreshInput  = document.getElementById('temp-threshold');
  const tempThreshVal    = document.getElementById('temp-threshold-val');
  const horizonInputs    = document.querySelectorAll('input[name="horizon"]');
  const depDayInput      = document.getElementById('departure-day');
  const depDayVal        = document.getElementById('departure-day-val');
  const depHint          = document.getElementById('departure-hint');
  const gridContainer    = document.getElementById('grid-container');
  const kpiStrip         = document.getElementById('kpi-strip');
  const top3Panel        = document.getElementById('top3-panel');
  const refreshBtn       = document.getElementById('refresh-btn');
  const lastUpdatedEl    = document.getElementById('last-updated');

  const AUTO_REFRESH_MS = 30 * 60 * 1000;
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

  let forecastDates = [];
  let radarChart    = null;
  let debounceTimer = null;

  // "2026-06-05" -> "Thu"  (local date to avoid UTC-shift off-by-one)
  function dayName(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return SHORT_DAYS[new Date(y, m - 1, d).getDay()];
  }

  function getHorizon() {
    for (const r of horizonInputs) {
      if (r.checked) return parseInt(r.value, 10);
    }
    return 7;
  }

  function getDepartureDay() {
    return parseInt(depDayInput.value, 10);
  }

  function updateDepLabel(val) {
    const date = forecastDates[val - 1];
    if (date) {
      depDayVal.textContent = dayName(date);
      const [y, m, d] = date.split('-').map(Number);
      depHint.textContent = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else {
      depDayVal.textContent = 'Day ' + val;
      depHint.textContent   = '';
    }
  }

  function getTempThreshold() {
    return parseInt(tempThreshInput.value, 10);
  }

  function refresh(force) {
    const threshold    = parseInt(thresholdInput.value, 10);
    const tempThresh   = getTempThreshold();
    const horizon      = getHorizon();
    const departureDay = getDepartureDay();

    gridContainer.classList.add('loading');
    top3Panel.classList.add('loading');
    if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = '↻ Refreshing…'; }

    fetch('/api/forecast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threshold, temp_threshold: tempThresh, horizon, departure_day: departureDay, force: !!force }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.rows && data.rows[0]) {
          forecastDates = data.rows[0].days.map(d => d.date);
          updateDepLabel(getDepartureDay());
        }
        renderTop3(data.top3, data.departure_day, data.threshold, data.temp_threshold);
        renderKPI(data.best);
        renderGrid(data.rows, data.horizon, data.threshold, data.temp_threshold);
        renderRadar(data.rows, data.departure_day, data.threshold, data.temp_threshold);
        gridContainer.classList.remove('loading');
        top3Panel.classList.remove('loading');
        if (lastUpdatedEl) lastUpdatedEl.textContent = data.last_updated;
        if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '↻ Refresh'; }
      })
      .catch(() => {
        gridContainer.classList.remove('loading');
        top3Panel.classList.remove('loading');
        if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '↻ Refresh'; }
      });
  }

  function renderTop3(top3, departureDay, threshold, tempThreshold) {
    if (!top3 || top3.length === 0) {
      top3Panel.innerHTML = `<div class="top3-empty">
        No destinations pass the rain filter for Day ${departureDay} at ${threshold}% threshold.
        Try raising the tolerance or choosing a different departure day.
      </div>`;
      return;
    }

    const depDate  = forecastDates[departureDay - 1];
    const depLabel = depDate ? dayName(depDate) : `Day ${departureDay}`;

    const cards = top3.map((rec, i) => {
      const rank      = i + 1;
      const rankLabel = rank === 1 ? '#1 Best Match' : `#${rank}`;
      const bestCls   = rank === 1 ? 'rec-best' : '';
      const depIdx    = rec.departure_day - 1;
      const weights   = [50, 35, 15];

      const dayCells = rec.days.slice(depIdx, depIdx + 3).map((day, j) => {
        const rainCls = day.precip_prob <= threshold ? 'dry' : 'wet';
        const hotCls  = day.temp_max > tempThreshold ? ' hot' : '';
        const temp    = Math.round(day.temp_max);
        return `<div class="rec-day ${rainCls}${hotCls}">
          <span class="rec-day-label">${dayName(day.date)}</span>
          <span class="rec-day-emoji">${day.emoji}</span>
          <span class="rec-day-temp">${temp}°F</span>
          <span class="rec-day-precip">${day.precip_prob}%</span>
          <span class="rec-day-weight">×${weights[j]}%</span>
        </div>`;
      }).join('');

      return `<div class="rec-card ${bestCls}">
        <div class="rec-rank">${rankLabel}</div>
        <div class="rec-name">${rec.name}</div>
        <div class="rec-dir">${rec.direction}</div>
        <div class="rec-score">
          <span class="score-num">${rec.score}</span>
          <span class="score-label">/ 100</span>
        </div>
        <div class="rec-window-row">${dayCells}</div>
        <div class="rec-dry-window">Dry window: ${rec.dry_window}d</div>
      </div>`;
    }).join('');

    top3Panel.innerHTML = `
      <h2 class="section-label">Trip Quality Rankings — Departing ${depLabel}</h2>
      <div class="top3-cards">${cards}</div>
    `;
  }

  function renderKPI(best) {
    if (!best) { kpiStrip.innerHTML = ''; return; }
    const plural = best.dry_window !== 1 ? 's' : '';
    kpiStrip.innerHTML = `
      <div class="kpi">
        <span class="kpi-label">Best Dry Window</span>
        <span class="kpi-value">${best.name}</span>
      </div>
      <div class="kpi">
        <span class="kpi-label">Direction</span>
        <span class="kpi-value">${best.direction}</span>
      </div>
      <div class="kpi">
        <span class="kpi-label">Dry Days</span>
        <span class="kpi-value">${best.dry_window} day${plural}</span>
      </div>
    `;
  }

  function renderGrid(rows, horizon, threshold, tempThreshold) {
    if (!rows || rows.length === 0) {
      gridContainer.innerHTML = '<p class="error">No forecast data available.</p>';
      return;
    }

    const dayHeaders = rows[0].days.map(d =>
      `<th class="col-day">${dayName(d.date)}<br/><small>${d.date.slice(5)}</small></th>`
    ).join('');

    const bodyRows = rows.map(row => {
      const dayCells = row.days.map(day => {
        const rainCls = day.precip_prob <= threshold ? 'dry' : 'wet';
        const hotCls  = day.temp_max > tempThreshold ? ' hot' : '';
        const temp    = Math.round(day.temp_max);
        return `<td class="col-day ${rainCls}${hotCls}">
          <span class="emoji">${day.emoji}</span><br/>
          <span class="temp">${temp}°F</span><br/>
          <span class="precip">${day.precip_prob}%</span>
        </td>`;
      }).join('');

      return `<tr>
        <td class="col-dest">${row.name}</td>
        <td class="col-dir">${row.direction}</td>
        ${dayCells}
        <td class="col-dry dry-window">${row.dry_window}d</td>
      </tr>`;
    }).join('');

    gridContainer.innerHTML = `
      <div class="table-wrapper">
        <table class="forecast-table">
          <thead>
            <tr>
              <th class="col-dest">Destination</th>
              <th class="col-dir">Direction</th>
              ${dayHeaders}
              <th class="col-dry">Dry Window</th>
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    `;
  }

  function tripScore(days, depIdx, threshold, tempThreshold) {
    if (depIdx >= days.length) return null;
    if (days[depIdx].precip_prob > threshold) return null;
    const window = days.slice(depIdx, depIdx + 3);
    const d0 = window[0] ? window[0].precip_prob : 0;
    const d1 = window[1] ? window[1].precip_prob : 0;
    const d2 = window[2] ? window[2].precip_prob : 0;
    const rainPenalty = d0 * 0.50 + d1 * 0.35 + d2 * 0.15;
    const weights = [0.50, 0.35, 0.15];
    const heatPenalty = window.slice(0, 3).reduce((sum, day, j) =>
      sum + Math.max(0, day.temp_max - tempThreshold) * weights[j] * 1.2, 0);
    return Math.max(0, Math.round(100 - rainPenalty - heatPenalty));
  }

  function renderRadar(rows, departureDay, threshold, tempThreshold) {
    const canvas = document.getElementById('radar-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    const depIdx = (departureDay || 1) - 1;

    const dirMap = {};
    (rows || []).forEach(row => {
      const key   = row.direction.toLowerCase();
      const score = tripScore(row.days, depIdx, threshold, tempThreshold);
      if (score === null) return;
      COMPASS.forEach(c => {
        if (c.match.includes(key)) {
          if (dirMap[c.label] === undefined || score > dirMap[c.label]) {
            dirMap[c.label] = score;
          }
        }
      });
    });

    const values   = COMPASS.map(c => dirMap[c.label] || 0);
    const labels   = COMPASS.map(c => c.label);
    const maxVal   = Math.max(...values, 1);

    const bgColors = values.map(v => {
      if (v === 0) return 'rgba(248,113,113,0.2)';
      const ratio = v / maxVal;
      const r = Math.round(248 - ratio * (248 - 74));
      const g = Math.round(113 + ratio * (222 - 113));
      const b = Math.round(113 - ratio * (113 - 128));
      return `rgba(${r},${g},${b},0.45)`;
    });
    const borderColors = values.map(v => {
      if (v === 0) return 'rgba(248,113,113,0.6)';
      const ratio = v / maxVal;
      const r = Math.round(248 - ratio * (248 - 74));
      const g = Math.round(113 + ratio * (222 - 113));
      const b = Math.round(113 - ratio * (113 - 128));
      return `rgba(${r},${g},${b},1)`;
    });

    if (radarChart) {
      radarChart.data.datasets[0].data       = values;
      radarChart.data.datasets[0].backgroundColor = bgColors;
      radarChart.data.datasets[0].borderColor    = borderColors;
      radarChart.update();
      return;
    }

    radarChart = new Chart(canvas, {
      type: 'radar',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: bgColors,
          borderColor: borderColors,
          borderWidth: 1.5,
          pointBackgroundColor: borderColors,
          pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        animation: { duration: 400 },
        scales: {
          r: {
            min: 0,
            ticks: {
              stepSize: 1,
              color: '#555',
              backdropColor: 'transparent',
              font: { size: 9 },
            },
            grid:        { color: '#2a2d3a' },
            angleLines:  { color: '#2a2d3a' },
            pointLabels: {
              color: '#aaa',
              font: { size: 12, weight: '600' },
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ctx.raw > 0 ? ` score: ${ctx.raw}/100` : ' filtered (rain)',
            },
          },
        },
      },
    });
  }

  thresholdInput.addEventListener('input', () => {
    thresholdVal.textContent = thresholdInput.value + '%';
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 300);
  });

  tempThreshInput.addEventListener('input', () => {
    tempThreshVal.textContent = tempThreshInput.value + '°F';
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 300);
  });

  depDayInput.addEventListener('input', () => {
    updateDepLabel(parseInt(depDayInput.value, 10));
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 300);
  });

  horizonInputs.forEach(r => r.addEventListener('change', () => refresh(false)));

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => refresh(true));
  }

  setInterval(() => refresh(true), AUTO_REFRESH_MS);
  refresh(false);
})();
