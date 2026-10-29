"""Weather risk classification, implementing the assessment's risk and load rules.

Levels are ordered integers so "worst of" is just ``max``.

Threshold bands are lower-inclusive: e.g. wind 35.0 mph is High, 34.99 is Moderate.
The spec's table overlaps at band edges for rain/snow ("0.10–0.25" then
"0.25–0.50"); we resolve every shared edge upwards, except the top band where the
spec says "> 1.00" / "> 3.0" for No Travel, so exactly 1.00 in/hr rain is Severe.
"""

from dataclasses import dataclass
from enum import IntEnum


class Risk(IntEnum):
    LOW = 0
    MODERATE = 1
    HIGH = 2
    SEVERE = 3
    NO_TRAVEL = 4

    @property
    def label(self) -> str:
        return self.name.replace("_", " ").title()


def classify_wind(mph: float) -> Risk:
    if mph >= 55:
        return Risk.NO_TRAVEL
    if mph >= 45:
        return Risk.SEVERE
    if mph >= 35:
        return Risk.HIGH
    if mph >= 25:
        return Risk.MODERATE
    return Risk.LOW


def classify_rain(in_per_hr: float) -> Risk:
    if in_per_hr > 1.00:
        return Risk.NO_TRAVEL
    if in_per_hr >= 0.50:
        return Risk.SEVERE
    if in_per_hr >= 0.25:
        return Risk.HIGH
    if in_per_hr >= 0.10:
        return Risk.MODERATE
    return Risk.LOW


def classify_snow(in_per_hr: float) -> Risk:
    if in_per_hr > 3.0:
        return Risk.NO_TRAVEL
    if in_per_hr >= 2.0:
        return Risk.SEVERE
    if in_per_hr >= 1.0:
        return Risk.HIGH
    if in_per_hr >= 0.5:
        return Risk.MODERATE
    return Risk.LOW


def apply_load_rules(wind_mph: float, load_lb: float) -> Risk:
    """Extra risk from wind acting on a heavy load (the spec's "Load rules")."""
    if wind_mph >= 55:
        return Risk.NO_TRAVEL
    if 45 <= wind_mph < 55 and load_lb > 30_000:
        return Risk.NO_TRAVEL
    if 35 <= wind_mph < 45 and load_lb > 40_000:
        return Risk.SEVERE
    return Risk.LOW


@dataclass(frozen=True)
class Assessment:
    level: Risk
    wind: Risk
    rain: Risk
    snow: Risk
    load: Risk
    drivers: tuple[str, ...]  # which factors produced the final level

    def as_dict(self) -> dict:
        return {
            "level": int(self.level),
            "label": self.level.label,
            "factors": {
                "wind": int(self.wind),
                "rain": int(self.rain),
                "snow": int(self.snow),
                "load": int(self.load),
            },
            "drivers": list(self.drivers),
        }


def assess(wind_mph: float, rain_in_hr: float, snow_in_hr: float, load_lb: float) -> Assessment:
    factors = {
        "wind": classify_wind(wind_mph),
        "rain": classify_rain(rain_in_hr),
        "snow": classify_snow(snow_in_hr),
        "load": apply_load_rules(wind_mph, load_lb),
    }
    level = max(factors.values())
    drivers = tuple(name for name, lvl in factors.items() if lvl == level and level > Risk.LOW)
    return Assessment(level=level, drivers=drivers, **factors)
