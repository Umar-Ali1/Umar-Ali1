import { memo } from 'react'
import { fmtTime, riskColor } from '../risk'
import type { Checkpoint, Route } from '../types'

type Props = { route: Route; onFocus: (cp: Checkpoint) => void }

function CheckpointTable({ route, onFocus }: Props) {
  return (
    <div className="table-wrap">
      <table className="cps">
        <thead>
          <tr>
            <th>Mile</th>
            <th>ETA</th>
            <th title="Sustained wind (gust)">Wind</th>
            <th title="Rain in/hr">Rain</th>
            <th title="Snow in/hr">Snow</th>
            <th>Risk</th>
          </tr>
        </thead>
        <tbody>
          {route.checkpoints.map((cp) => (
            <tr key={cp.index} onClick={() => onFocus(cp)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onFocus(cp)}>
              <td>{cp.mile.toFixed(0)}</td>
              <td>{fmtTime(cp.eta)}</td>
              {cp.weather ? (
                <>
                  <td>
                    {cp.weather.wind_mph.toFixed(0)}
                    <span className="muted"> ({cp.weather.gust_mph.toFixed(0)})</span>
                  </td>
                  <td>{cp.weather.rain_in_hr.toFixed(2)}</td>
                  <td>{cp.weather.snow_in_hr.toFixed(2)}</td>
                </>
              ) : (
                <td colSpan={3} className="muted">
                  no forecast
                </td>
              )}
              <td>
                <span className="dot" style={{ background: riskColor(cp.risk?.level) }} />
                {cp.risk?.label ?? 'Unknown'}
                {cp.risk && cp.risk.drivers.length > 0 && <span className="muted"> · {cp.risk.drivers.join(', ')}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Memoised: the slider re-renders the app up to 60x/s during playback.
export default memo(CheckpointTable)
