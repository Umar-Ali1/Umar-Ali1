import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { createElement, memo, useEffect, useMemo, useRef, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CircleMarker, MapContainer, Marker, Pane, Polyline, Popup, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { POI_META, STOP_META } from '../poi'
import { ROUTE_COLORS, fmtDuration, fmtMiles, fmtTime, riskColor } from '../risk'
import type { Basemap, Checkpoint, HeatMetric, Heatmap, Plan, PoiKind, Route } from '../types'
import { HeatLayer } from './HeatLayer'

type Props = {
  plan: Plan | null
  heatmap: Heatmap | null
  heatMetric: HeatMetric
  heatVisible: boolean
  hour: number
  selectedId: string | null
  focus: Checkpoint | null
  basemap: Basemap
  poiKinds: Set<PoiKind>
  onSelect: (id: string) => void
}

const US_CENTER: L.LatLngTuple = [38.5, -96.5] // contiguous US
const POI_MIN_ZOOM = 7 // below this POIs would just be noise along a cross-country line

const BASEMAPS: Record<Basemap, { url: string; attribution: string; maxNativeZoom: number; labels?: string }> = {
  // Muted gray canvas so risk colours carry the map; labels render above the heatmap.
  light: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    maxNativeZoom: 16,
  },
  streets: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxNativeZoom: 19,
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    maxNativeZoom: 19,
  },
}

