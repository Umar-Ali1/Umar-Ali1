import L from 'leaflet'
import { heatStyle } from '../risk'
import type { HeatMetric, Heatmap } from '../types'

const SUPERSAMPLE = 6 // raster pixels per grid cell; the browser smooths the rest when scaling
const LUT_SIZE = 256
const METRIC_RANGE: Record<HeatMetric, number> = { risk: 4, wind: 60, precip: 1.2 }

type Grid = {
  rows: number
  cols: number
  lat0: number // centre of row 0 (southernmost)
  lon0: number // centre of col 0 (westernmost)
  spacing: number
  hours: number
  /** values[metric][hour][row * cols + col]; NaN where the cell is outside the corridor */
  values: Record<HeatMetric, Float32Array[]>
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
const invMercY = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90

/**
 * Leaflet layer that renders the corridor forecast as a continuous field.
 *
 * - Values (not point density) drive colour, so the map shows *where the weather is*,
 *   not where samples happen to cluster.
 * - The lat/lon grid is resampled into a small raster laid out in Web-Mercator rows,
 *   so the image lines up with the basemap even over a 20° latitude span.
 * - Bilinear interpolation between cells (renormalised at the corridor edge, which
 *   fades out softly) and linear blending between forecast hours make scrubbing smooth.
 * - Pan/zoom only re-blit the cached raster; it is rebuilt only when hour/metric/data change.
 */
export class HeatLayer extends L.Layer {
  private canvas = document.createElement('canvas')
  private raster = document.createElement('canvas')
  private grid: Grid | null = null
  private metric: HeatMetric = 'risk'
  private hour = 0
  private dirty = true
  private frame = 0
  private luts = new Map<HeatMetric, Uint8ClampedArray>()
  private north = 0
  private south = 0

  onAdd(map: L.Map) {
    this._map = map
    this.canvas.className = 'heat-canvas leaflet-zoom-hide'
    map.getPane('heat')!.appendChild(this.canvas)
    map.on('moveend zoomend resize viewreset', this.reset, this)
    this.reset()
    return this
  }

  onRemove(map: L.Map) {
    map.off('moveend zoomend resize viewreset', this.reset, this)
    this.canvas.remove()
    cancelAnimationFrame(this.frame)
    return this
  }

  setData(data: Heatmap | null) {
    this.grid = data ? buildGrid(data) : null
    this.invalidate()
  }

  setMetric(metric: HeatMetric) {
    if (metric === this.metric) return
    this.metric = metric
    this.invalidate()
  }

  setHour(hour: number) {
    if (hour === this.hour) return
    this.hour = hour
    this.invalidate()
  }

  private invalidate() {
    this.dirty = true
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.blit())
  }

  private reset() {
    const map = this._map
    if (!map) return
    const size = map.getSize()
    const dpr = window.devicePixelRatio || 1
    L.DomUtil.setPosition(this.canvas, map.containerPointToLayerPoint([0, 0]))
    this.canvas.width = size.x * dpr
    this.canvas.height = size.y * dpr
    this.canvas.style.width = `${size.x}px`
    this.canvas.style.height = `${size.y}px`
    this.blit()
  }

  private lut(metric: HeatMetric): Uint8ClampedArray {
    let lut = this.luts.get(metric)
    if (!lut) {
      lut = new Uint8ClampedArray(LUT_SIZE * 4)
      for (let i = 0; i < LUT_SIZE; i++) {
        const { rgb, alpha } = heatStyle(metric, (i / (LUT_SIZE - 1)) * METRIC_RANGE[metric])
        lut.set([rgb[0], rgb[1], rgb[2], Math.round(alpha * 255)], i * 4)
      }
      this.luts.set(metric, lut)
    }
    return lut
  }

  /** Rebuild the raster for the current hour and metric. ~1–2 ms for a typical corridor. */
  private rasterize() {
    const g = this.grid!
    const { rows, cols, spacing, lat0 } = g
    const half = spacing / 2
    this.south = lat0 - half
    this.north = lat0 + (rows - 1) * spacing + half
    const W = cols * SUPERSAMPLE
    const H = rows * SUPERSAMPLE
    if (this.raster.width !== W || this.raster.height !== H) {
      this.raster.width = W
      this.raster.height = H
    }

    // Blend the two neighbouring forecast hours once per frame, not per pixel.
    const series = g.values[this.metric]
    const h0 = Math.min(Math.floor(this.hour), g.hours - 1)
    const h1 = Math.min(h0 + 1, g.hours - 1)
    const t = this.hour - h0
    const a = series[h0]
    const b = series[h1]
    const field = new Float32Array(a.length)
    for (let i = 0; i < a.length; i++) field[i] = Number.isNaN(b[i]) ? a[i] : a[i] + (b[i] - a[i]) * t

    const lut = this.lut(this.metric)
    const scale = (LUT_SIZE - 1) / METRIC_RANGE[this.metric]
    const ctx = this.raster.getContext('2d')!
    const img = ctx.createImageData(W, H)
    const px = img.data
    const yTop = mercY(this.north)
    const yBot = mercY(this.south)

    for (let py = 0; py < H; py++) {
      const lat = invMercY(yTop + ((py + 0.5) / H) * (yBot - yTop))
      const fr = (lat - lat0) / spacing
      const r0 = Math.floor(fr)
      const fy = fr - r0
      for (let pxi = 0; pxi < W; pxi++) {
        const fc = ((pxi + 0.5) / SUPERSAMPLE) - 0.5
        const c0 = Math.floor(fc)
        const fx = fc - c0
        // Bilinear over the 4 neighbours, skipping cells outside the corridor.
        let sum = 0
        let wsum = 0
        for (let k = 0; k < 4; k++) {
          const r = r0 + (k >> 1)
          const c = c0 + (k & 1)
          if (r < 0 || r >= rows || c < 0 || c >= cols) continue
          const v = field[r * cols + c]
          if (Number.isNaN(v)) continue
          const w = (k >> 1 ? fy : 1 - fy) * (k & 1 ? fx : 1 - fx)
          sum += v * w
          wsum += w
        }
        if (wsum < 1e-6) continue
        const li = Math.max(0, Math.min(LUT_SIZE - 1, Math.round((sum / wsum) * scale))) * 4
        const o = (py * W + pxi) * 4
        px[o] = lut[li]
        px[o + 1] = lut[li + 1]
        px[o + 2] = lut[li + 2]
        // Fade alpha with coverage so the corridor edge is soft rather than stair-stepped.
        px[o + 3] = lut[li + 3] * Math.min(1, wsum * 1.6)
      }
    }
    ctx.putImageData(img, 0, 0)
    this.dirty = false
  }

  private blit() {
    const map = this._map
    const ctx = this.canvas.getContext('2d')
    if (!map || !ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    const g = this.grid
    if (!g) return
    if (this.dirty) this.rasterize()
    const half = g.spacing / 2
    const nw = map.latLngToContainerPoint([this.north, g.lon0 - half])
    const se = map.latLngToContainerPoint([this.south, g.lon0 + (g.cols - 1) * g.spacing + half])
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(this.raster, nw.x, nw.y, se.x - nw.x, se.y - nw.y)
  }
}

/** Index the API's sparse cell list into dense per-hour arrays for O(1) lookups. */
function buildGrid(d: Heatmap): Grid {
  const s = d.spacing_deg
  const lat0 = Math.min(...d.cells.map((c) => c[0]))
  const lon0 = Math.min(...d.cells.map((c) => c[1]))
  const idx = d.cells.map(([lat, lon]) => [Math.round((lat - lat0) / s), Math.round((lon - lon0) / s)])
  const rows = Math.max(...idx.map((i) => i[0])) + 1
  const cols = Math.max(...idx.map((i) => i[1])) + 1
  const hours = d.hours.length

  const dense = (src: (number | null)[][], map: (v: number, cell: number, h: number) => number) =>
    Array.from({ length: hours }, (_, h) => {
      const arr = new Float32Array(rows * cols).fill(NaN)
      idx.forEach(([r, c], cell) => {
        const v = src[cell][h]
        if (v != null) arr[r * cols + c] = map(v, cell, h)
      })
      return arr
    })

  return {
    rows,
    cols,
    lat0,
    lon0,
    spacing: s,
    hours,
    values: {
      risk: dense(d.risk, (v) => v),
      wind: dense(d.wind_mph, (v) => v),
      // Rain plus snow as liquid equivalent (~10:1) so both read on one scale.
      precip: dense(d.rain_in_hr, (v, cell, h) => v + (d.snow_in_hr[cell][h] ?? 0) / 10),
    },
  }
}
