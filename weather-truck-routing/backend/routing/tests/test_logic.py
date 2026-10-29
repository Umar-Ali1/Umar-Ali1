from datetime import datetime, timedelta, timezone

import pytest

from routing import geo, hos, providers, services
from routing.risk import Risk

DEPART = datetime(2026, 1, 5, 12, 0, tzinfo=timezone.utc)


# --- Hours of service ---------------------------------------------------------


def test_short_trip_has_no_stops():
    assert hos.plan_stops(7 * 3600) == []


def test_break_after_eight_hours():
    stops = hos.plan_stops(9 * 3600)
    assert [(s.kind, s.driving_offset_s / 3600) for s in stops] == [("break", 8)]
    assert hos.elapsed_for(9 * 3600, stops) == 9.5 * 3600


def test_multi_day_trip_resets():
    stops = hos.plan_stops(25 * 3600)
    assert [(s.kind, s.driving_offset_s / 3600) for s in stops] == [
        ("break", 8),
        ("reset", 11),
        ("break", 19),
        ("reset", 22),
    ]
    # 25 h driving + 2 × 0.5 h breaks + 2 × 10 h resets
    assert hos.elapsed_for(25 * 3600, stops) == 46 * 3600


def test_arrival_at_stop_point_excludes_that_stop():
    stops = hos.plan_stops(9 * 3600)
    assert hos.elapsed_for(8 * 3600, stops) == 8 * 3600


# --- Geometry -------------------------------------------------------------------


def test_haversine_one_degree_latitude():
    assert geo.haversine_m((0, 0), (0, 1)) == pytest.approx(111_195, rel=1e-3)


def test_simplify_keeps_endpoints_and_drops_collinear():
    line = [(0, i * 0.001) for i in range(100)]
    out = geo.simplify(line)
    assert out == [line[0], line[-1]]


def test_overlap_ratio():
    a = [(0, i * 0.01) for i in range(100)]
    far = [(1, i * 0.01) for i in range(100)]
    assert geo.overlap_ratio(a, a) == 1.0
    assert geo.overlap_ratio(a, far) == 0.0


# --- Checkpoints ------------------------------------------------------------------


def straight_route(miles: float, mph: float = 60, n: int = 200) -> dict:
    """North-bound straight line with uniform speed."""
    total_m = miles * geo.METERS_PER_MILE
    lat_span = total_m / 111_195
    coords = [(-95.0, 35.0 + lat_span * i / n) for i in range(n + 1)]
    seg = [geo.haversine_m(coords[i], coords[i + 1]) for i in range(n)]
    speed = mph * geo.METERS_PER_MILE / 3600
    return {"coords": coords, "seg_distance_m": seg, "seg_duration_s": [d / speed for d in seg]}


def req(interval=25, hos_on=True, load=20_000):
    return services.TripRequest(
        origin={}, destination={}, departure=DEPART, load_lb=load, interval_mi=interval, apply_hos=hos_on
    )


def test_checkpoints_cover_route_and_miles_sum_to_length():
    route = straight_route(110)
    cps, stops, total = services.build_checkpoints(route, req(25))
    assert [cp["mile"] for cp in cps] == pytest.approx([0, 25, 50, 75, 100, 110], abs=0.2)
    assert sum(cp["represents_mi"] for cp in cps) == pytest.approx(110, abs=0.2)
    assert stops == []


def test_checkpoint_eta_tracks_driving_speed():
    cps, _, _ = services.build_checkpoints(straight_route(120, mph=60), req(10))
    one_hour = next(cp for cp in cps if cp["mile"] == pytest.approx(60, abs=0.2))
    assert datetime.fromisoformat(one_hour["eta"]) == pytest.approx(DEPART + timedelta(hours=1), abs=timedelta(minutes=1))


def test_hos_shifts_later_etas():
    route = straight_route(600, mph=50)  # 12 h of driving
    with_hos, stops, total = services.build_checkpoints(route, req(50, hos_on=True))
    without, _, total_raw = services.build_checkpoints(route, req(50, hos_on=False))
    assert [s["kind"] for s in stops] == ["break", "reset"]
    assert total - total_raw == pytest.approx(10.5 * 3600, abs=1)
    # Mile 450 is 9 h of driving: after the 8 h break, before the 11 h reset.
    i = next(i for i, cp in enumerate(without) if cp["mile"] == pytest.approx(450, abs=0.2))
    assert with_hos[i]["elapsed_s"] - without[i]["elapsed_s"] == pytest.approx(1800, abs=2)


def test_truck_speed_cap(settings):
    settings.TRUCK_MAX_SPEED_MPH = 60
    fast = straight_route(60, mph=80)
    capped = services._truckify(fast)
    assert capped["duration_s"] == pytest.approx(3600, rel=1e-3)


