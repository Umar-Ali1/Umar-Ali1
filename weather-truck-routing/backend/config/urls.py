from django.conf import settings
from django.http import FileResponse, Http404
from django.urls import path, re_path

from routing import views


def spa(request):
    """Serve the built React app for any non-API route (single-service deploys)."""
    index = settings.FRONTEND_DIST / "index.html"
    if not index.exists():
        raise Http404("Frontend not built")
    return FileResponse(open(index, "rb"), content_type="text/html")


urlpatterns = [
    path("api/health", views.health),
    path("api/geocode", views.geocode),
    path("api/plan", views.plan),
    path("api/heatmap", views.heatmap),
    re_path(r"^(?!api/).*$", spa),
]
