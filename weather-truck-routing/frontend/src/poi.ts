import { BedDouble, Coffee, Fuel, ParkingSquare, Scale, Trees, type LucideIcon } from 'lucide-react'
import type { PoiKind } from './types'

export type PoiMeta = { label: string; plural: string; color: string; Icon: LucideIcon; hint: string }

export const POI_META: Record<PoiKind, PoiMeta> = {
  weigh_station: {
    label: 'Weigh station',
    plural: 'Weigh stations',
    color: '#c2410c',
    Icon: Scale,
    hint: 'State enforcement scale. When open, commercial trucks must pull in; the weight threshold varies by state (commonly 10,001 lb GVWR).',
  },
  scale: {
    label: 'Certified scale',
    plural: 'Certified scales',
    color: '#7c3aed',
    Icon: Scale,
    hint: 'Commercial scale (e.g. CAT) for checking axle weights before an enforcement scale.',
  },
  truck_stop: {
    label: 'Truck stop',
    plural: 'Truck stops',
    color: '#0f766e',
    Icon: Fuel,
    hint: 'National-chain travel center with diesel lanes and truck parking.',
  },
  truck_parking: {
    label: 'Truck parking',
    plural: 'Truck parking',
    color: '#1d4ed8',
    Icon: ParkingSquare,
    hint: 'Designated heavy-vehicle parking.',
  },
  rest_area: {
    label: 'Rest area',
    plural: 'Rest areas',
    color: '#15803d',
    Icon: Trees,
    hint: 'Public rest area; many limit truck parking time.',
  },
}

export const POI_KINDS = Object.keys(POI_META) as PoiKind[]

export const STOP_META = {
  break: { label: '30-min break', rule: 'After 8 h cumulative driving — 49 CFR 395.3(a)(3)(ii)', Icon: Coffee },
  reset: { label: '10-h off-duty reset', rule: '11-h driving limit reached — 49 CFR 395.3(a)(1), (a)(3)(i)', Icon: BedDouble },
} as const
