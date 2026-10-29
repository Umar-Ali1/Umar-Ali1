export type Place = { name: string; lat: number; lon: number }

export type RiskLevel = 0 | 1 | 2 | 3 | 4

export type Weather = {
  wind_mph: number
  gust_mph: number
  rain_in_hr: number
  snow_in_hr: number
  precip_in_hr: number
}

export type CheckpointRisk = {
  level: RiskLevel
  label: string
  factors: { wind: RiskLevel; rain: RiskLevel; snow: RiskLevel; load: RiskLevel }
  drivers: string[]
}

export type Checkpoint = {
  index: number
  lat: number
  lon: number
  mile: number
  represents_mi: number
  elapsed_s: number
  eta: string
  weather?: Weather | null
  risk?: CheckpointRisk | null
}

export type Stop = {
  kind: 'break' | 'reset'
  lat: number
  lon: number
  mile: number
  start: string
  duration_h: number
}

export type RouteSummary = {
  miles_by_level: {
    low: number
    moderate: number
    high: number
    severe: number
    no_travel: number
    unknown: number
  }
  avg_risk: number | null
  max_level: RiskLevel
  max_label: string
}

export type Route = {
  id: string
  name: string
  source: 'osrm' | 'via'
  rank: number
  distance_mi: number
  driving_s: number
  duration_s: number
  arrival: string
  geometry: [number, number][]
  checkpoints: Checkpoint[]
  stops: Stop[]
  summary: RouteSummary
}

export type Plan = {
  origin: Place
  destination: Place
  departure: string
  load_lb: number
  interval_mi: 10 | 25 | 50
  hos_applied: boolean
  weather_source: string
  routes: Route[]
  recommendation: { route_id: string; reason: string }
}

export type Heatmap = {
  weather_source: string
  spacing_deg: number
  start: string
  hours: string[]
  cells: [number, number][]
  wind_mph: (number | null)[][]
  rain_in_hr: (number | null)[][]
  snow_in_hr: (number | null)[][]
  risk: (number | null)[][]
}

export type HeatMetric = 'risk' | 'wind' | 'precip'

export type TripInput = {
  origin: Place | string
  destination: Place | string
  departure: string
  load_lb: number
  interval_mi: 10 | 25 | 50
  apply_hos: boolean
}