export default function MapView(props: Props) {
  const { plan, selectedId } = props
  const selected = plan?.routes.find((r) => r.id === selectedId) ?? null
  // Draw the selected route last so it sits on top.
  const ordered = plan ? [...plan.routes].sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId)) : []
  const base = BASEMAPS[props.basemap]

  return (
    <MapContainer center={US_CENTER} zoom={5} zoomSnap={0.5} minZoom={3} maxZoom={19} preferCanvas className="map" zoomControl={false}>
      <TileLayer key={props.basemap} url={base.url} attribution={base.attribution} maxNativeZoom={base.maxNativeZoom} maxZoom={19} />
      <Pane name="heat" style={{ zIndex: 350, pointerEvents: 'none' }} />
      <Pane name="labels" style={{ zIndex: 380, pointerEvents: 'none' }}>
        {base.labels && <TileLayer key={`${props.basemap}-labels`} url={base.labels} maxNativeZoom={16} maxZoom={19} />}
      </Pane>
      <HeatBridge data={props.heatVisible ? props.heatmap : null} metric={props.heatMetric} hour={props.hour} />
      <ZoomControl />
      <TrackSize />
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

      {selected && <PoiMarkers route={selected} kinds={props.poiKinds} />}
      {selected && <StopMarkers route={selected} />}
      {selected && props.heatmap && (
        <TruckMarker route={selected} plan={plan!} heatStart={props.heatmap.start} hour={props.hour} />
      )}
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

/** Leaflet caches its container size; re-measure whenever the layout changes it. */
function TrackSize() {
  const map = useMap()
  useEffect(() => {
    const ro = new ResizeObserver(() => map.invalidateSize({ pan: false }))
    ro.observe(map.getContainer())
    return () => ro.disconnect()
  }, [map])
  return null
}

function FitToPlan({ plan }: { plan: Plan | null }) {
  const map = useMap()
  useEffect(() => {
    if (!plan) return
    const pts = plan.routes.flatMap((r) => r.geometry)
    if (!pts.length) return
    map.invalidateSize({ pan: false })
    map.fitBounds(L.latLngBounds(pts), { padding: [48, 48] })
  }, [plan, map])
  return null
}

function FocusCheckpoint({ cp }: { cp: Checkpoint | null }) {
  const map = useMap()
  useEffect(() => {
    if (cp) map.flyTo([cp.lat, cp.lon], Math.max(map.getZoom(), 10), { duration: 0.7 })
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
    else runs.push({ level, points: last ? [last.points[last.points.length - 1], geom[i]] : [geom[i]] })
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
          Severe+ {fmtMiles(s.miles_by_level.severe + s.miles_by_level.no_travel)} · High {fmtMiles(s.miles_by_level.high)} · avg
          risk {s.avg_risk?.toFixed(2) ?? '—'}
        </div>
      </div>
    </Tooltip>
  )

  return (
    <>
      {selected ? (
        <>
          <Polyline positions={route.geometry} pathOptions={{ color: '#0b1220', weight: 11, opacity: 0.85 }} eventHandlers={handlers}>
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
          pathOptions={{ color, weight: 5, opacity: 0.6, dashArray: route.source === 'via' ? '10 7' : undefined }}
          eventHandlers={handlers}
        >
          {summary}
        </Polyline>
      )}
      {route.checkpoints.map((cp) => (
        <CircleMarker
          key={cp.index}
          center={[cp.lat, cp.lon]}
          radius={selected ? 6 : 3}
          pathOptions={{
            color: selected ? '#fff' : color,
            weight: selected ? 2 : 1,
            fillColor: riskColor(cp.risk?.level),
            fillOpacity: selected ? 1 : 0.85,
          }}
          eventHandlers={handlers}
        >
          <Tooltip direction="top" offset={[0, -6]}>
            <CheckpointDetail cp={cp} route={route} />
          </Tooltip>
          <Popup>
            <CheckpointDetail cp={cp} route={route} />
            <a className="streetview" href={streetViewUrl(cp.lat, cp.lon)} target="_blank" rel="noreferrer">
              Open Street View ↗
            </a>
          </Popup>
        </CircleMarker>
      ))}
    </>
  )
})

const streetViewUrl = (lat: number, lon: number) =>
  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`

function CheckpointDetail({ cp, route }: { cp: Checkpoint; route: Route }) {
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
          <div style={{ color: riskColor(cp.risk.level), fontWeight: 700 }}>
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

/** Lucide icon in a coloured disc, pre-rendered once to HTML for Leaflet's divIcon. */
const svgIcon = (Icon: (typeof POI_META)[PoiKind]['Icon'], bg: string, size: number) =>
  L.divIcon({
    html: `<span style="background:${bg}">${renderToStaticMarkup(
      createElement(Icon, { size: Math.round(size * 0.58), color: '#fff', strokeWidth: 2.4 }),
    )}</span>`,
    className: 'pin pin-svg',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })

const POI_ICONS = Object.fromEntries(
  Object.entries(POI_META).map(([k, m]) => [k, svgIcon(m.Icon, m.color, 22)]),
) as Record<PoiKind, L.DivIcon>
const STOP_ICONS = {
  break: svgIcon(STOP_META.break.Icon, '#0b1220', 28),
  reset: svgIcon(STOP_META.reset.Icon, '#0b1220', 28),
}
const TRUCK_ICON = L.divIcon({ html: '<span>🚚</span>', className: 'pin pin-truck', iconSize: [32, 32], iconAnchor: [16, 16] })
const ORIGIN_ICON = L.divIcon({ html: '<span>A</span>', className: 'pin pin-origin', iconSize: [28, 28], iconAnchor: [14, 14] })
const DEST_ICON = L.divIcon({ html: '<span>B</span>', className: 'pin pin-dest', iconSize: [28, 28], iconAnchor: [14, 14] })

function useZoom() {
  const map = useMap()
  const [zoom, setZoom] = useState(map.getZoom())
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) })
  return zoom
}

function PoiMarkers({ route, kinds }: { route: Route; kinds: Set<PoiKind> }) {
  const zoom = useZoom()
  if (zoom < POI_MIN_ZOOM) return null
  return (
    <>
      {route.pois
        .filter((p) => kinds.has(p.kind))
        .map((p) => (
          <Marker key={`${p.lat},${p.lon}`} position={[p.lat, p.lon]} icon={POI_ICONS[p.kind]}>
            <Tooltip direction="top" offset={[0, -10]}>
              <div className="tt">
                <strong>{p.name || POI_META[p.kind].label}</strong>
                <div>
                  {POI_META[p.kind].label} · mile {p.mile.toFixed(0)}
                  {p.off_route_mi > 0.3 && ` · ${p.off_route_mi.toFixed(1)} mi off route`}
                </div>
              </div>
            </Tooltip>
          </Marker>
        ))}
    </>
  )
}

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
        <Marker key={i} position={[s.lat, s.lon]} icon={STOP_ICONS[s.kind]} zIndexOffset={500}>
          <Tooltip direction="top" offset={[0, -12]}>
            <div className="tt">
              <strong>{STOP_META[s.kind].label}</strong>
              <div>
                Mile {s.mile.toFixed(0)} · {fmtTime(s.start)}
              </div>
              <div className="muted">{STOP_META[s.kind].rule}</div>
              {s.suggested && (
                <div>
                  Park at <b>{s.suggested.name || POI_META[s.suggested.kind].label}</b> (mile {s.suggested.mile.toFixed(0)})
                </div>
              )}
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
      if (elapsed >= s.at && elapsed < s.at + s.dur) return { lat: s.lat, lon: s.lon, mile: s.mile, resting: true }
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
        return {
          lat: a.lat + (cps[i].lat - a.lat) * t,
          lon: a.lon + (cps[i].lon - a.lon) * t,
          mile: a.mile + (cps[i].mile - a.mile) * t,
          resting: false,
        }
      }
    }
    const last = cps[cps.length - 1]
    return { lat: last.lat, lon: last.lon, mile: last.mile, resting: false, arrived: true }
  }, [route, plan.departure, heatStart, hour])

  return (
    <Marker position={[pos.lat, pos.lon]} icon={TRUCK_ICON} interactive={false} zIndexOffset={1000}>
      <Tooltip permanent direction="right" offset={[16, 0]} className="truck-tt">
        {'arrived' in pos && pos.arrived ? 'arrived' : `mile ${Math.round(pos.mile)}${pos.resting ? ' · resting' : ''}`}
      </Tooltip>
    </Marker>
  )
}
