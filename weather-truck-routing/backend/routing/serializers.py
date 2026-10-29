from datetime import datetime, timedelta, timezone

from rest_framework import serializers

MAX_DEPARTURE_AHEAD = timedelta(days=13)  # leaves room for a multi-day trip inside the 16-day forecast


class LocationField(serializers.Field):
    """Accepts free text ("Dallas, TX") or {name, lat, lon} from the autocomplete."""

    def to_internal_value(self, data):
        if isinstance(data, str):
            if not data.strip():
                raise serializers.ValidationError("Location is required.")
            return data.strip()
        if isinstance(data, dict):
            try:
                lat, lon = float(data["lat"]), float(data["lon"])
            except (KeyError, TypeError, ValueError):
                raise serializers.ValidationError("Expected {name, lat, lon}.")
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise serializers.ValidationError("Coordinates out of range.")
            return {"name": str(data.get("name") or f"{lat:.4f}, {lon:.4f}"), "lat": lat, "lon": lon}
        raise serializers.ValidationError("Expected a string or {name, lat, lon}.")

    def to_representation(self, value):
        return value


def validate_departure(value: datetime) -> datetime:
    value = value.astimezone(timezone.utc)
    now = datetime.now(timezone.utc)
    if value < now - timedelta(hours=1):
        raise serializers.ValidationError("Departure can't be in the past (forecasts only look ahead).")
    if value > now + MAX_DEPARTURE_AHEAD:
        raise serializers.ValidationError("Departure must be within 13 days; forecasts don't reach further.")
    return value


class PlanRequestSerializer(serializers.Serializer):
    origin = LocationField()
    destination = LocationField()
    departure = serializers.DateTimeField(validators=[validate_departure])
    load_lb = serializers.FloatField(min_value=0, max_value=200_000)
    interval_mi = serializers.ChoiceField(choices=[10, 25, 50], default=25)
    apply_hos = serializers.BooleanField(default=True)


class HeatmapRequestSerializer(serializers.Serializer):
    # [[lat, lon], ...] — a thinned copy of the route geometries
    corridor = serializers.ListField(
        child=serializers.ListField(child=serializers.FloatField(), min_length=2, max_length=2),
        min_length=2,
        max_length=4000,
    )
    departure = serializers.DateTimeField(validators=[validate_departure])
    load_lb = serializers.FloatField(min_value=0, max_value=200_000)
