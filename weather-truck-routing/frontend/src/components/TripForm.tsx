import { memo, useState } from 'react'
import type { Place, TripInput } from '../types'
import PlaceInput from './PlaceInput'

const TYPICAL_TARE_LB = 35_000 // tractor + 53' dry van, empty
const FEDERAL_GVW_LIMIT_LB = 80_000 // 23 U.S.C. 127, Interstate System

function defaultDeparture(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  d.setMinutes(0, 0, 0)
  // datetime-local wants local time without zone
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

type Props = { loading: boolean; onSubmit: (input: TripInput) => void }

function TripForm({ loading, onSubmit }: Props) {
  const [origin, setOrigin] = useState<Place | string>('Chicago, IL')
  const [destination, setDestination] = useState<Place | string>('Denver, CO')
  const [departure, setDeparture] = useState(defaultDeparture)
  const [load, setLoad] = useState(38_000)
  const [interval, setIntervalMi] = useState<10 | 25 | 50>(25)
  const [hos, setHos] = useState(true)

  const gross = load + TYPICAL_TARE_LB

  return (
    <form
      className="trip-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({
          origin,
          destination,
          departure: new Date(departure).toISOString(),
          load_lb: load,
          interval_mi: interval,
          apply_hos: hos,
        })
      }}
    >
      <PlaceInput label="Origin" value={origin} onChange={setOrigin} placeholder="City, address or lat,lon" />
      <PlaceInput label="Destination" value={destination} onChange={setDestination} placeholder="City, address or lat,lon" />

      <div className="row">
        <div className="field">
          <label htmlFor="departure">Departure</label>
          <input id="departure" type="datetime-local" value={departure} onChange={(e) => setDeparture(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="load">Load weight (lb)</label>
          <input
            id="load"
            type="number"
            min={0}
            max={120000}
            step={500}
            value={load}
            onChange={(e) => setLoad(Number(e.target.value))}
            required
          />
        </div>
      </div>
      {gross > FEDERAL_GVW_LIMIT_LB && (
        <p className="note warn">
          ≈{gross.toLocaleString()} lb gross with a typical {TYPICAL_TARE_LB / 1000}k lb tractor-trailer — above the 80,000 lb
          federal limit; an overweight permit would be required.
        </p>
      )}

      <div className="row">
        <div className="field">
          <span className="label">Weather sampling</span>
          <div className="segmented" role="radiogroup" aria-label="Sampling interval">
            {([10, 25, 50] as const).map((v) => (
              <button
                type="button"
                key={v}
                role="radio"
                aria-checked={interval === v}
                className={interval === v ? 'on' : ''}
                onClick={() => setIntervalMi(v)}
              >
                {v} mi
              </button>
            ))}
          </div>
        </div>
        <label className="toggle" title="30-min break after 8 h driving; 10-h reset after 11 h (49 CFR 395.3)">
          <input type="checkbox" checked={hos} onChange={(e) => setHos(e.target.checked)} />
          <span>HOS rest stops</span>
        </label>
      </div>

      <button className="primary" type="submit" disabled={loading}>
        {loading ? 'Planning routes…' : 'Find safest route'}
      </button>
    </form>
  )
}

// Memoised: the slider re-renders the app up to 60x/s during playback.
export default memo(TripForm)
