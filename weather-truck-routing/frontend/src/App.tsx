import { CloudLightning, Truck } from 'lucide-react'
import { useCallback, useState } from 'react'
import { ApiError, api } from './api'
import MapControls from './components/MapControls'
import RouteCards from './components/RouteCards'
import RouteDetail from './components/RouteDetail'
import TimeSlider from './components/TimeSlider'
import TripForm from './components/TripForm'
import MapView from './map/MapView'
import { POI_KINDS } from './poi'
import { RISK_COLORS, RISK_LABELS } from './risk'
import type { Basemap, Checkpoint, HeatMetric, Heatmap, Plan, PoiKind, TripInput } from './types'

/** Every Nth vertex of each route — enough to outline the corridor for the heatmap grid. */
function corridorOf(plan: Plan): [number, number][] {
  return plan.routes.flatMap((r) => {
    const step = Math.max(1, Math.floor(r.geometry.length / 300))
    return r.geometry.filter((_, i) => i % step === 0)
  })
}

export default function App() {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focus, setFocus] = useState<Checkpoint | null>(null)
  const [formOpen, setFormOpen] = useState(true)
  const expandForm = useCallback(() => setFormOpen(true), [])

  const [heatmap, setHeatmap] = useState<Heatmap | null>(null)
  const [heatLoading, setHeatLoading] = useState(false)
  const [heatError, setHeatError] = useState<string | null>(null)
  const [hour, setHour] = useState(0)
  const [metric, setMetric] = useState<HeatMetric>('risk')
  const [heatVisible, setHeatVisible] = useState(true)

  const [basemap, setBasemap] = useState<Basemap>('light')
  const [poiKinds, setPoiKinds] = useState<Set<PoiKind>>(() => new Set(POI_KINDS.filter((k) => k !== 'rest_area')))
  const togglePoi = useCallback(
    (k: PoiKind) =>
      setPoiKinds((prev) => {
        const next = new Set(prev)
        if (next.has(k)) next.delete(k)
        else next.add(k)
        return next
      }),
    [],
  )

  const submit = useCallback(async (input: TripInput) => {
    setPlanning(true)
    setError(null)
    setHeatError(null)
    let p: Plan
    try {
      p = await api.plan(input)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong')
      setPlanning(false)
      return
    }
    setPlan(p)
    setFormOpen(false)
    // On narrow screens the map sits above the form; bring the result into view.
    if (window.matchMedia('(max-width: 900px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' })
    setSelectedId(p.recommendation.route_id)
    setFocus(null)
    setHour(0)
    setPlanning(false)
    // The heatmap loads after the routes are on screen so it never blocks the main result.
    setHeatmap(null)
    setHeatLoading(true)
    try {
      setHeatmap(await api.heatmap(corridorOf(p), p.departure, p.load_lb))
    } catch (e) {
      setHeatError(e instanceof ApiError ? e.message : 'Heatmap failed to load')
    } finally {
      setHeatLoading(false)
    }
  }, [])

  const selected = plan?.routes.find((r) => r.id === selectedId) ?? null

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <span className="brand-mark">
            <Truck size={20} />
          </span>
          <div>
            <h1>StormRoute</h1>
            <p>Weather-aware truck routing</p>
          </div>
        </header>

        <div className="sidebar-body">
          <TripForm loading={planning} collapsed={!formOpen && !!plan} onExpand={expandForm} onSubmit={submit} />
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {plan?.weather_source === 'mock' && (
            <div className="note warn">Demo weather: the server is running with synthetic (mock) forecasts.</div>
          )}

          {planning && !plan && <Skeleton />}
          {plan && (
            <>
              <h2 className="section-title">
                Route options <span className="muted">best first</span>
              </h2>
              <RouteCards plan={plan} selectedId={selectedId} onSelect={setSelectedId} />
            </>
          )}
          {plan && selected && <RouteDetail plan={plan} route={selected} onFocus={setFocus} />}

          <footer className="muted small">
            Routing © {plan?.routing_source === 'openrouteservice-hgv' ? 'openrouteservice' : 'OSRM'} · OpenStreetMap
            contributors · Weather © Open-Meteo · Times in your local zone
          </footer>
        </div>
      </aside>

      <main className="map-wrap">
        <MapView
          plan={plan}
          heatmap={heatmap}
          heatMetric={metric}
          heatVisible={heatVisible}
          hour={hour}
          selectedId={selectedId}
          focus={focus}
          basemap={basemap}
          poiKinds={poiKinds}
          onSelect={setSelectedId}
        />
        <MapControls basemap={basemap} onBasemap={setBasemap} poiKinds={poiKinds} onTogglePoi={togglePoi} />
        <div className="map-legend" aria-label="Checkpoint risk legend">
          <strong>Risk</strong>
          {RISK_LABELS.map((l, i) => (
            <span key={l}>
              <i style={{ background: RISK_COLORS[i] }} />
              {l}
            </span>
          ))}
        </div>
        {plan && (
          <TimeSlider
            heatmap={heatmap}
            loading={heatLoading}
            error={heatError}
            hour={hour}
            onHour={setHour}
            metric={metric}
            onMetric={setMetric}
            visible={heatVisible}
            onVisible={setHeatVisible}
          />
        )}
        {!plan && !planning && (
          <div className="map-empty">
            <CloudLightning size={28} />
            <div>
              <strong>Plan a trip to compare routes</strong>
              <p>We'll check wind, rain and snow at the exact hour your truck reaches each checkpoint.</p>
            </div>
          </div>
        )}
        {planning && (
          <div className="map-overlay" role="status">
            <span className="spinner" /> Fetching routes and forecasts…
          </div>
        )}
      </main>
    </div>
  )
}

function Skeleton() {
  return (
    <div className="skeleton" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="sk-card" />
      ))}
    </div>
  )
}
