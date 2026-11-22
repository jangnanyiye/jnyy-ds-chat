from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.auth import hash_password  # noqa: E402
from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

TEST_PASSWORD = "correct-horse-battery-staple"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        db_path=tmp_path / "test.db",
        deepseek_api_key="sk-test",
        password_hash=hash_password(TEST_PASSWORD),
        session_secret="s" * 64,
        cookie_secure=False,
        cookie_name="ds_session",
        public_origin="",
        debug=True,
    )


@pytest.fixture
def app(settings: Settings):
    return create_app(settings)


@pytest_asyncio.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def auth_client(client: httpx.AsyncClient):
    response = await client.post("/api/auth/login", json={"password": TEST_PASSWORD})
    assert response.status_code == 200, response.text
    return client
