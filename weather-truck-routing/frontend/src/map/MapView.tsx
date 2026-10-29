import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { memo, useEffect, useMemo, useRef } from 'react'
import { CircleMarker, MapContainer, Marker, Pane, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { ROUTE_COLORS, fmtDuration, fmtMiles, fmtTime, riskColor } from '../risk'
import type { Checkpoint, HeatMetric, Heatmap, Plan, Route } from '../types'
import { HeatLayer } from './HeatLayer'

type Props = {
  plan: Plan | null
  heatmap: Heatmap | null
  heatMetric: HeatMetric
  heatVisible: boolean
  hour: number
  selectedId: string | null
  focus: Checkpoint | null
  onSelect: (id: string) => void
}

const US_CENTER: L.LatLngTuple = [39.5, -98.35]

export default function MapView(props: Props) {
  const { plan, selectedId } = props
  const selected = plan?.routes.find((r) => r.id === selectedId) ?? null
  // Draw the selected route last so it sits on top.
  const ordered = plan ? [...plan.routes].sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId)) : []

  return (
    <MapContainer center={US_CENTER} zoom={4} maxZoom={16} preferCanvas className="map" zoomControl={false}>
      {/* Esri light-gray canvas: keyless, muted, so risk colours carry the map. Labels sit above the heatmap. */}
      <TileLayer
        attribution='Basemap &copy; <a href="https://www.esri.com">Esri</a>, HERE, Garmin, &copy; OpenStreetMap contributors'
        url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"
        maxZoom={16}
      />
      <Pane name="labels" style={{ zIndex: 380, pointerEvents: 'none' }}>
        <TileLayer
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}"
          maxZoom={16}
        />
      </Pane>
      <Pane name="heat" style={{ zIndex: 350, pointerEvents: 'none' }} />
      <HeatBridge data={props.heatVisible ? props.heatmap : null} metric={props.heatMetric} hour={props.hour} />
      <ZoomControl />
      <FitToPlan plan={plan} />
      <FocusCheckpoint cp={props.focus} />

      {ordered.map((r) => (
        <RouteLayer
          key={r.id}
          route={r}
          color={ROUTE_COLORS[plan!.routes.indexOf(r) % ROUTE_COLORS.length]}
          selected={r.id === selectedId}
          recommended={r.id === plan!.recommendation.route_id}
          onSelect={props.onSelect}
        />
      ))}

      {selected && <StopMarkers route={selected} />}
      {selected && props.heatmap && <TruckMarker route={selected} plan={plan!} heatStart={props.heatmap.start} hour={props.hour} />}
      {plan && <Endpoints plan={plan} />}
    </MapContainer>
  )
}

function ZoomControl() {
  const map = useMap()
  useEffect(() => {
    const c = L.control.zoom({ position: 'topright' }).addTo(map)
    return () => {
      c.remove()
    }
  }, [map])
  return null
}

function HeatBridge({ data, metric, hour }: { data: Heatmap | null; metric: HeatMetric; hour: number }) {
  const map = useMap()
  const layer = useRef<HeatLayer | null>(null)
  useEffect(() => {
    const l = new HeatLayer()
    l.addTo(map)
    layer.current = l
    return () => {
      l.remove()
    }
  }, [map])
  useEffect(() => layer.current?.setData(data), [data])
  useEffect(() => layer.current?.setMetric(metric), [metric])
  useEffect(() => layer.current?.setHour(hour), [hour])
  return null
}

function FitToPlan({ plan }: { plan: Plan | null }) {
  const map = useMap()
  useEffect(() => {
    if (!plan) return
    const pts = plan.routes.flatMap((r) => r.geometry)
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] })
  }, [plan, map])
  return null
}

function FocusCheckpoint({ cp }: { cp: Checkpoint | null }) {
  const map = useMap()
  useEffect(() => {
    if (cp) map.flyTo([cp.lat, cp.lon], Math.max(map.getZoom(), 8), { duration: 0.6 })
  }, [cp, map])
  return null
}

