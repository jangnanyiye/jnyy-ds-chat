from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import string
import threading
import time
from dataclasses import dataclass

from fastapi import Request

SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(value: str) -> bytes:
    pad = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(value + pad)


def hash_password(password: str) -> str:
    if not password:
        raise ValueError("密码不能为空")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=SCRYPT_DKLEN,
    )
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64e(salt)}${_b64e(digest)}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt_b64, digest_b64 = encoded.split("$", 5)
        if scheme != "scrypt":
            return False
        salt = _b64d(salt_b64)
        expected = _b64d(digest_b64)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def generate_password(length: int = 24) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*"
    # 避免随机结果碰巧太弱：至少各取一个字符类别。
    chars = [
        secrets.choice(string.ascii_lowercase),
        secrets.choice(string.ascii_uppercase),
        secrets.choice(string.digits),
        secrets.choice("!@#$%^&*"),
    ]
    chars.extend(secrets.choice(alphabet) for _ in range(max(0, length - len(chars))))
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


def issue_session(secret: str, ttl: int) -> str:
    now = int(time.time())
    payload = {
        "exp": now + ttl,
        "iat": now,
        "v": 1,
        "jti": secrets.token_hex(8),
    }
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    body = _b64e(raw)
    signature = hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def verify_session(token: str | None, secret: str) -> bool:
    if not token or "." not in token:
        return False
    body, signature = token.rsplit(".", 1)
    expected = hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return False
    try:
        payload = json.loads(_b64d(body).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    if payload.get("v") != 1:
        return False
    exp = payload.get("exp")
    return isinstance(exp, int) and exp > int(time.time())


def parse_cookie(header: str | None, name: str) -> str | None:
    if not header:
        return None
    for part in header.split(";"):
        key, sep, value = part.strip().partition("=")
        if sep and key == name:
            return value
    return None


@dataclass
class _Bucket:
    failures: list[float]
    locked_until: float = 0.0


class LoginLimiter:
    """单进程内存限速。单用户场景下不需要 Redis。"""

    def __init__(
        self,
        *,
        max_attempts: int = 5,
        window_seconds: float = 600.0,
        lock_seconds: float = 60.0,
        global_max_attempts: int = 20,
        global_lock_seconds: float = 300.0,
    ):
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds
        self.lock_seconds = lock_seconds
        self.global_max_attempts = global_max_attempts
        self.global_lock_seconds = global_lock_seconds
        self._buckets: dict[str, _Bucket] = {}
        self._global: list[float] = []
        self._global_locked_until = 0.0
        self._lock = threading.Lock()

    def _prune(self, now: float) -> None:
        cutoff = now - self.window_seconds
        for key in list(self._buckets):
            bucket = self._buckets[key]
            bucket.failures = [ts for ts in bucket.failures if ts >= cutoff]
            if not bucket.failures and bucket.locked_until <= now:
                del self._buckets[key]
        self._global = [ts for ts in self._global if ts >= cutoff]

    def retry_after(self, key: str) -> int:
        now = time.monotonic()
        with self._lock:
            self._prune(now)
            if self._global_locked_until > now:
                return max(1, int(self._global_locked_until - now + 0.999))
            bucket = self._buckets.get(key)
            if bucket and bucket.locked_until > now:
                return max(1, int(bucket.locked_until - now + 0.999))
            return 0

    def record_failure(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            self._prune(now)
            bucket = self._buckets.setdefault(key, _Bucket([]))
            bucket.failures.append(now)
            if len(bucket.failures) >= self.max_attempts:
                bucket.locked_until = now + self.lock_seconds
                bucket.failures.clear()

            self._global.append(now)
            if len(self._global) >= self.global_max_attempts:
                self._global_locked_until = now + self.global_lock_seconds
                self._global.clear()

    def reset(self, key: str) -> None:
        with self._lock:
            self._buckets.pop(key, None)


def client_ip(request: Request) -> str:
    peer = request.client.host if request.client else ""
    if peer in {"127.0.0.1", "::1", "localhost"}:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",")[0].strip() or peer
        real_ip = request.headers.get("x-real-ip", "").strip()
        if real_ip:
            return real_ip
        ali_ip = request.headers.get("ali-cdn-real-ip", "").strip()
        if ali_ip:
            return ali_ip
    return peer or "unknown"


def origin_allowed(request: Request, public_origin: str, *, debug: bool = False) -> bool:
    """写接口的 CSRF 兜底校验；生产环境要求 Origin 与公开域名严格一致。"""
    if not public_origin:
        return True
    origin = (request.headers.get("origin") or "").strip().rstrip("/")
    if not origin:
        # 非浏览器客户端通常不带 Origin；SameSite=Lax + JSON 已提供主要保护。
        return True
    if origin == public_origin.rstrip("/"):
        return True
    if debug and (
        origin.startswith("http://127.0.0.1:")
        or origin.startswith("http://localhost:")
    ):
        return True
    return False
