import { useEffect, useRef, useState } from 'react'
import { HEAT_LEGENDS, fmtTime } from '../risk'
import type { HeatMetric, Heatmap } from '../types'

type Props = {
  heatmap: Heatmap | null
  loading: boolean
  error: string | null
  hour: number
  onHour: (h: number) => void
  metric: HeatMetric
  onMetric: (m: HeatMetric) => void
  visible: boolean
  onVisible: (v: boolean) => void
}

const MAX_HOUR = 48
const PLAY_HOURS_PER_SEC = 3

export default function TimeSlider(props: Props) {
  const { heatmap, hour, onHour } = props
  const [playing, setPlaying] = useState(false)
  const hourRef = useRef(hour)
  hourRef.current = hour

  // rAF playback: advances in fractional hours; the heat layer blends between forecast hours.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const next = hourRef.current + ((now - last) / 1000) * PLAY_HOURS_PER_SEC
      last = now
      if (next >= MAX_HOUR) {
        onHour(MAX_HOUR)
        setPlaying(false)
        return
      }
      onHour(next)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, onHour])

  const at = heatmap ? new Date(new Date(heatmap.start).getTime() + hour * 3600_000).toISOString() : null

  return (
    <div className="slider-panel">
      <div className="slider-top">
        <strong>Corridor forecast</strong>
        <div className="segmented small" role="radiogroup" aria-label="Heatmap metric">
          {(['risk', 'wind', 'precip'] as const).map((m) => (
            <button
              type="button"
              key={m}
              role="radio"
              aria-checked={props.metric === m}
              className={props.metric === m ? 'on' : ''}
              onClick={() => props.onMetric(m)}
            >
              {m === 'risk' ? 'Risk' : m === 'wind' ? 'Wind' : 'Rain + snow'}
            </button>
          ))}
        </div>
        <label className="toggle small">
          <input type="checkbox" checked={props.visible} onChange={(e) => props.onVisible(e.target.checked)} />
          <span>Show</span>
        </label>
      </div>

      {props.loading && <div className="muted">Loading 48-hour corridor forecast…</div>}
      {props.error && <div className="error small">{props.error}</div>}
      {heatmap && (
        <>
          <div className="slider-row">
            <button
              type="button"
              className="play"
              onClick={() => {
                if (!playing && hour >= MAX_HOUR) onHour(0)
                setPlaying((p) => !p)
              }}
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <input
              type="range"
              min={0}
              max={MAX_HOUR}
              step={0.25}
              value={hour}
              onChange={(e) => {
                setPlaying(false)
                onHour(Number(e.target.value))
              }}
              aria-label="Forecast hour"
            />
            <span className="hour-label">
              +{Math.floor(hour)}h · {at && fmtTime(at)}
            </span>
          </div>
          <div className="legend">
            {HEAT_LEGENDS[props.metric].map((l) => (
              <span key={l.label}>
                <i style={{ background: l.color }} />
                {l.label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
