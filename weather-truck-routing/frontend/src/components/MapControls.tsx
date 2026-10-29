import { Layers, Map as MapIcon, Satellite, Sun } from 'lucide-react'
import { memo, useState } from 'react'
import { POI_KINDS, POI_META } from '../poi'
import type { Basemap, PoiKind } from '../types'

type Props = {
  basemap: Basemap
  onBasemap: (b: Basemap) => void
  poiKinds: Set<PoiKind>
  onTogglePoi: (k: PoiKind) => void
}

const BASEMAP_OPTIONS: { id: Basemap; label: string; Icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'streets', label: 'Streets', Icon: MapIcon },
  { id: 'satellite', label: 'Satellite', Icon: Satellite },
]

/** Basemap switcher + POI layer toggles, collapsed into one button so the map stays clear. */
function MapControls({ basemap, onBasemap, poiKinds, onTogglePoi }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <div className="map-controls">
      <button type="button" className="icon-btn" aria-expanded={open} aria-label="Map layers" onClick={() => setOpen((o) => !o)}>
        <Layers size={18} />
      </button>
      {open && (
        <div className="layers-panel">
          <div className="lp-title">Basemap</div>
          <div className="basemaps">
            {BASEMAP_OPTIONS.map(({ id, label, Icon }) => (
              <button type="button" key={id} className={basemap === id ? 'on' : ''} onClick={() => onBasemap(id)} aria-pressed={basemap === id}>
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>
          <div className="lp-title">Truck POIs (zoom in to see)</div>
          {POI_KINDS.map((k) => {
            const m = POI_META[k]
            return (
              <label key={k} className="lp-row" title={m.hint}>
                <input type="checkbox" checked={poiKinds.has(k)} onChange={() => onTogglePoi(k)} />
                <i style={{ background: m.color }}>
                  <m.Icon size={11} color="#fff" />
                </i>
                {m.plural}
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default memo(MapControls)