/** Splits the route line into runs coloured by the risk of the nearest checkpoint. */
function riskRuns(route: Route): { level: number | null; points: L.LatLngTuple[] }[] {
  const geom = route.geometry
  const cps = route.checkpoints
  if (geom.length < 2 || !cps.length) return []
  const cum = [0]
  for (let i = 1; i < geom.length; i++) cum.push(cum[i - 1] + L.latLng(geom[i - 1]).distanceTo(geom[i]))
  const scale = route.distance_mi / (cum[cum.length - 1] / 1609.344 || 1)
  const runs: { level: number | null; points: L.LatLngTuple[] }[] = []
  let j = 0
  for (let i = 0; i < geom.length; i++) {
    const mile = (cum[i] / 1609.344) * scale
    while (j + 1 < cps.length && Math.abs(cps[j + 1].mile - mile) <= Math.abs(cps[j].mile - mile)) j++
    const level = cps[j].risk?.level ?? null
    const last = runs[runs.length - 1]
    if (last && last.level === level) last.points.push(geom[i])
    else {
      // Start each run at the previous vertex so runs join without gaps.
      runs.push({ level, points: last ? [last.points[last.points.length - 1], geom[i]] : [geom[i]] })
    }
  }
  return runs
}

const RouteLayer = memo(function RouteLayer({
  route,
  color,
  selected,
  recommended,
  onSelect,
}: {
  route: Route
  color: string
  selected: boolean
  recommended: boolean
  onSelect: (id: string) => void
}) {
  const runs = useMemo(() => (selected ? riskRuns(route) : []), [route, selected])
  const handlers = useMemo(() => ({ click: () => onSelect(route.id) }), [onSelect, route.id])
  const s = route.summary
  const summary = (
    <Tooltip sticky direction="top" offset={[0, -8]}>
      <div className="tt">
        <strong>
          {route.name}
          {recommended && ' · Recommended'}
        </strong>
        <div>
          {fmtMiles(route.distance_mi)} · {fmtDuration(route.duration_s)} · arrive {fmtTime(route.arrival)}
        </div>
        <div>
          Severe {fmtMiles(s.miles_by_level.severe + s.miles_by_level.no_travel)} · High {fmtMiles(s.miles_by_level.high)} ·
          avg risk {s.avg_risk?.toFixed(2) ?? '—'}
        </div>
      </div>
    </Tooltip>
  )

  return (
    <>
      {selected ? (
        <>
          <Polyline positions={route.geometry} pathOptions={{ color: '#fff', weight: 10, opacity: 0.95 }} eventHandlers={handlers}>
            {summary}
          </Polyline>
          {runs.map((run, i) => (
            <Polyline
              key={i}
              positions={run.points}
              pathOptions={{ color: riskColor(run.level as never), weight: 6, opacity: 1, interactive: false }}
            />
          ))}
        </>
      ) : (
        <Polyline
          positions={route.geometry}
          pathOptions={{ color, weight: 5, opacity: 0.55, dashArray: route.source === 'via' ? '8 6' : undefined }}
          eventHandlers={handlers}
        >
          {summary}
        </Polyline>
      )}
      {route.checkpoints.map((cp) => (
        <CircleMarker
          key={cp.index}
          center={[cp.lat, cp.lon]}
          radius={selected ? 6 : 3.5}
          pathOptions={{
            color: selected ? '#fff' : color,
            weight: selected ? 2 : 1,
            fillColor: riskColor(cp.risk?.level),
            fillOpacity: selected ? 1 : 0.8,
          }}
          eventHandlers={handlers}
        >
          <Tooltip direction="top" offset={[0, -6]}>
            <CheckpointTip cp={cp} route={route} />
          </Tooltip>
        </CircleMarker>
      ))}
    </>
  )
})

function CheckpointTip({ cp, route }: { cp: Checkpoint; route: Route }) {
  const w = cp.weather
  return (
    <div className="tt">
      <strong>
        {route.name} · mile {cp.mile}
      </strong>
      <div>ETA {fmtTime(cp.eta)}</div>
      {w && cp.risk ? (
        <>
          <div>
            Wind {w.wind_mph} mph (gust {w.gust_mph}) · Rain {w.rain_in_hr.toFixed(2)} · Snow {w.snow_in_hr.toFixed(2)} in/hr
          </div>
          <div style={{ color: riskColor(cp.risk.level), fontWeight: 600 }}>
            {cp.risk.label}
            {cp.risk.drivers.length > 0 && ` — ${cp.risk.drivers.join(', ')}`}
          </div>
        </>
      ) : (
        <div>No forecast available for this time</div>
      )}
    </div>
  )
}

