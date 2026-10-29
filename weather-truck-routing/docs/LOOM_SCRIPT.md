# Loom walkthrough (target 7–8 minutes)

Time per section roughly follows the grading weights: logic 40 %, UI/map/heatmap 40 %, code 15 %, docs 5 %.

## 0:00 – 0:40 · The problem
- "A driver needs the safest route, given weather at the time they'll actually be on each stretch of road, their load weight, and travel time."
- Show the empty map and the one-line promise in the empty state.

## 0:40 – 2:30 · Demo: plan a trip (logic)
1. Enter **Chicago → Denver**, departure tomorrow morning, **42,000 lb**, sampling **25 mi**, HOS on. Click *Find safest route*.
2. Point out the **three routes**. OSRM returned two; the third is a via-point detour (dashed), kept only because it shares < 80 % of its length with the others.
3. The **recommended card is on top**; read its reason out loud ("Fewer Severe miles…"). Explain the order: No Travel → Severe → High → unforecast miles → average risk → time.
4. Open the **Profile** tab: risk at ETA along the route, wind against the 25/35/45/55 mph thresholds, rain/snow bars. Hover a peak and click it; the map flies there.
5. Open **Checkpoints**: each row has the ETA, the weather *at that ETA*, the risk, and *why* (wind / rain / snow / load).
6. **Load rule:** change the load from 42,000 to 30,000 lb with 45–54 mph wind on a checkpoint. It drops from No Travel to Severe, because the rule is "> 30,000" and the boundary is strict.

## 2:30 – 3:30 · Why the ETAs are right (logic)
- OSRM is a car profile → per-segment speed capped at 65 mph.
- **Hours of service**: 30-min break after 8 h driving, 10-h reset after 11 h. A 1,000-mile trip is ~28 h door to door, not 17. Every checkpoint after the reset is looked up ~10 h later; otherwise the weather would be wrong.
- **Stops & POIs** tab: each stop suggests the last truck stop or parking within 30 mi before the limit. Weigh stations along the route come from an OSM snapshot.

## 3:30 – 5:15 · Map and heatmap (UI/performance)
1. Scrub the **0–48 h slider**, then press **Play**. The heatmap blends between hours and the 🚚 marker moves along the selected route, standing still during the 10-h reset.
2. Switch **Risk / Wind / Rain + snow**.
3. Explain the design in one breath: "All 49 hours come down in one response, so the slider never hits the network. The layer colours by *value*, not point density like `leaflet.heat`. It's resampled in Web-Mercator so it lines up over a 20° latitude span, and pan/zoom only re-blit a cached raster."
4. Layers button: **Light / Streets / Satellite**, POI toggles; zoom in to street level and click a checkpoint → *Open Street View*.
5. Optional: resize to phone width to show the responsive layout.

## 5:15 – 6:45 · Code tour (quality)
- `backend/routing/risk.py`: pure, table-driven bands; tests at every edge (`tests/test_risk.py`).
- `hos.py`: 20 lines that turn driving time into wall-clock time.
- `services.py`: `get_route_options` (relaxation tiers), `build_checkpoints` (distance-weighted miles), `rank_key`.
- `providers.py`: retries, batching (100 points per Open-Meteo call), caching. **No silent fallbacks**: a failed forecast is a 502, never "calm weather". Mention `rain + showers` and snowfall vs. precipitation double-counting.
- `frontend/src/map/HeatLayer.ts`: the rasterizer; `RiskProfile.tsx`: the SVG chart.
- Run `pytest`: 60+ tests.

## 6:45 – 7:30 · Judgment calls and limits (docs)
- Ambiguous band edges resolve upward; No Travel ranks below Severe; unforecast miles never make a route look safer.
- **Domain note:** in real crosswinds *empty* trailers blow over first; the spec's heavier-is-worse rule is implemented as written, but I'd add a light-load rule in production.
- The adverse-driving-conditions exception is deliberately not used: forecast weather is known at dispatch.
- Free-tier limits (OSRM demo, Open-Meteo 10k/day) → throttling and caching; production would self-host OSRM and use ORS-HGV for truck restrictions (already supported with a free key).
- Close: "README maps every requirement to code."
