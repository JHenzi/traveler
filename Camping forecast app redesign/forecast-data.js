// Weather Horizon — shared forecast data + scoring engine
// Deterministic generation so both design directions show identical numbers.

const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

// Base regional rain bias by compass direction (escape-the-rain story:
// a wet system sits to the south/southeast; the east & north stay drier).
const DIR_RAIN = { N: 16, NE: 15, E: 11, SE: 42, S: 50, SW: 46, W: 15, NW: 18 };
const DIR_HEAT = { N: -1, NE: -1, E: 0, SE: 3, S: 5, SW: 5, W: 1, NW: 0 };

// Parks roughly arranged by their bearing from Cincinnati, OH.
const PARKS = [
  ["Caesar Creek SP", "E", 41], ["Rocky Fork SP", "E", 64], ["Paint Creek SP", "E", 72],
  ["Pike Lake SP", "E", 78], ["Scioto Trail SP", "E", 88], ["Tar Hollow SP", "E", 96],
  ["Hocking Hills SP", "E", 118], ["Lake Hope SP", "E", 124], ["Zaleski Backcamp", "E", 121],
  ["Burr Oak SP", "NE", 132], ["Salt Fork SP", "NE", 168],
  ["Wayne NF", "N", 96], ["John Bryan SP", "N", 58], ["Buck Creek SP", "N", 66],
  ["Mohican SP", "N", 152], ["Maumee Bay SP", "N", 196],
  ["Hueston Woods SP", "NW", 38], ["Shades SP", "NW", 92], ["Turkey Run SP", "NW", 98],
  ["East Fork SP", "SE", 32], ["Shawnee SP (OH)", "SE", 102], ["Blue Licks SP", "SE", 58],
  ["Carter Caves SP", "SE", 132], ["Cave Run Lake", "SE", 118], ["Grayson Lake SP", "SE", 140],
  ["Jenny Wiley SP", "SE", 156], ["Breaks Interstate Park", "SE", 196],
  ["Red River Gorge", "SE", 96], ["Natural Bridge SP", "SE", 100],
  ["General Butler SP", "S", 56], ["Daniel Boone NF", "S", 132], ["Buckhorn Lake SP", "S", 148],
  ["Cumberland Falls SP", "S", 162], ["Lake Cumberland SP", "S", 158], ["Green River Lake SP", "S", 128],
  ["Hardy Lake", "W", 78], ["Versailles SP", "W", 52], ["Clifty Falls Canyon", "W", 84],
  ["Spring Mill SP", "W", 96], ["Monroe Lake", "W", 112], ["Brown County SP", "W", 104],
  ["Hoosier NF", "W", 118], ["McCormick's Creek SP", "W", 108], ["Patoka Lake", "W", 128],
  ["O'Bannon Woods SP", "SW", 96], ["Mammoth Cave NP", "SW", 168],
  ["Barren River Lake SP", "SW", 184], ["Lincoln SP", "SW", 132],
];

const DIR_LABEL = {
  N: "North", NE: "Northeast", E: "East", SE: "Southeast",
  S: "South", SW: "Southwest", W: "West", NW: "Northwest",
};

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function code(rain) {
  if (rain < 8) return "CLR";
  if (rain < 22) return "FEW";
  if (rain < 42) return "SCT";
  if (rain < 60) return "BKN";
  if (rain < 75) return "RAIN";
  return "STORM";
}

// 14 days of forecast per park, deterministic.
function buildForecast(name, dir) {
  const r = rng(hash(name + dir));
  const baseRain = DIR_RAIN[dir] + (r() * 22 - 11);
  const baseHeat = 87 + DIR_HEAT[dir] + (r() * 6 - 3);
  // A wet front clears the east/north faster than the south.
  const clearRate = ["E", "NE", "N", "NW", "W"].includes(dir) ? 1 : 0.35;
  const days = [];
  let wet = baseRain + (r() * 30 - 5); // day-0 often elevated
  for (let i = 0; i < 14; i++) {
    wet = wet - clearRate * (3 + r() * 6) + (r() * 16 - 8);
    let rain = Math.round(Math.max(0, Math.min(96, wet)));
    let temp = Math.round(baseHeat + i * 0.5 + (r() * 8 - 4) + (rain > 55 ? -3 : 2));
    days.push({ rain, temp, code: code(rain) });
  }
  return days;
}

const DATASET = PARKS.map(([name, dir, miles]) => ({
  name, dir, dirLabel: DIR_LABEL[dir], miles,
  drive: (miles / 52 + 0.4),         // est. hours
  days: buildForecast(name, dir),
}));

const BASE_DATE = new Date(2026, 5, 28); // Sun Jun 28 2026
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayMeta(offset) {
  const d = new Date(BASE_DATE);
  d.setDate(d.getDate() + offset);
  return { dow: DOW[d.getDay()], md: `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")}`, date: d };
}

// Score a destination given user tolerances. Returns rich object for the row.
function score(dest, opts) {
  const { rainTol, maxTemp, horizon, departIdx } = opts;
  const window = dest.days.slice(departIdx, departIdx + horizon);
  let dryCount = 0, comfCount = 0, rainSum = 0, run = 0, bestRun = 0, bestStart = 0, curStart = 0;
  window.forEach((d, i) => {
    rainSum += d.rain;
    const dry = d.rain <= rainTol;
    const comf = d.temp <= maxTemp;
    if (dry) { dryCount++; if (run === 0) curStart = i; run++; if (run > bestRun) { bestRun = run; bestStart = curStart; } }
    else run = 0;
    if (comf) comfCount++;
  });
  const n = window.length || 1;
  const avgRain = rainSum / n;
  const dryFrac = dryCount / n;
  const comfFrac = comfCount / n;
  // Weighted 0–100 trip-quality score.
  const raw = 100 * (0.5 * dryFrac + 0.32 * (1 - avgRain / 100) + 0.18 * comfFrac);
  return {
    ...dest,
    window,
    score: Math.round(raw * 10) / 10,
    avgRain: Math.round(avgRain),
    dryCount,
    dryWindow: bestRun,
    bestStart,
    drySpanLabel: bestRun >= horizon ? `${bestRun}d` : `${bestRun}d`,
  };
}

function rank(opts) {
  return DATASET.map((d) => score(d, opts)).sort((a, b) => b.score - a.score);
}

// Aggregate dry-quality by compass direction for the radar (0–100 per spoke).
function radar(opts) {
  const buckets = {};
  DIRECTIONS.forEach((d) => (buckets[d] = [])); 
  DATASET.forEach((dest) => buckets[dest.dir].push(score(dest, opts).score));
  return DIRECTIONS.map((d) => {
    const arr = buckets[d];
    const avg = arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
    return { dir: d, value: Math.round(avg) };
  });
}

export { DIRECTIONS, DIR_LABEL, DATASET, dayMeta, score, rank, radar, code };