const icon = (html: string, cls: string) => L.divIcon({ html, className: `pin ${cls}`, iconSize: [26, 26], iconAnchor: [13, 13] })
const ORIGIN_ICON = icon('A', 'pin-origin')
const DEST_ICON = icon('B', 'pin-dest')
const BREAK_ICON = icon('☕', 'pin-stop')
const RESET_ICON = icon('🛏', 'pin-stop')
const TRUCK_ICON = L.divIcon({ html: '🚚', className: 'pin pin-truck', iconSize: [30, 30], iconAnchor: [15, 15] })

function Endpoints({ plan }: { plan: Plan }) {
  return (
    <>
      <Marker position={[plan.origin.lat, plan.origin.lon]} icon={ORIGIN_ICON}>
        <Tooltip>{plan.origin.name}</Tooltip>
      </Marker>
      <Marker position={[plan.destination.lat, plan.destination.lon]} icon={DEST_ICON}>
        <Tooltip>{plan.destination.name}</Tooltip>
      </Marker>
    </>
  )
}

function StopMarkers({ route }: { route: Route }) {
  return (
    <>
      {route.stops.map((s, i) => (
        <Marker key={i} position={[s.lat, s.lon]} icon={s.kind === 'break' ? BREAK_ICON : RESET_ICON}>
          <Tooltip>
            <div className="tt">
              <strong>{s.kind === 'break' ? '30-min break (8 h driving)' : '10-h off-duty reset (11 h driving)'}</strong>
              <div>
                Mile {s.mile} · from {fmtTime(s.start)}
              </div>
            </div>
          </Tooltip>
        </Marker>
      ))}
    </>
  )
}

/** Where the truck is at the slider's time, so the heatmap can be read against its position. */
function TruckMarker({ route, plan, heatStart, hour }: { route: Route; plan: Plan; heatStart: string; hour: number }) {
  const pos = useMemo(() => {
    const dep = new Date(plan.departure).getTime()
    const elapsed = (new Date(heatStart).getTime() + hour * 3600_000 - dep) / 1000
    // Map wall-clock time onto driving time so the truck stands still during HOS stops.
    const stops = route.stops.map((s) => ({ ...s, at: (new Date(s.start).getTime() - dep) / 1000, dur: s.duration_h * 3600 }))
    for (const s of stops) {
      if (elapsed >= s.at && elapsed < s.at + s.dur) return { lat: s.lat, lon: s.lon, mile: s.mile }
    }
    const toDriving = (e: number) => e - stops.filter((s) => s.at < e).reduce((sum, s) => sum + Math.min(s.dur, e - s.at), 0)
    const drive = toDriving(Math.max(elapsed, 0))
    const cps = route.checkpoints
    for (let i = 1; i < cps.length; i++) {
      const b = toDriving(cps[i].elapsed_s)
      if (b >= drive) {
        const a = cps[i - 1]
        const ad = toDriving(a.elapsed_s)
        const t = (drive - ad) / (b - ad || 1)
        return { lat: a.lat + (cps[i].lat - a.lat) * t, lon: a.lon + (cps[i].lon - a.lon) * t, mile: a.mile + (cps[i].mile - a.mile) * t }
      }
    }
    const last = cps[cps.length - 1]
    return { lat: last.lat, lon: last.lon, mile: last.mile }
  }, [route, plan.departure, heatStart, hour])

  return (
    <Marker position={[pos.lat, pos.lon]} icon={TRUCK_ICON} interactive={false} zIndexOffset={1000}>
      <Tooltip permanent direction="right" offset={[14, 0]} className="truck-tt">
        mile {Math.round(pos.mile)}
      </Tooltip>
    </Marker>
  )
}

