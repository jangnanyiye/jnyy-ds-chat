"""Uvicorn entry point: `uvicorn server:app` from the backend directory."""

from __future__ import annotations

from app.main import create_app

app = create_app()
