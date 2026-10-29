import { Activity, Clock, Gauge, MapPinned, Route as RouteIcon, Table2 } from 'lucide-react'
import { memo, useState } from 'react'
import { fmtDuration, fmtMiles, fmtTime, riskColor } from '../risk'
import type { Checkpoint, Plan, Route } from '../types'
import CheckpointTable from './CheckpointTable'
import RiskProfile from './RiskProfile'
import StopsPanel from './StopsPanel'

type Props = { plan: Plan; route: Route; onFocus: (cp: Checkpoint) => void }

const TABS = [
  { id: 'profile', label: 'Profile', Icon: Activity },
  { id: 'checkpoints', label: 'Checkpoints', Icon: Table2 },
  { id: 'stops', label: 'Stops & POIs', Icon: MapPinned },
] as const
type Tab = (typeof TABS)[number]['id']

function RouteDetail({ plan, route, onFocus }: Props) {
  const [tab, setTab] = useState<Tab>('profile')
  const s = route.summary
  return (
    <section className="detail" aria-label={`${route.name} details`}>
      <div className="kpis">
        <Kpi Icon={RouteIcon} label="Distance" value={fmtMiles(route.distance_mi)} />
        <Kpi Icon={Clock} label="Door to door" value={fmtDuration(route.duration_s)} sub={`arrive ${fmtTime(route.arrival)}`} />
        <Kpi
          Icon={Gauge}
          label="Worst risk"
          value={s.max_label}
          sub={`avg ${s.avg_risk?.toFixed(2) ?? '—'} / 4`}
          color={riskColor(s.max_level)}
        />
      </div>

      <div className="tabs" role="tablist">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'on' : ''}
            onClick={() => setTab(id)}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'profile' && <RiskProfile route={route} onFocus={onFocus} />}
        {tab === 'checkpoints' && <CheckpointTable route={route} onFocus={onFocus} />}
        {tab === 'stops' && <StopsPanel route={route} hosApplied={plan.hos_applied} />}
      </div>
    </section>
  )
}

function Kpi({ Icon, label, value, sub, color }: { Icon: typeof Clock; label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="kpi">
      <span className="kpi-label">
        <Icon size={13} /> {label}
      </span>
      <span className="kpi-value" style={color ? { color } : undefined}>
        {value}
      </span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  )
}

export default memo(RouteDetail)
