import { memo } from 'react'
import { POI_KINDS, POI_META, STOP_META } from '../poi'
import { fmtTime } from '../risk'
import type { Route } from '../types'

type Props = { route: Route; hosApplied: boolean }

/** HOS stops with where to park for each, then the truck POIs along the way. */
function StopsPanel({ route, hosApplied }: Props) {
  const counts = POI_KINDS.map((k) => [k, route.pois.filter((p) => p.kind === k).length] as const)
  const weighs = route.pois.filter((p) => p.kind === 'weigh_station' || p.kind === 'scale')

  return (
    <div className="stops-panel">
      <h3>Hours-of-service stops</h3>
      {!hosApplied ? (
        <p className="muted small">HOS rest stops are turned off for this plan.</p>
      ) : route.stops.length === 0 ? (
        <p className="muted small">Under 8 hours of driving — no mandatory stops.</p>
      ) : (
        <ol className="timeline">
          {route.stops.map((s, i) => {
            const meta = STOP_META[s.kind]
            return (
              <li key={i}>
                <span className="tl-icon">
                  <meta.Icon size={14} />
                </span>
                <div>
                  <b>{meta.label}</b> · mile {s.mile.toFixed(0)} · {fmtTime(s.start)}
                  <div className="muted small">{meta.rule}</div>
                  {s.suggested ? (
                    <div className="small">
                      Suggested: <b>{s.suggested.name || POI_META[s.suggested.kind].label}</b> (
                      {POI_META[s.suggested.kind].label.toLowerCase()}, mile {s.suggested.mile.toFixed(0)})
                    </div>
                  ) : (
                    <div className="small warn-ink">No mapped truck parking in the 30 mi before this stop — plan ahead.</div>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}

      <h3>Along this route</h3>
      <div className="poi-counts">
        {counts.map(([k, n]) => {
          const m = POI_META[k]
          return (
            <span key={k} title={m.hint}>
              <i style={{ background: m.color }}>
                <m.Icon size={11} color="#fff" />
              </i>
              {n} {m.plural.toLowerCase()}
            </span>
          )
        })}
      </div>
      {weighs.length > 0 && (
        <ul className="poi-list">
          {weighs.map((p, i) => (
            <li key={i}>
              <span className="mile">mi {p.mile.toFixed(0)}</span>
              <span>{p.name || POI_META[p.kind].label}</span>
              <span className="muted">{POI_META[p.kind].label}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">POIs from OpenStreetMap; coverage varies by state — verify station status on the road.</p>
    </div>
  )
}

export default memo(StopsPanel)
