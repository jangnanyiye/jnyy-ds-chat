#!/usr/bin/env python3
"""SQLite 在线备份，保留 7 天。"""

from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path

SOURCE = Path(os.getenv("DB_PATH", "/var/lib/ds-chat/chat.db"))
TARGET_DIR = Path(os.getenv("BACKUP_DIR", "/var/backups/ds-chat"))
KEEP_DAYS = int(os.getenv("BACKUP_KEEP_DAYS", "7"))


def main() -> int:
    if not SOURCE.exists():
        print(f"database not found: {SOURCE}")
        return 1

    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(TARGET_DIR, 0o700)
    target = TARGET_DIR / f"chat-{time.strftime('%Y%m%d-%H%M%S')}.db"

    source = sqlite3.connect(f"file:{SOURCE}?mode=ro", uri=True)
    try:
        dest = sqlite3.connect(target)
        try:
            source.backup(dest)
        finally:
            dest.close()
    finally:
        source.close()

    os.chmod(target, 0o600)
    print(f"backup written: {target}")

    cutoff = time.time() - KEEP_DAYS * 86_400
    for old in TARGET_DIR.glob("chat-*.db"):
        if old.stat().st_mtime < cutoff:
            old.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
