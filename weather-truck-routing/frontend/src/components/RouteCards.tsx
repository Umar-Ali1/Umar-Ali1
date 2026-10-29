import { memo } from 'react'
import { ROUTE_COLORS, RISK_COLORS, UNKNOWN_COLOR, fmtDuration, fmtMiles, fmtTime, riskColor } from '../risk'
import type { Plan, Route } from '../types'

type Props = { plan: Plan; selectedId: string | null; onSelect: (id: string) => void }

const BAR_KEYS = ['low', 'moderate', 'high', 'severe', 'no_travel'] as const

function RouteCards({ plan, selectedId, onSelect }: Props) {
  const recommended = plan.recommendation.route_id
  const fastest = Math.min(...plan.routes.map((r) => r.duration_s))
  // Best first; colours stay keyed to the API order so cards match their map lines.
  const ranked = [...plan.routes].sort((a, b) => a.rank - b.rank)
  return (
    <div className="cards">
      {ranked.map((r) => (
        <RouteCard
          key={r.id}
          route={r}
          color={ROUTE_COLORS[plan.routes.indexOf(r) % ROUTE_COLORS.length]}
          selected={r.id === selectedId}
          reason={r.id === recommended ? plan.recommendation.reason : null}
          slower={r.duration_s - fastest}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

function RouteCard({
  route,
  color,
  selected,
  reason,
  slower,
  onSelect,
}: {
  route: Route
  color: string
  selected: boolean
  reason: string | null
  slower: number
  onSelect: (id: string) => void
}) {
  const m = route.summary.miles_by_level
  const total = route.distance_mi || 1
  return (
    <button
      type="button"
      className={`card ${selected ? 'selected' : ''} ${reason ? 'best' : ''}`}
      style={{ borderLeftColor: color }}
      onClick={() => onSelect(route.id)}
      aria-pressed={selected}
    >
      <div className="card-head">
        <strong>{route.name}</strong>
        {reason ? <span className="badge">Recommended</span> : <span className="rank">#{route.rank}</span>}
        <span className="max-risk" style={{ background: riskColor(route.summary.max_level) }}>
          worst: {route.summary.max_label}
        </span>
      </div>
      {reason && <p className="reason">{reason}</p>}
      <div className="stats">
        <span>{fmtMiles(route.distance_mi)}</span>
        <span>
          {fmtDuration(route.duration_s)}
          {slower > 60 && <em> (+{fmtDuration(slower)})</em>}
        </span>
        <span>arrive {fmtTime(route.arrival)}</span>
      </div>
      <div className="riskbar" aria-label="Miles by risk level">
        {BAR_KEYS.map((k, i) =>
          m[k] > 0 ? <i key={k} style={{ width: `${(m[k] / total) * 100}%`, background: RISK_COLORS[i] }} /> : null,
        )}
        {m.unknown > 0 && <i style={{ width: `${(m.unknown / total) * 100}%`, background: UNKNOWN_COLOR }} />}
      </div>
      <div className="stats small">
        <span>No Travel {fmtMiles(m.no_travel)}</span>
        <span>Severe {fmtMiles(m.severe)}</span>
        <span>High {fmtMiles(m.high)}</span>
        <span>avg {route.summary.avg_risk?.toFixed(2) ?? '—'}</span>
      </div>
      {route.stops.length > 0 && (
        <div className="stats small muted">
          Driving {fmtDuration(route.driving_s)} + {route.stops.filter((s) => s.kind === 'break').length} break(s),{' '}
          {route.stops.filter((s) => s.kind === 'reset').length} 10-h reset(s)
        </div>
      )}
      {m.unknown > 0 && <div className="stats small muted">{fmtMiles(m.unknown)} beyond the forecast horizon</div>}
    </button>
  )
}

// Memoised: the slider re-renders the app up to 60x/s during playback.
export default memo(RouteCards)
