import { useEffect, useId, useRef, useState } from 'react'
import { api } from '../api'
import type { Place } from '../types'

type Props = {
  label: string
  value: Place | string
  onChange: (v: Place | string) => void
  placeholder?: string
}

/** Free-text location box with debounced geocoder suggestions (Nominatim via the API). */
export default function PlaceInput({ label, value, onChange, placeholder }: Props) {
  const id = useId()
  const text = typeof value === 'string' ? value : value.name
  const [options, setOptions] = useState<Place[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const typed = useRef(false)

  useEffect(() => {
    if (!typed.current || typeof value !== 'string' || value.trim().length < 3) {
      setOptions([])
      return
    }
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      api
        .geocode(value, ctrl.signal)
        .then((r) => {
          setOptions(r)
          setActive(-1)
          setOpen(true)
        })
        .catch(() => setOptions([]))
    }, 350) // Nominatim's policy is ≤1 req/s; debouncing keeps typing well under it
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [value])

  const pick = (p: Place) => {
    typed.current = false
    onChange(p)
    setOpen(false)
  }

  return (
    <div className="field place">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={text}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={`${id}-list`}
        onChange={(e) => {
          typed.current = true
          onChange(e.target.value)
        }}
        onFocus={() => options.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || !options.length) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => (a + 1) % options.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => (a <= 0 ? options.length - 1 : a - 1))
          } else if (e.key === 'Enter' && active >= 0) {
            e.preventDefault()
            pick(options[active])
          } else if (e.key === 'Escape') setOpen(false)
        }}
        required
      />
      {open && options.length > 0 && (
        <ul className="suggestions" id={`${id}-list`} role="listbox">
          {options.map((o, i) => (
            <li
              key={`${o.lat},${o.lon}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(o)
              }}
            >
              {o.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
