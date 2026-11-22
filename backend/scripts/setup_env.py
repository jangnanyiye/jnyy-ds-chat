#!/usr/bin/env python3
"""交互式生成 /etc/ds-chat.env。

用法（服务器 root）：
    /opt/ds-chat/venv/bin/python /opt/ds-chat/scripts/setup_env.py
"""

from __future__ import annotations

import argparse
import getpass
import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.auth import hash_password  # noqa: E402


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", default="/etc/ds-chat.env")
    parser.add_argument(
        "--origin",
        default="",
        help="公开访问地址，例如 https://chat.example.com",
    )
    args = parser.parse_args()

    path = Path(args.env_file)
    existing = parse_env(path)

    print(f"写入 {path}")
    print("密码只用于生成哈希，不会保存明文。")

    password = getpass.getpass("新访问密码（至少 12 位）: ")
    if len(password) < 12:
        print("密码太短，至少 12 位。", file=sys.stderr)
        return 1
    confirm = getpass.getpass("再输一次: ")
    if password != confirm:
        print("两次输入不一致。", file=sys.stderr)
        return 1

    existing_key = existing.get("DEEPSEEK_API_KEY", "")
    key_hint = "已配置，直接回车保留" if existing_key else "sk-..."
    api_key = getpass.getpass(f"DeepSeek API Key（{key_hint}）: ").strip()
    if not api_key:
        api_key = existing_key
    if not api_key:
        print("API Key 不能为空。", file=sys.stderr)
        return 1

    session_secret = existing.get("SESSION_SECRET") or secrets.token_hex(32)
    origin = (args.origin or existing.get("PUBLIC_ORIGIN", "")).strip().rstrip("/")
    if not origin:
        origin = input("公开访问地址（如 https://chat.example.com）: ").strip().rstrip("/")
    if not origin:
        print("公开访问地址不能为空。", file=sys.stderr)
        return 1

    content = "\n".join(
        [
            "# DS Chat 运行配置，权限应为 640 root:dschat",
            f"DEEPSEEK_API_KEY={api_key}",
            f"DEEPSEEK_BASE_URL={existing.get('DEEPSEEK_BASE_URL', 'https://api.deepseek.com')}",
            f"APP_PASSWORD_HASH={hash_password(password)}",
            f"SESSION_SECRET={session_secret}",
            f"PUBLIC_ORIGIN={origin}",
            "DB_PATH=/var/lib/ds-chat/chat.db",
            "COOKIE_SECURE=true",
            "COOKIE_NAME=__Host-ds_session",
            "SESSION_TTL=2592000",
            "MAX_CONTEXT_CHARS=60000",
            "MAX_OUTPUT_TOKENS=8192",
            "UPSTREAM_TIMEOUT=1800",
            "",
        ]
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.chmod(tmp, 0o640)
    try:
        import grp
        import pwd

        uid = pwd.getpwnam("dschat").pw_uid
        gid = grp.getgrnam("dschat").gr_gid
        os.chown(tmp, uid, gid)
    except (KeyError, ImportError):
        pass
    tmp.replace(path)
    print("完成。执行 systemctl restart ds-chat 使配置生效。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
