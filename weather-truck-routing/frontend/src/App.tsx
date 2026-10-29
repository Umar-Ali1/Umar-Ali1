import { useCallback, useState } from 'react'
import { ApiError, api } from './api'
import CheckpointTable from './components/CheckpointTable'
import RouteCards from './components/RouteCards'
import TimeSlider from './components/TimeSlider'
import TripForm from './components/TripForm'
import MapView from './map/MapView'
import { RISK_COLORS, RISK_LABELS } from './risk'
import type { Checkpoint, HeatMetric, Heatmap, Plan, TripInput } from './types'

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

  const [heatmap, setHeatmap] = useState<Heatmap | null>(null)
  const [heatLoading, setHeatLoading] = useState(false)
  const [heatError, setHeatError] = useState<string | null>(null)
  const [hour, setHour] = useState(0)
  const [metric, setMetric] = useState<HeatMetric>('risk')
  const [heatVisible, setHeatVisible] = useState(true)

  const submit = useCallback(async (input: TripInput) => {
    setPlanning(true)
    setError(null)
    setHeatError(null)
    try {
      const p = await api.plan(input)
      setPlan(p)
      setSelectedId(p.recommendation.route_id)
      setFocus(null)
      setHour(0)
      setPlanning(false)
      // The heatmap loads after routes are on screen so the main result is never blocked by it.
      setHeatmap(null)
      setHeatLoading(true)
      try {
        setHeatmap(await api.heatmap(corridorOf(p), p.departure, p.load_lb))
      } catch (e) {
        setHeatError(e instanceof ApiError ? e.message : 'Heatmap failed to load')
      } finally {
        setHeatLoading(false)
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong')
      setPlanning(false)
    }
  }, [])

  const selected = plan?.routes.find((r) => r.id === selectedId) ?? null

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>
            <span aria-hidden>🚚</span> Weather-Aware Truck Routing
          </h1>
          <p className="muted">Three route options scored against forecast wind, rain and snow at the truck's arrival time.</p>
        </header>
        <TripForm loading={planning} onSubmit={submit} />
        {error && <div className="error">{error}</div>}
        {plan?.weather_source === 'mock' && (
          <div className="note warn">Demo weather: the server is running with synthetic (mock) forecasts.</div>
        )}
        {plan && <RouteCards plan={plan} selectedId={selectedId} onSelect={setSelectedId} />}
        {selected && (
          <section>
            <h2>
              {selected.name} checkpoints <span className="muted">every {plan!.interval_mi} mi</span>
            </h2>
            <CheckpointTable route={selected} onFocus={setFocus} />
          </section>
        )}
        <footer className="muted small">
          Routing © OSRM/OpenStreetMap · Weather © Open-Meteo · Times shown in your local time zone
        </footer>
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
          onSelect={setSelectedId}
        />
        <div className="map-legend" aria-label="Checkpoint risk legend">
          <strong>Checkpoint risk</strong>
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
        {planning && <div className="map-overlay">Fetching routes and forecasts…</div>}
      </main>
    </div>
  )
}
