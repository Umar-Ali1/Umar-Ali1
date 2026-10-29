import type { HeatMetric, RiskLevel } from './types'

export const RISK_LABELS = ['Low', 'Moderate', 'High', 'Severe', 'No Travel'] as const
export const RISK_COLORS = ['#22a35a', '#e0b100', '#f07c1b', '#d93025', '#7b1fa2'] as const
export const UNKNOWN_COLOR = '#9aa0a6'

export const riskColor = (level: RiskLevel | null | undefined) =>
  level == null ? UNKNOWN_COLOR : RISK_COLORS[level]

export const ROUTE_COLORS = ['#1a73e8', '#00897b', '#8e24aa']

type RGB = [number, number, number]
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB

function ramp(stops: [number, string][], v: number): RGB {
  if (v <= stops[0][0]) return hex(stops[0][1])
  for (let i = 1; i < stops.length; i++) {
    const [x1, c1] = stops[i]
    if (v <= x1) {
      const [x0, c0] = stops[i - 1]
      const t = (v - x0) / (x1 - x0)
      const a = hex(c0)
      const b = hex(c1)
      return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t)) as RGB
    }
  }
  return hex(stops[stops.length - 1][1])
}

/** Heatmap colour and opacity for a value. Calm weather fades out so hazards stand out. */
export function heatStyle(metric: HeatMetric, v: number): { rgb: RGB; alpha: number } {
  switch (metric) {
    case 'risk': {
      const rgb = ramp(RISK_COLORS.map((c, i) => [i, c] as [number, string]), v)
      return { rgb, alpha: v < 0.5 ? 0.05 + v * 0.2 : 0.15 + Math.min(v, 4) * 0.15 }
    }
    case 'wind':
      return {
        rgb: ramp([[0, '#9ad0f5'], [25, '#e0b100'], [35, '#f07c1b'], [45, '#d93025'], [55, '#7b1fa2']], v),
        alpha: Math.min(0.12 + v / 70, 0.75),
      }
    case 'precip':
      return {
        rgb: ramp([[0, '#b3e5fc'], [0.1, '#29b6f6'], [0.25, '#1565c0'], [0.5, '#6a1b9a'], [1, '#c2185b']], v),
        alpha: v < 0.01 ? 0 : Math.min(0.3 + v * 0.9, 0.8),
      }
  }
}

export const HEAT_LEGENDS: Record<HeatMetric, { label: string; color: string }[]> = {
  risk: RISK_LABELS.map((label, i) => ({ label, color: RISK_COLORS[i] })),
  wind: [
    { label: '<25 mph', color: '#9ad0f5' },
    { label: '25', color: '#e0b100' },
    { label: '35', color: '#f07c1b' },
    { label: '45', color: '#d93025' },
    { label: '55+', color: '#7b1fa2' },
  ],
  precip: [
    { label: '0.01 in/hr', color: '#b3e5fc' },
    { label: '0.10', color: '#29b6f6' },
    { label: '0.25', color: '#1565c0' },
    { label: '0.50', color: '#6a1b9a' },
    { label: '1.0+', color: '#c2185b' },
  ],
}

// --- formatting ---------------------------------------------------------------

export const fmtDuration = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h ${m}m`
  return h ? `${h}h ${m}m` : `${m}m`
}

const timeFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
})
export const fmtTime = (iso: string) => timeFmt.format(new Date(iso))

export const fmtMiles = (mi: number) => `${mi.toLocaleString(undefined, { maximumFractionDigits: 0 })} mi`