# --- Weather lookup ------------------------------------------------------------------


def make_forecast(start: datetime, wind, rain, snow):
    n = len(wind)
    return providers.HourlyForecast(
        int(start.timestamp()) // 3600,
        {
            "wind_speed_10m": wind,
            "wind_gusts_10m": [w * 1.3 for w in wind],
            "rain": rain,
            "showers": [0.0] * n,
            "snowfall": snow,
            "precipitation": [r + s / 10 for r, s in zip(rain, snow)],
        },
    )


def test_forecast_interpolates_wind_and_uses_hour_ending_for_precip():
    fc = make_forecast(DEPART, wind=[10, 20, 30], rain=[0.0, 0.2, 0.6], snow=[0, 0, 0])
    wx = fc.at(DEPART + timedelta(minutes=30))
    assert wx["wind_mph"] == 15
    assert wx["rain_in_hr"] == 0.2  # the 12:00–13:00 accumulation, stamped 13:00


def test_forecast_out_of_range_is_none_not_fabricated():
    fc = make_forecast(DEPART, wind=[10, 20], rain=[0, 0], snow=[0, 0])
    assert fc.at(DEPART + timedelta(hours=5)) is None


def test_attach_weather_marks_unavailable_beyond_horizon(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("must not fetch weather for out-of-range checkpoints")

    monkeypatch.setattr(providers, "fetch_forecasts", boom)
    far = datetime.now(timezone.utc) + timedelta(days=30)
    routes = [{"checkpoints": [{"lon": 0, "lat": 0, "eta": far.isoformat(), "represents_mi": 5}]}]
    services.attach_weather(routes, req())
    assert "risk" not in routes[0]["checkpoints"][0]
    assert services.summarize(routes[0]["checkpoints"])["miles_by_level"]["unknown"] == 5


# --- Recommendation ------------------------------------------------------------------


def fake_route(rid, duration_s, levels, mi=10.0):
    cps = [{"represents_mi": mi, "risk": {"level": int(lvl)}} for lvl in levels]
    return {"id": rid, "name": rid, "duration_s": duration_s, "summary": services.summarize(cps)}


def test_fewest_severe_beats_faster():
    fast_severe = fake_route("A", 3600, [Risk.LOW, Risk.SEVERE])
    slow_safe = fake_route("B", 7200, [Risk.HIGH, Risk.HIGH])
    rec = services.recommend([fast_severe, slow_safe])
    assert rec["route_id"] == "B"
    assert "Severe" in rec["reason"]


def test_no_travel_ranks_below_severe():
    no_travel = fake_route("A", 3600, [Risk.NO_TRAVEL, Risk.LOW])
    severe = fake_route("B", 3600, [Risk.SEVERE, Risk.SEVERE])
    assert services.recommend([no_travel, severe])["route_id"] == "B"


def test_high_miles_then_avg_risk_then_time():
    a = fake_route("A", 3600, [Risk.HIGH, Risk.LOW])
    b = fake_route("B", 3600, [Risk.MODERATE, Risk.MODERATE, Risk.MODERATE])
    assert services.recommend([a, b])["route_id"] == "B"

    c = fake_route("C", 3600, [Risk.MODERATE, Risk.LOW])
    d = fake_route("D", 3600, [Risk.LOW, Risk.LOW])
    assert services.recommend([c, d])["route_id"] == "D"

    e = fake_route("E", 4000, [Risk.LOW])
    f = fake_route("F", 3000, [Risk.LOW])
    rec = services.recommend([e, f])
    assert rec["route_id"] == "F" and "faster" in rec["reason"]


def test_all_routes_unsafe_is_flagged():
    a = fake_route("A", 3600, [Risk.NO_TRAVEL])
    b = fake_route("B", 3600, [Risk.NO_TRAVEL, Risk.NO_TRAVEL])
    rec = services.recommend([a, b])
    assert rec["route_id"] == "A"
    assert rec["reason"].startswith("No route is safe")


def test_showers_count_as_rain():
    fc = make_forecast(DEPART, wind=[5, 5], rain=[0.0, 0.1], snow=[0, 0])
    fc.series["showers"] = [0.0, 0.3]
    assert fc.at(DEPART + timedelta(minutes=10))["rain_in_hr"] == pytest.approx(0.4)


def test_unknown_miles_rank_worse_than_known_low():
    gappy = {"id": "A", "name": "A", "duration_s": 3000,
             "summary": services.summarize([{"represents_mi": 10, "risk": {"level": 0}}, {"represents_mi": 50}])}
    known = fake_route("B", 3600, [Risk.MODERATE] * 6)
    assert services.recommend([gappy, known])["route_id"] == "B"
