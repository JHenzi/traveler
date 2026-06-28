Here is a structured, production-ready project goals file. It is written using clear, objective-driven specifications designed for an AI agent to parse, understand the architecture, and execute without ambiguous fluff.

You can save this as `project_goals.md` or feed it directly into a system prompt/instruction set in AI Studio.

---

# Project Specification: Weather Horizon Route Planner (Escape-the-Rain)

## 1. Objective & Core Value Proposition

Build a local-first, data-dense forecasting tool that flips the standard location-first weather paradigm. Instead of checking a specific city's weather, the user provides a starting point and a maximum travel radius. The application evaluates multiple geographical vectors (directions) over a 7-to-10-day timeline and presents the data as a unified resource grid (timesheet layout).

The primary business logic is to calculate the **"Maximum Consecutive Dry Days"** for each vector before a user-defined precipitation threshold is breached, allowing instant visual discovery of optimal travel windows.

---

## 2. Technical Stack Boundaries

* **Language:** Python 3.11+
* **Framework:** Streamlit (For rapid, clean UI layout and native data grid support)
* **Core Libraries:** `pandas`, `requests`, `geopy` (optional, for coordinate math), `plotly` (optional, for simple map validation)
* **Data Source:** **Open-Meteo API** (Free tier: no API key required, supports coordinate-based hourly/daily fetches)
* **Storage/State:** State-less or local cache only. No external database dependencies required.

---

## 3. Functional Requirements & Agent Execution Steps

### Step 1: Geographic Vector Generation

* The system must accept a central starting point (default: Cincinnati, OH; Lat: `39.1031`, Lon: `-84.5120`).
* The system must generate a list of target coordinates representing geographical "spokes" radiating outward at a configurable radius (e.g., 100, 200, 300 miles).
* **Hardcoded Destination Mode (Alternative):** Allow the agent to alternatively accept a pre-defined YAML/JSON mapping of favorite camping coordinates grouped by direction, for example:
* *East:* Hocking Hills, Red River Gorge (SE), New River Gorge
* *South:* Daniel Boone NF, Lake Cumberland
* *West:* Hoosier NF, Brown County
* *North:* Wayne NF, Maumee Bay



### Step 2: The Weather Data Pipeline

* For each monitored coordinate, fetch a 7-day or 10-day daily forecast from Open-Meteo.
* Extracted metrics per day must include:
* Maximum Temperature
* Weather Condition Code (WMO code translated to a human-readable string/emoji)
* **Precipitation Probability Max** (The peak % chance of rain/storms for that day)



### Step 3: The "Dry Horizon" Algorithm

* The engine must accept a user-controlled input parameter: `Precipitation Risk Threshold` (Integer percentage, default `30%`).
* For each vector row, iterate chronologically through Day 1 to Day 7/10.
* **Logic:** Count consecutive days where `Precipitation Probability <= Threshold`. The moment a day exceeds the threshold, stop counting for that row.
* Output this calculated integer as a distinct metric column: `Dry Window Max (Days)`.

### Step 4: UI / Resource Grid Render

* Display a data table/grid styled like an agenda or resource sheet.
* **Rows:** Destinations or Cardinal Vectors.
* **Columns:** Day 1 through Day 7/10, plus a prominent summary column for `Dry Window Max`.
* **Cell Attributes:** Display Temperature, a status Emoji, and the Rain Probability percentage.
* Apply conditional formatting (visual tags or cell highlighting) to instantly differentiate "Safe/Dry" cells from "Breached/Rain" cells based on the active threshold.

---

## 4. UI Layout & Controls Component Tree

The agent must implement the following layout hierarchy in Streamlit:

```text
[ Sidebar Controls ]
  ├── Starting Point Input (Text/Coordinates)
  ├── Max Travel Radius (Slider: 50mi to 300mi)
  ├── Rain Risk Tolerance Threshold (Slider: 10% to 100%, Default 30%)
  └── Forecast Horizon Toggle (Radio: 5-Day vs 7-Day vs 10-Day)

[ Main Dashboard View ]
  ├── Header: "Weather Horizon Route Planner"
  ├── Subheader / KPI Blocks: Shows the best direction and longest dry window currently available.
  ├── Main Component: Streamlit Dataframe / AgGrid component displaying the custom resource timesheet.
  └── Optional: A simple map plot marking the target locations color-coded by their dry window length.

```

---

## 5. Definition of Done (Success Criteria)

1. **Key-less Execution:** The Python app runs immediately without throwing errors regarding missing API keys or environmental tokens.
2. **Dynamic Filtering:** Adjusting the Rain Risk slider in the UI instantly re-calculates the `Dry Window Max` and updates the cell visual indicators without losing state.
3. **No Brute-Force Rate Limits:** The pipeline groups coordinate requests into a single batched Open-Meteo API call (Open-Meteo allows passing comma-separated lat/lon pairs in a single HTTP request) to optimize execution speed.
4. **Zero Over-Engineering:** No authentication, cloud databases, or complex web frameworks. Keep the script lean, human-readable, and modular.