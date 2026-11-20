from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_MODELS = ("deepseek-v4-pro", "deepseek-flash")
LEGACY_MODEL_ALIASES = {
    "deepseek-chat": "deepseek-v4-pro",
    "deepseek-reasoner": "deepseek-v4-pro",
}


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return int(raw)


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return float(raw)


@dataclass(frozen=True)
class Settings:
    db_path: Path
    deepseek_api_key: str
    password_hash: str
    session_secret: str
    deepseek_base_url: str = "https://api.deepseek.com"
    upload_dir: Path | None = None
    cookie_name: str = "__Host-ds_session"
    cookie_secure: bool = True
    session_ttl: int = 30 * 24 * 3600
    public_origin: str = ""
    allowed_models: tuple[str, ...] = DEFAULT_MODELS
    max_context_chars: int = 60_000
    max_output_tokens: int = 8_192
    upstream_timeout: float = 300.0
    debug: bool = False
    extra: dict = field(default_factory=dict, repr=False)

    def validate(self) -> None:
        if not self.deepseek_api_key:
            raise ValueError("DEEPSEEK_API_KEY 未配置")
        if not self.password_hash.startswith("scrypt$"):
            raise ValueError("APP_PASSWORD_HASH 格式不正确，应为 scrypt$...")
        if len(self.session_secret) < 32:
            raise ValueError("SESSION_SECRET 至少需要 32 个字符")
        if not self.allowed_models:
            raise ValueError("ALLOWED_MODELS 不能为空")
        if self.max_context_chars < 1000:
            raise ValueError("MAX_CONTEXT_CHARS 过小")
        if self.max_output_tokens < 128:
            raise ValueError("MAX_OUTPUT_TOKENS 过小")


def load_settings() -> Settings:
    db_path = Path(os.getenv("DB_PATH", "/var/lib/ds-chat/chat.db")).expanduser()
    cookie_secure = _env_bool("COOKIE_SECURE", True)
    cookie_name = os.getenv("COOKIE_NAME") or (
        "__Host-ds_session" if cookie_secure else "ds_session"
    )
    models_raw = os.getenv("ALLOWED_MODELS", ",".join(DEFAULT_MODELS))
    models = tuple(m.strip() for m in models_raw.split(",") if m.strip())
    public_origin = os.getenv("PUBLIC_ORIGIN", "").strip().rstrip("/")

    upload_dir = Path(
        os.getenv("UPLOAD_DIR", str(db_path.parent / "uploads"))
    ).expanduser()

    settings = Settings(
        db_path=db_path,
        deepseek_api_key=os.getenv("DEEPSEEK_API_KEY", "").strip(),
        password_hash=os.getenv("APP_PASSWORD_HASH", "").strip(),
        session_secret=os.getenv("SESSION_SECRET", "").strip(),
        deepseek_base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").strip().rstrip("/"),
        upload_dir=upload_dir,
        cookie_name=cookie_name,
        cookie_secure=cookie_secure,
        session_ttl=_env_int("SESSION_TTL", 30 * 24 * 3600),
        public_origin=public_origin,
        allowed_models=models or DEFAULT_MODELS,
        max_context_chars=_env_int("MAX_CONTEXT_CHARS", 60_000),
        max_output_tokens=_env_int("MAX_OUTPUT_TOKENS", 8_192),
        upstream_timeout=_env_float("UPSTREAM_TIMEOUT", 300.0),
        debug=_env_bool("DEBUG", False),
    )
    settings.validate()
    return settings
