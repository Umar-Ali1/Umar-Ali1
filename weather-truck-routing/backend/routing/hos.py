"""Converts driving time into wall-clock time using simplified FMCSA hours-of-service.

Weather is sampled at the truck's *arrival* time at each checkpoint, so ignoring
mandatory rest would make every ETA past hour 8 wrong — and the weather with it.

Simplified property-carrying rules (no sleeper-berth splits, no 14-hour window,
no 70-hour cycle):
  * 30-minute break after 8 cumulative hours of driving.
  * 10-hour off-duty reset after 11 hours of driving.
"""

from dataclasses import dataclass

HOUR = 3600.0
BREAK_AFTER_DRIVING_S = 8 * HOUR
BREAK_LENGTH_S = 0.5 * HOUR
SHIFT_DRIVING_LIMIT_S = 11 * HOUR
RESET_LENGTH_S = 10 * HOUR


@dataclass(frozen=True)
class Stop:
    kind: str  # "break" | "reset"
    driving_offset_s: float  # cumulative driving time when the stop starts
    duration_s: float


def plan_stops(total_driving_s: float) -> list[Stop]:
    stops: list[Stop] = []
    shift_start = 0.0
    while True:
        brk = shift_start + BREAK_AFTER_DRIVING_S
        end = shift_start + SHIFT_DRIVING_LIMIT_S
        if brk < total_driving_s:
            stops.append(Stop("break", brk, BREAK_LENGTH_S))
        if end < total_driving_s:
            stops.append(Stop("reset", end, RESET_LENGTH_S))
            shift_start = end
            continue
        return stops


def elapsed_for(driving_s: float, stops: list[Stop]) -> float:
    """Wall-clock seconds since departure once ``driving_s`` of driving is done.

    A stop that starts exactly at ``driving_s`` is not counted yet: the truck
    *arrives* at that point and then rests.
    """
    return driving_s + sum(s.duration_s for s in stops if s.driving_offset_s < driving_s)
