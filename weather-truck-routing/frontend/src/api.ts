import type { Heatmap, Place, Plan, TripInput } from './types'

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? ''

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.')
  }
  const body = await resp.json().catch(() => null)
  if (!resp.ok) throw new ApiError(formatError(body) ?? `Request failed (${resp.status})`)
  return body as T
}

/** DRF returns {field: [msg]} or {detail: msg}; flatten either into one line. */
function formatError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b.detail === 'string') return b.detail
  return Object.entries(b)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(' ') : String(v)}`)
    .join(' · ')
}

export const api = {
  geocode: (q: string, signal?: AbortSignal) =>
    request<{ results: Place[] }>(`/api/geocode?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.results),

  plan: (input: TripInput) => request<Plan>('/api/plan', { method: 'POST', body: JSON.stringify(input) }),

  heatmap: (corridor: [number, number][], departure: string, load_lb: number) =>
    request<Heatmap>('/api/heatmap', {
      method: 'POST',
      body: JSON.stringify({ corridor, departure, load_lb }),
    }),
}
