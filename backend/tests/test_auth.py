from __future__ import annotations

from app.auth import (
    LoginLimiter,
    generate_password,
    hash_password,
    issue_session,
    verify_password,
    verify_session,
)


def test_password_roundtrip():
    encoded = hash_password("a strong password")
    assert encoded.startswith("scrypt$")
    assert verify_password("a strong password", encoded)
    assert not verify_password("wrong", encoded)
    assert not verify_password("a strong password", "garbage")


def test_generate_password():
    value = generate_password(24)
    assert len(value) == 24
    assert any(c.islower() for c in value)
    assert any(c.isupper() for c in value)
    assert any(c.isdigit() for c in value)


def test_session_roundtrip_and_tamper():
    token = issue_session("x" * 64, 3600)
    assert verify_session(token, "x" * 64)
    assert not verify_session(token, "y" * 64)
    assert not verify_session(token + "a", "x" * 64)
    assert not verify_session(None, "x" * 64)


def test_session_expiry():
    token = issue_session("x" * 64, -1)
    assert not verify_session(token, "x" * 64)


def test_login_limiter_locks():
    limiter = LoginLimiter(max_attempts=2, window_seconds=60, lock_seconds=10)
    assert limiter.retry_after("1.2.3.4") == 0
    limiter.record_failure("1.2.3.4")
    assert limiter.retry_after("1.2.3.4") == 0
    limiter.record_failure("1.2.3.4")
    assert limiter.retry_after("1.2.3.4") >= 1
    limiter.reset("1.2.3.4")
    assert limiter.retry_after("1.2.3.4") == 0
