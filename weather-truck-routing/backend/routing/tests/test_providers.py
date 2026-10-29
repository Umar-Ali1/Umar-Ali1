import pytest

from routing import providers


def test_osrm_multi_leg_drops_repeated_via_vertex_only():
    # Leg 1 has a genuine repeated vertex (zero-length segment); leg 2 starts at the via point.
    route = {
        "distance": 30,
        "duration": 3,
        "geometry": {"coordinates": [[0, 0], [0, 1], [0, 1], [0, 2], [0, 2], [0, 3]]},
        "legs": [
            {"annotation": {"distance": [10, 0, 10], "duration": [1, 0, 1]}},
            {"annotation": {"distance": [10], "duration": [1]}},
        ],
    }
    out = providers.parse_osrm_route(route)
    assert out["coords"] == [(0, 0), (0, 1), (0, 1), (0, 2), (0, 3)]
    assert len(out["seg_distance_m"]) == len(out["coords"]) - 1


def test_osrm_misaligned_geometry_is_an_error():
    route = {
        "distance": 1,
        "duration": 1,
        "geometry": {"coordinates": [[0, 0], [0, 1], [0, 2]]},
        "legs": [{"annotation": {"distance": [10], "duration": [1]}}],
    }
    with pytest.raises(providers.ProviderError):
        providers.parse_osrm_route(route)


def test_ors_step_durations_spread_by_length():
    feature = {
        "geometry": {"coordinates": [[0, 0], [0, 1], [0, 3], [0, 4]]},
        "properties": {
            "summary": {"distance": 444_780, "duration": 400},
            "segments": [
                {"steps": [{"duration": 300, "way_points": [0, 2]}, {"duration": 100, "way_points": [2, 3]}]}
            ],
        },
    }
    out = providers.parse_ors_feature(feature)
    assert out["seg_duration_s"] == pytest.approx([100, 200, 100], rel=1e-3)
    assert out["duration_s"] == 400


def test_ors_used_when_key_present(settings, monkeypatch):
    settings.ORS_API_KEY = "k"
    called = {}
    monkeypatch.setattr(providers, "ors_routes", lambda w, a, l: called.setdefault("ors", (a, l)) and [])
    providers.routes([(0, 0), (1, 1)], alternatives=3, load_lb=40_000)
    assert called["ors"] == (3, 40_000)
