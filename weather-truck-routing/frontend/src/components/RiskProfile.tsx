import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { POI_META } from '../poi'
import { fmtTime, riskColor } from '../risk'
import type { Checkpoint, Route } from '../types'

type Props = { route: Route; onFocus: (cp: Checkpoint) => void }

const H = 190
const PAD = { top: 22, right: 34, bottom: 24, left: 30 }
const BAND_H = 10
const WIND_MAX = 60
const PRECIP_MAX = 1 // in/hr, liquid equivalent
const WIND_THRESHOLDS = [25, 35, 45, 55]

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(360)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

function niceStep(total: number, target = 5) {
  const raw = total / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
}

/** Wind, precipitation and risk along the route at the truck's ETA — one chart, one x-axis in miles. */
function RiskProfile({ route, onFocus }: Props) {
  const [wrapRef, W] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const cps = route.checkpoints
  const plotW = W - PAD.left - PAD.right
  const plotTop = PAD.top + BAND_H + 6
  const plotH = H - plotTop - PAD.bottom
  const x = (mile: number) => PAD.left + (mile / (route.distance_mi || 1)) * plotW
  const yWind = (mph: number) => plotTop + plotH - (Math.min(mph, WIND_MAX) / WIND_MAX) * plotH
  const yPrecip = (v: number) => (Math.min(v, PRECIP_MAX) / PRECIP_MAX) * plotH * 0.5

  const windPath = useMemo(() => {
    const pts = cps.filter((c) => c.weather).map((c) => `${x(c.mile).toFixed(1)},${yWind(c.weather!.wind_mph).toFixed(1)}`)
    return pts.length ? `M${pts.join('L')}` : ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cps, W])

  const step = niceStep(route.distance_mi)
  const ticks = Array.from({ length: Math.floor(route.distance_mi / step) + 1 }, (_, i) => i * step)
  const weighs = route.pois.filter((p) => p.kind === 'weigh_station')
  const barW = Math.max(2, Math.min(10, (plotW / Math.max(cps.length, 1)) * 0.6))
  const hovered = hover == null ? null : cps[hover]

  const pick = (clientX: number, el: SVGSVGElement) => {
    const rect = el.getBoundingClientRect()
    const mile = ((clientX - rect.left - PAD.left) / plotW) * route.distance_mi
    let best = 0
    for (let i = 1; i < cps.length; i++) if (Math.abs(cps[i].mile - mile) < Math.abs(cps[best].mile - mile)) best = i
    return best
  }

  return (
    <div className="profile" ref={wrapRef}>
      <svg
        width={W}
        height={H}
        role="img"
        aria-label={`Risk profile for ${route.name}`}
        onMouseMove={(e) => setHover(pick(e.clientX, e.currentTarget))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => onFocus(cps[pick(e.clientX, e.currentTarget)])}
      >
        {/* risk band: each checkpoint covers half the gap to its neighbours */}
        {cps.map((c, i) => {
          const from = i ? (cps[i - 1].mile + c.mile) / 2 : 0
          const to = i + 1 < cps.length ? (c.mile + cps[i + 1].mile) / 2 : route.distance_mi
          return (
            <rect key={c.index} x={x(from)} y={PAD.top} width={Math.max(0.5, x(to) - x(from))} height={BAND_H} fill={riskColor(c.risk?.level)} />
          )
        })}
        <text x={PAD.left} y={PAD.top - 6} className="axis-label">
          Risk at ETA
        </text>

        {/* wind thresholds from the spec, coloured by the band they open */}
        {WIND_THRESHOLDS.map((t, i) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={yWind(t)} y2={yWind(t)} stroke={riskColor((i + 1) as 1)} strokeDasharray="3 4" strokeOpacity={0.6} />
            <text x={W - PAD.right + 4} y={yWind(t) + 3} className="axis-tick" fill={riskColor((i + 1) as 1)}>
              {t}
            </text>
          </g>
        ))}
        <text x={W - 2} y={plotTop - 4} className="axis-tick" textAnchor="end">
          mph
        </text>

        {/* precipitation bars (rain + snow as liquid equivalent) */}
        {cps.map((c) => {
          if (!c.weather) return null
          const v = c.weather.rain_in_hr + c.weather.snow_in_hr / 10
          if (v < 0.005) return null
          const h = yPrecip(v)
          return (
            <rect
              key={c.index}
              x={x(c.mile) - barW / 2}
              y={plotTop + plotH - h}
              width={barW}
              height={h}
              rx={1}
              fill={c.weather.snow_in_hr > c.weather.rain_in_hr ? '#94a3b8' : '#38bdf8'}
              opacity={0.75}
            />
          )
        })}

        <path d={windPath} fill="none" stroke="#0f172a" strokeWidth={1.8} strokeLinejoin="round" />

        {/* HOS stops */}
        {route.stops.map((s, i) => (
          <g key={i}>
            <line x1={x(s.mile)} x2={x(s.mile)} y1={plotTop} y2={plotTop + plotH} stroke="#0f172a" strokeDasharray="2 3" strokeOpacity={0.5} />
            <text x={x(s.mile)} y={plotTop + 10} className="axis-tick" textAnchor="middle">
              {s.kind === 'break' ? '☕' : '🛏'}
            </text>
          </g>
        ))}

        {/* weigh stations on the axis */}
        {weighs.map((p, i) => (
          <path
            key={i}
            d={`M${x(p.mile)},${plotTop + plotH - 1} l-4,7 h8 z`}
            fill={POI_META.weigh_station.color}
          >
            <title>{`${p.name || 'Weigh station'} · mile ${p.mile.toFixed(0)}`}</title>
          </path>
        ))}

        {/* x axis */}
        <line x1={PAD.left} x2={W - PAD.right} y1={plotTop + plotH} y2={plotTop + plotH} stroke="#cbd5e1" />
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={H - 6} className="axis-tick" textAnchor="middle">
            {t}
          </text>
        ))}
        <text x={W - PAD.right} y={H - 6} className="axis-tick" textAnchor="end" dx={30}>
          mi
        </text>

        {hovered && (
          <g pointerEvents="none">
            <line x1={x(hovered.mile)} x2={x(hovered.mile)} y1={PAD.top} y2={plotTop + plotH} stroke="#0f172a" />
            {hovered.weather && <circle cx={x(hovered.mile)} cy={yWind(hovered.weather.wind_mph)} r={3.5} fill="#0f172a" />}
          </g>
        )}
      </svg>

      <div className="profile-readout" aria-live="polite">
        {hovered ? (
          <>
            <b>mile {hovered.mile.toFixed(0)}</b> · {fmtTime(hovered.eta)} ·{' '}
            {hovered.weather ? (
              <>
                wind {hovered.weather.wind_mph.toFixed(0)} mph · rain {hovered.weather.rain_in_hr.toFixed(2)} · snow{' '}
                {hovered.weather.snow_in_hr.toFixed(2)} ·{' '}
                <b style={{ color: riskColor(hovered.risk?.level) }}>{hovered.risk?.label}</b>
              </>
            ) : (
              'no forecast'
            )}
          </>
        ) : (
          <span className="muted">
            <i className="key line" /> wind &nbsp;
            <i className="key rain" /> rain &nbsp;
            <i className="key snow" /> snow &nbsp;
            <i className="key weigh" /> weigh station · hover to inspect, click to zoom
          </span>
        )}
      </div>
    </div>
  )
}

export default memo(RiskProfile)
