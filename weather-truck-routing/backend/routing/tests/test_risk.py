import pytest

from routing.risk import Risk, apply_load_rules, assess, classify_rain, classify_snow, classify_wind


@pytest.mark.parametrize(
    "mph,expected",
    [
        (0, Risk.LOW),
        (24.9, Risk.LOW),
        (25, Risk.MODERATE),
        (34.9, Risk.MODERATE),
        (35, Risk.HIGH),
        (44.9, Risk.HIGH),
        (45, Risk.SEVERE),
        (54.9, Risk.SEVERE),
        (55, Risk.NO_TRAVEL),
        (80, Risk.NO_TRAVEL),
    ],
)
def test_wind_bands(mph, expected):
    assert classify_wind(mph) == expected


@pytest.mark.parametrize(
    "rate,expected",
    [
        (0.0, Risk.LOW),
        (0.099, Risk.LOW),
        (0.10, Risk.MODERATE),
        (0.25, Risk.HIGH),
        (0.50, Risk.SEVERE),
        (1.00, Risk.SEVERE),  # "> 1.00" is No Travel, so exactly 1.00 is still Severe
        (1.01, Risk.NO_TRAVEL),
    ],
)
def test_rain_bands(rate, expected):
    assert classify_rain(rate) == expected


@pytest.mark.parametrize(
    "rate,expected",
    [
        (0.0, Risk.LOW),
        (0.49, Risk.LOW),
        (0.5, Risk.MODERATE),
        (1.0, Risk.HIGH),
        (2.0, Risk.SEVERE),
        (3.0, Risk.SEVERE),
        (3.01, Risk.NO_TRAVEL),
    ],
)
def test_snow_bands(rate, expected):
    assert classify_snow(rate) == expected


@pytest.mark.parametrize(
    "wind,load,expected",
    [
        (38, 20_000, Risk.HIGH),  # no load override for light trucks
        (38, 40_000, Risk.HIGH),  # rule is "> 40,000", not ">="
        (38, 42_000, Risk.SEVERE),
        (48, 25_000, Risk.SEVERE),
        (48, 30_000, Risk.SEVERE),  # rule is "> 30,000", not ">="
        (48, 32_000, Risk.NO_TRAVEL),
        (56, 10_000, Risk.NO_TRAVEL),
        (20, 80_000, Risk.LOW),  # load alone never raises risk
    ],
)
def test_load_rules_combined_with_wind(wind, load, expected):
    assert assess(wind, 0, 0, load).level == expected


def test_load_rule_is_independent_of_precip():
    assert apply_load_rules(30, 80_000) == Risk.LOW


def test_worst_factor_wins_and_is_reported():
    a = assess(wind_mph=10, rain_in_hr=0.3, snow_in_hr=1.5, load_lb=10_000)
    assert a.level == Risk.HIGH
    assert set(a.drivers) == {"rain", "snow"}


def test_torrential_rain_is_no_travel():
    assert assess(5, 1.25, 0, 10_000).level == Risk.NO_TRAVEL


def test_calm_has_no_drivers():
    assert assess(5, 0, 0, 10_000).drivers == ()
