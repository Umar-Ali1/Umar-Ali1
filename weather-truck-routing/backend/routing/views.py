import logging

from rest_framework import status
from rest_framework.decorators import api_view
from rest_framework.response import Response

from . import providers, services
from .serializers import HeatmapRequestSerializer, PlanRequestSerializer

log = logging.getLogger(__name__)


def _upstream_error(exc: providers.ProviderError) -> Response:
    log.warning("provider error: %s", exc)
    return Response({"detail": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)


@api_view(["GET"])
def health(request):
    return Response({"status": "ok"})


@api_view(["GET"])
def geocode(request):
    q = request.query_params.get("q", "").strip()
    if len(q) < 3:
        return Response({"results": []})
    try:
        return Response({"results": providers.search_places(q, limit=5)})
    except providers.ProviderError as exc:
        return _upstream_error(exc)


@api_view(["POST"])
def plan(request):
    s = PlanRequestSerializer(data=request.data)
    s.is_valid(raise_exception=True)
    data = s.validated_data
    try:
        origin = data["origin"] if isinstance(data["origin"], dict) else providers.geocode(data["origin"])
        dest = (
            data["destination"] if isinstance(data["destination"], dict) else providers.geocode(data["destination"])
        )
        req = services.TripRequest(
            origin=origin,
            destination=dest,
            departure=data["departure"],
            load_lb=data["load_lb"],
            interval_mi=int(data["interval_mi"]),
            apply_hos=data["apply_hos"],
        )
        return Response(services.plan_trip(req))
    except providers.ProviderError as exc:
        return _upstream_error(exc)


@api_view(["POST"])
def heatmap(request):
    s = HeatmapRequestSerializer(data=request.data)
    s.is_valid(raise_exception=True)
    data = s.validated_data
    corridor = [(lon, lat) for lat, lon in data["corridor"]]
    try:
        return Response(services.corridor_heatmap(corridor, data["departure"], data["load_lb"]))
    except providers.ProviderError as exc:
        return _upstream_error(exc)
