#!/usr/bin/env python3
"""生成 APP_PASSWORD_HASH，不把密码写进 shell 历史。"""

from __future__ import annotations

import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.auth import hash_password  # noqa: E402


def main() -> int:
    password = getpass.getpass("新密码（至少 12 位）: ")
    if len(password) < 12:
        print("密码太短，至少 12 位。", file=sys.stderr)
        return 1
    confirm = getpass.getpass("再输一次: ")
    if password != confirm:
        print("两次输入不一致。", file=sys.stderr)
        return 1
    print()
    print("APP_PASSWORD_HASH=" + hash_password(password))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
