from __future__ import annotations

import json
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS system_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    system_prompt_id INTEGER,
    system_prompt_name TEXT NOT NULL DEFAULT '',
    system_prompt_text TEXT NOT NULL DEFAULT '',
    single_turn INTEGER NOT NULL DEFAULT 0,
    active_leaf_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    parent_id INTEGER,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL DEFAULT '',
    reasoning TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'complete'
        CHECK (status IN ('complete', 'streaming', 'stopped', 'error', 'interrupted')),
    error TEXT NOT NULL DEFAULT '',
    model TEXT,
    web_search INTEGER NOT NULL DEFAULT 0,
    thinking INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    reasoning_tokens INTEGER,
    cached_tokens INTEGER,
    sources_json TEXT NOT NULL DEFAULT '',
    annotations_json TEXT NOT NULL DEFAULT '',
    quotes_json TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    conversation_id INTEGER,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL,
    purpose TEXT NOT NULL,
    local_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);
"""

MESSAGE_COLUMNS = {
    "content",
    "reasoning",
    "status",
    "error",
    "model",
    "web_search",
    "thinking",
    "prompt_tokens",
    "completion_tokens",
    "reasoning_tokens",
    "cached_tokens",
    "sources_json",
    "annotations_json",
    "quotes_json",
}

VALID_STATUSES = {"complete", "streaming", "stopped", "error", "interrupted"}
_UNSET = object()


def parse_quotes(raw: str | None) -> list[dict[str, Any]]:
    try:
        values = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(values, list):
        return []
    quotes: list[dict[str, Any]] = []
    for value in values:
        if not isinstance(value, dict):
            continue
        role = value.get("role")
        content = value.get("content")
        if role not in {"user", "assistant"} or not isinstance(content, str):
            continue
        try:
            message_id = int(value.get("id"))
        except (TypeError, ValueError):
            continue
        quotes.append(
            {"id": message_id, "role": role, "content": content}
        )
    return quotes[:8]


def quote_prefix(quotes: list[dict[str, Any]]) -> str:
    if not quotes:
        return ""
    lines = ["以下是用户手动引用的历史上下文，仅用于辅助回答本轮问题：", ""]
    for index, quote in enumerate(quotes, start=1):
        label = "用户" if quote["role"] == "user" else "助手"
        lines.append(f"[引用 {index} · {label}]")
        lines.append(str(quote["content"]).strip())
        lines.append("")
    lines.append("[当前问题]")
    return "\n".join(lines)


def now_ms() -> int:
    return int(time.time() * 1000)


def public_conversation(
    row: dict[str, Any], *, include_prompt_text: bool = True
) -> dict[str, Any]:
    conversation = dict(row)
    conversation["single_turn"] = bool(conversation.get("single_turn"))
    if not include_prompt_text:
        conversation.pop("system_prompt_text", None)
    return conversation


def public_attachment(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "filename": row["filename"],
        "mime": row["mime"],
        "size": int(row["size"]),
        "kind": row["kind"],
        "url": f"/api/files/{row['id']}/content",
    }


class Database:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.init()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = NORMAL")
            conn.executescript(SCHEMA)
            self._migrate(conn)
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_parent "
                "ON messages(conversation_id, parent_id, id)"
            )

    @staticmethod
    def _migrate(conn: sqlite3.Connection) -> None:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(messages)")}
        added_parent = False
        if "parent_id" not in columns:
            conn.execute("ALTER TABLE messages ADD COLUMN parent_id INTEGER")
            added_parent = True
        for column in ("reasoning_tokens", "cached_tokens"):
            if column not in columns:
                conn.execute(f"ALTER TABLE messages ADD COLUMN {column} INTEGER")
        if "web_search" not in columns:
            conn.execute(
                "ALTER TABLE messages ADD COLUMN web_search INTEGER NOT NULL DEFAULT 0"
            )
        if "thinking" not in columns:
            conn.execute(
                "ALTER TABLE messages ADD COLUMN thinking INTEGER NOT NULL DEFAULT 0"
            )
        if "sources_json" not in columns:
            conn.execute(
                "ALTER TABLE messages ADD COLUMN sources_json TEXT NOT NULL DEFAULT ''"
            )
        if "annotations_json" not in columns:
            conn.execute(
                "ALTER TABLE messages ADD COLUMN annotations_json TEXT NOT NULL DEFAULT ''"
            )
        if "quotes_json" not in columns:
            conn.execute(
                "ALTER TABLE messages ADD COLUMN quotes_json TEXT NOT NULL DEFAULT ''"
            )

        # 旧模型收敛到新模型：chat -> V4-Pro，reasoner 另外保留“深度思考”标记。
        conn.execute(
            "UPDATE messages SET thinking = 1 WHERE model = 'deepseek-reasoner' AND thinking = 0"
        )
        conn.execute(
            "UPDATE messages SET model = 'deepseek-v4-pro' WHERE model IN ('deepseek-chat', 'deepseek-reasoner')"
        )
        conn.execute(
            "UPDATE conversations SET model = 'deepseek-v4-pro' WHERE model IN ('deepseek-chat', 'deepseek-reasoner')"
        )

        conversation_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(conversations)")
        }
        if "active_leaf_id" not in conversation_columns:
            conn.execute("ALTER TABLE conversations ADD COLUMN active_leaf_id INTEGER")
        if "system_prompt_id" not in conversation_columns:
            conn.execute("ALTER TABLE conversations ADD COLUMN system_prompt_id INTEGER")
        if "system_prompt_name" not in conversation_columns:
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN system_prompt_name TEXT NOT NULL DEFAULT ''"
            )
        if "system_prompt_text" not in conversation_columns:
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN system_prompt_text TEXT NOT NULL DEFAULT ''"
            )
        if "single_turn" not in conversation_columns:
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN single_turn INTEGER NOT NULL DEFAULT 0"
            )

        # 旧数据把提示词快照补齐；之后提示词库修改/删除不再影响已有对话。
        conn.execute(
            """
            UPDATE conversations
            SET system_prompt_name = COALESCE(
                    (SELECT name FROM system_prompts WHERE id = conversations.system_prompt_id),
                    system_prompt_name
                ),
                system_prompt_text = COALESCE(
                    (SELECT content FROM system_prompts WHERE id = conversations.system_prompt_id),
                    system_prompt_text
                )
            WHERE system_prompt_id IS NOT NULL
              AND (system_prompt_name = '' OR system_prompt_text = '')
            """
        )

        # 旧数据库是线性消息：按 id 顺序补 parent_id，并把最后一条设为活动叶子。
        if added_parent:
            conn.execute(
                """
                UPDATE messages
                SET parent_id = (
                    SELECT previous.id
                    FROM messages previous
                    WHERE previous.conversation_id = messages.conversation_id
                      AND previous.id < messages.id
                    ORDER BY previous.id DESC
                    LIMIT 1
                )
                WHERE parent_id IS NULL
                """
            )
            conn.execute(
                """
                UPDATE conversations
                SET active_leaf_id = (
                    SELECT MAX(message.id)
                    FROM messages message
                    WHERE message.conversation_id = conversations.id
                )
                """
            )

    def ping(self) -> bool:
        with self.connect() as conn:
            conn.execute("SELECT 1").fetchone()
        return True

    # ------------------------------------------------------------------
    # system prompts
    # ------------------------------------------------------------------

    def list_prompts(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM system_prompts ORDER BY updated_at DESC, id DESC"
            ).fetchall()
        return [dict(row) for row in rows]

    def get_prompt(self, prompt_id: int) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM system_prompts WHERE id = ?", (prompt_id,)
            ).fetchone()
        return dict(row) if row else None

    def create_prompt(self, name: str, content: str) -> dict[str, Any]:
        ts = now_ms()
        with self.connect() as conn:
            cur = conn.execute(
                "INSERT INTO system_prompts (name, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (name, content, ts, ts),
            )
            prompt_id = int(cur.lastrowid)
        prompt = self.get_prompt(prompt_id)
        assert prompt is not None
        return prompt

    def update_prompt(
        self, prompt_id: int, *, name: str | None = None, content: str | None = None
    ) -> dict[str, Any] | None:
        fields: list[str] = []
        values: list[Any] = []
        if name is not None:
            fields.append("name = ?")
            values.append(name)
        if content is not None:
            fields.append("content = ?")
            values.append(content)
        if not fields:
            return self.get_prompt(prompt_id)
        fields.append("updated_at = ?")
        values.append(now_ms())
        values.append(prompt_id)
        with self.connect() as conn:
            cur = conn.execute(
                f"UPDATE system_prompts SET {', '.join(fields)} WHERE id = ?", values
            )
            if cur.rowcount == 0:
                return None
        return self.get_prompt(prompt_id)

    def delete_prompt(self, prompt_id: int) -> bool:
        with self.connect() as conn:
            # 空对话还没有上下文，直接清掉快照；已开始对话保留快照，避免前后割裂。
            conn.execute(
                """
                UPDATE conversations
                SET system_prompt_id = NULL,
                    system_prompt_name = '',
                    system_prompt_text = ''
                WHERE system_prompt_id = ?
                  AND NOT EXISTS (
                      SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id
                  )
                """,
                (prompt_id,),
            )
            conn.execute(
                "UPDATE conversations SET system_prompt_id = NULL WHERE system_prompt_id = ?",
                (prompt_id,),
            )
            cur = conn.execute(
                "DELETE FROM system_prompts WHERE id = ?", (prompt_id,)
            )
            return cur.rowcount > 0

    # ------------------------------------------------------------------
    # conversations
    # ------------------------------------------------------------------

    def create_conversation(
        self,
        title: str,
        model: str,
        *,
        system_prompt_id: int | None = None,
        system_prompt_name: str = "",
        system_prompt_text: str = "",
        single_turn: bool = False,
    ) -> dict[str, Any]:
        ts = now_ms()
        with self.connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO conversations
                    (title, model, system_prompt_id, system_prompt_name, system_prompt_text, single_turn, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    title or "新对话",
                    model,
                    system_prompt_id,
                    system_prompt_name,
                    system_prompt_text,
                    1 if single_turn else 0,
                    ts,
                    ts,
                ),
            )
            conv_id = int(cur.lastrowid)
        conversation = self.get_conversation(conv_id)
        assert conversation is not None
        return conversation

    def get_conversation(self, conversation_id: int) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
        return public_conversation(row) if row else None

    def list_conversations(
        self, limit: int = 200, offset: int = 0
    ) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT c.*,
                       COALESCE(
                           (
                               SELECT substr(replace(replace(lm.content, char(10), ' '), char(13), ' '), 1, 100)
                               FROM messages lm
                               WHERE lm.id = c.active_leaf_id
                           ),
                           (
                               SELECT substr(replace(replace(content, char(10), ' '), char(13), ' '), 1, 100)
                               FROM messages m
                               WHERE m.conversation_id = c.id
                               ORDER BY m.id DESC
                               LIMIT 1
                           )
                       ) AS preview,
                       (
                           SELECT count(*)
                           FROM messages m
                           WHERE m.conversation_id = c.id
                       ) AS message_count
                FROM conversations c
                ORDER BY c.updated_at DESC, c.id DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ).fetchall()
        return [public_conversation(row, include_prompt_text=False) for row in rows]

    def conversation_count(self) -> int:
        with self.connect() as conn:
            row = conn.execute("SELECT count(*) AS count FROM conversations").fetchone()
        return int(row["count"]) if row else 0

    def update_conversation(
        self,
        conversation_id: int,
        *,
        title: str | None = None,
        model: str | None = None,
        system_prompt_id: int | None | object = _UNSET,
        system_prompt_name: str | None | object = _UNSET,
        system_prompt_text: str | None | object = _UNSET,
        single_turn: bool | None = None,
    ) -> dict[str, Any] | None:
        fields: list[str] = []
        values: list[Any] = []
        if title is not None:
            fields.append("title = ?")
            values.append(title)
        if model is not None:
            fields.append("model = ?")
            values.append(model)
        if system_prompt_id is not _UNSET:
            fields.append("system_prompt_id = ?")
            values.append(system_prompt_id)
        if system_prompt_name is not _UNSET:
            fields.append("system_prompt_name = ?")
            values.append(system_prompt_name)
        if system_prompt_text is not _UNSET:
            fields.append("system_prompt_text = ?")
            values.append(system_prompt_text)
        if single_turn is not None:
            fields.append("single_turn = ?")
            values.append(1 if single_turn else 0)
        if not fields:
            return self.get_conversation(conversation_id)
        fields.append("updated_at = ?")
        values.append(now_ms())
        values.append(conversation_id)
        with self.connect() as conn:
            conn.execute(
                f"UPDATE conversations SET {', '.join(fields)} WHERE id = ?", values
            )
        return self.get_conversation(conversation_id)

    def touch_conversation(self, conversation_id: int) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (now_ms(), conversation_id),
            )

    def delete_conversation(self, conversation_id: int) -> bool:
        with self.connect() as conn:
            cur = conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
            return cur.rowcount > 0

    # ------------------------------------------------------------------
    # messages
    # ------------------------------------------------------------------

    def add_message(
        self,
        conversation_id: int,
        role: str,
        content: str = "",
        *,
        parent_id: int | None = None,
        reasoning: str = "",
        status: str = "complete",
        error: str = "",
        model: str | None = None,
        web_search: bool = False,
        thinking: bool = False,
        quotes: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if role not in {"user", "assistant"}:
            raise ValueError(f"invalid role: {role}")
        if status not in VALID_STATUSES:
            raise ValueError(f"invalid status: {status}")
        ts = now_ms()
        with self.connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO messages
                    (conversation_id, parent_id, role, content, reasoning, status, error, model, web_search, thinking, quotes_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    conversation_id,
                    parent_id,
                    role,
                    content,
                    reasoning,
                    status,
                    error,
                    model,
                    1 if web_search else 0,
                    1 if thinking else 0,
                    json.dumps(quotes or [], ensure_ascii=False) if quotes else "",
                    ts,
                    ts,
                ),
            )
            message_id = int(cur.lastrowid)
            conn.execute(
                "UPDATE conversations SET active_leaf_id = ?, updated_at = ? WHERE id = ?",
                (message_id, ts, conversation_id),
            )
        message = self.get_message(message_id)
        assert message is not None
        return message

    def get_message(self, message_id: int) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
        return dict(row) if row else None

    def get_messages_by_ids(
        self, conversation_id: int, message_ids: list[int]
    ) -> dict[int, dict[str, Any]]:
        unique_ids = list(dict.fromkeys(message_ids))
        if not unique_ids:
            return {}
        placeholders = ",".join("?" for _ in unique_ids)
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM messages WHERE conversation_id = ? AND id IN ({placeholders})",
                [conversation_id, *unique_ids],
            ).fetchall()
        return {int(row["id"]): dict(row) for row in rows}

    def list_messages(
        self,
        conversation_id: int,
        *,
        after_id: int = 0,
        limit: int = 2000,
        include_last: bool = False,
    ) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM messages
                WHERE conversation_id = ? AND id > ?
                ORDER BY id ASC
                LIMIT ?
                """,
                (conversation_id, after_id, limit),
            ).fetchall()
            messages = [dict(row) for row in rows]

            # 增量轮询时，最后一条消息可能正在流式更新，id 不会变大。
            # 把它额外带回去，客户端才能持续拿到同一个 assistant 消息的最新内容。
            if include_last and after_id > 0:
                last = conn.execute(
                    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1",
                    (conversation_id,),
                ).fetchone()
                if last and int(last["id"]) <= after_id:
                    messages.append(dict(last))
        return messages

    def get_active_path(
        self, conversation_id: int, leaf_id: int | None = None
    ) -> list[dict[str, Any]]:
        """从活动叶子沿 parent_id 向上走，返回当前展示的消息路径。"""
        with self.connect() as conn:
            if leaf_id is None:
                conversation = conn.execute(
                    "SELECT active_leaf_id FROM conversations WHERE id = ?",
                    (conversation_id,),
                ).fetchone()
                if conversation:
                    leaf_id = conversation["active_leaf_id"]
                if leaf_id is None:
                    last = conn.execute(
                        "SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1",
                        (conversation_id,),
                    ).fetchone()
                    leaf_id = last["id"] if last else None

            path: list[dict[str, Any]] = []
            seen: set[int] = set()
            current = leaf_id
            while current is not None and current not in seen:
                seen.add(int(current))
                row = conn.execute(
                    "SELECT * FROM messages WHERE id = ? AND conversation_id = ?",
                    (current, conversation_id),
                ).fetchone()
                if not row:
                    break
                item = dict(row)
                path.append(item)
                current = item["parent_id"]
        path.reverse()
        return path

    def decorate_branches(
        self, conversation_id: int, messages: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """给路径上的每条消息补充同父同角色的版本信息，供 < 1/2 > 切换。"""
        with self.connect() as conn:
            message_ids = [int(message["id"]) for message in messages]
            attachments_by_message: dict[int, list[dict[str, Any]]] = {}
            if message_ids:
                placeholders = ",".join("?" for _ in message_ids)
                attachment_rows = conn.execute(
                    f"SELECT * FROM attachments WHERE message_id IN ({placeholders}) ORDER BY created_at",
                    message_ids,
                ).fetchall()
                for row in attachment_rows:
                    attachments_by_message.setdefault(
                        int(row["message_id"]), []
                    ).append(public_attachment(dict(row)))

            for message in messages:
                message["attachments"] = attachments_by_message.get(
                    int(message["id"]), []
                )
                if message["parent_id"] is None:
                    siblings = conn.execute(
                        """
                        SELECT id FROM messages
                        WHERE conversation_id = ? AND parent_id IS NULL AND role = ?
                        ORDER BY id ASC
                        """,
                        (conversation_id, message["role"]),
                    ).fetchall()
                else:
                    siblings = conn.execute(
                        """
                        SELECT id FROM messages
                        WHERE conversation_id = ? AND parent_id = ? AND role = ?
                        ORDER BY id ASC
                        """,
                        (conversation_id, message["parent_id"], message["role"]),
                    ).fetchall()
                version_ids = [int(row["id"]) for row in siblings]
                message["version_ids"] = version_ids
                message["version_count"] = len(version_ids)
                try:
                    message["version_index"] = version_ids.index(int(message["id"])) + 1
                except ValueError:
                    message["version_count"] = 1
                    message["version_index"] = 1
                    message["version_ids"] = [int(message["id"])]

                message["web_search"] = bool(message.get("web_search"))
                message["thinking"] = bool(message.get("thinking"))
                for key in ("sources", "annotations"):
                    raw = message.pop(f"{key}_json", "") or ""
                    try:
                        message[key] = json.loads(raw) if raw else []
                    except (TypeError, ValueError):
                        message[key] = []
                message["quotes"] = parse_quotes(message.pop("quotes_json", ""))
        return messages

    def latest_leaf(self, conversation_id: int, message_id: int) -> int | None:
        """选择某个版本后，优先落在它子树里最新的叶子节点上。"""
        with self.connect() as conn:
            row = conn.execute(
                """
                WITH RECURSIVE subtree(id) AS (
                    SELECT id FROM messages WHERE id = ? AND conversation_id = ?
                    UNION ALL
                    SELECT m.id
                    FROM messages m
                    JOIN subtree s ON m.parent_id = s.id
                    WHERE m.conversation_id = ?
                )
                SELECT id FROM messages
                WHERE id IN (SELECT id FROM subtree)
                ORDER BY id DESC
                LIMIT 1
                """,
                (message_id, conversation_id, conversation_id),
            ).fetchone()
        return int(row["id"]) if row else None

    def set_active_leaf(self, conversation_id: int, leaf_id: int) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE conversations SET active_leaf_id = ?, updated_at = ? WHERE id = ?",
                (leaf_id, now_ms(), conversation_id),
            )

    def get_last_message(self, conversation_id: int) -> dict[str, Any] | None:
        path = self.get_active_path(conversation_id)
        return path[-1] if path else None

    def update_message(self, message_id: int, **fields: Any) -> dict[str, Any] | None:
        unknown = set(fields) - MESSAGE_COLUMNS
        if unknown:
            raise ValueError(f"cannot update columns: {sorted(unknown)}")
        if "status" in fields and fields["status"] not in VALID_STATUSES:
            raise ValueError(f"invalid status: {fields['status']}")
        if not fields:
            return self.get_message(message_id)

        assignments = [f"{name} = ?" for name in fields]
        values = list(fields.values())
        assignments.append("updated_at = ?")
        values.append(now_ms())
        values.append(message_id)
        with self.connect() as conn:
            cur = conn.execute(
                f"UPDATE messages SET {', '.join(assignments)} WHERE id = ?", values
            )
            if cur.rowcount == 0:
                return None
        return self.get_message(message_id)

    def create_user_version(
        self,
        conversation_id: int,
        source_message_id: int,
        content: str,
        model: str,
        *,
        title: str | None = None,
        quotes_json: str | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]] | None:
        """编辑用户消息时创建一个同父的新版本，旧分支完整保留。"""
        ts = now_ms()
        with self.connect() as conn:
            source = conn.execute(
                "SELECT * FROM messages WHERE id = ? AND conversation_id = ?",
                (source_message_id, conversation_id),
            ).fetchone()
            if not source or source["role"] != "user":
                return None

            parent_id = source["parent_id"]
            cur = conn.execute(
                """
                INSERT INTO messages
                    (conversation_id, parent_id, role, content, reasoning, status, error, model, quotes_json, created_at, updated_at)
                VALUES (?, ?, 'user', ?, '', 'complete', '', ?, ?, ?, ?)
                """,
                (
                    conversation_id,
                    parent_id,
                    content,
                    model,
                    source["quotes_json"] if quotes_json is None else quotes_json,
                    ts,
                    ts,
                ),
            )
            new_message_id = int(cur.lastrowid)

            fields = ["model = ?", "active_leaf_id = ?", "updated_at = ?"]
            values: list[Any] = [model, new_message_id, ts]
            # 编辑第一条消息才更新会话标题；编辑中间消息不改变标题。
            if parent_id is None and title:
                fields.append("title = ?")
                values.append(title)
            values.append(conversation_id)
            conn.execute(
                f"UPDATE conversations SET {', '.join(fields)} WHERE id = ?",
                values,
            )

        message = self.get_message(new_message_id)
        conversation = self.get_conversation(conversation_id)
        if not message or not conversation:
            return None
        return message, conversation

    def delete_message(self, message_id: int) -> bool:
        with self.connect() as conn:
            cur = conn.execute("DELETE FROM messages WHERE id = ?", (message_id,))
            return cur.rowcount > 0

    def create_attachment(
        self,
        *,
        file_id: str,
        filename: str,
        mime: str,
        size: int,
        kind: str,
        purpose: str,
        local_path: str,
    ) -> dict[str, Any]:
        attachment_id = uuid.uuid4().hex
        ts = now_ms()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO attachments
                    (id, conversation_id, message_id, file_id, filename, mime, size, kind, purpose, local_path, created_at)
                VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    attachment_id,
                    file_id,
                    filename,
                    mime,
                    size,
                    kind,
                    purpose,
                    local_path,
                    ts,
                ),
            )
        attachment = self.get_attachment(attachment_id)
        assert attachment is not None
        return public_attachment(attachment)

    def get_attachment(self, attachment_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM attachments WHERE id = ?", (attachment_id,)
            ).fetchone()
        return dict(row) if row else None

    def get_pending_attachments(self, attachment_ids: list[str]) -> list[dict[str, Any]]:
        if not attachment_ids:
            return []
        placeholders = ",".join("?" for _ in attachment_ids)
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM attachments WHERE id IN ({placeholders}) AND message_id IS NULL",
                attachment_ids,
            ).fetchall()
        return [dict(row) for row in rows]

    def link_attachments(
        self,
        attachment_ids: list[str],
        conversation_id: int,
        message_id: int,
    ) -> list[dict[str, Any]]:
        if not attachment_ids:
            return []
        unique_ids = list(dict.fromkeys(attachment_ids))
        placeholders = ",".join("?" for _ in unique_ids)
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM attachments WHERE id IN ({placeholders}) AND message_id IS NULL",
                unique_ids,
            ).fetchall()
            if len(rows) != len(unique_ids):
                raise ValueError("附件不存在或已被使用")
            conn.execute(
                f"UPDATE attachments SET conversation_id = ?, message_id = ? WHERE id IN ({placeholders})",
                [conversation_id, message_id, *unique_ids],
            )
        return [public_attachment(row) for row in rows]

    def clone_attachments(
        self,
        source_message_id: int,
        target_message_id: int,
        conversation_id: int,
    ) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at",
                (source_message_id,),
            ).fetchall()
            ts = now_ms()
            cloned: list[dict[str, Any]] = []
            for row in rows:
                new_id = uuid.uuid4().hex
                conn.execute(
                    """
                    INSERT INTO attachments
                        (id, conversation_id, message_id, file_id, filename, mime, size, kind, purpose, local_path, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        new_id,
                        conversation_id,
                        target_message_id,
                        row["file_id"],
                        row["filename"],
                        row["mime"],
                        row["size"],
                        row["kind"],
                        row["purpose"],
                        row["local_path"],
                        ts,
                    ),
                )
                cloned.append(public_attachment({**dict(row), "id": new_id}))
        return cloned

    def get_attachments_for_messages(
        self, message_ids: list[int]
    ) -> dict[int, list[dict[str, Any]]]:
        if not message_ids:
            return {}
        placeholders = ",".join("?" for _ in message_ids)
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM attachments WHERE message_id IN ({placeholders}) ORDER BY created_at",
                message_ids,
            ).fetchall()
        result: dict[int, list[dict[str, Any]]] = {}
        for row in rows:
            result.setdefault(int(row["message_id"]), []).append(public_attachment(row))
        return result

    def conversation_has_attachments(self, conversation_id: int) -> bool:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM attachments WHERE conversation_id = ? LIMIT 1",
                (conversation_id,),
            ).fetchone()
        return row is not None

    def list_attachments_for_conversation(
        self, conversation_id: int
    ) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM attachments WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_old_pending_attachments(self, older_than_ms: int) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM attachments WHERE message_id IS NULL AND created_at < ?",
                (older_than_ms,),
            ).fetchall()
        return [dict(row) for row in rows]

    def delete_attachment(self, attachment_id: str) -> bool:
        with self.connect() as conn:
            cur = conn.execute("DELETE FROM attachments WHERE id = ?", (attachment_id,))
            return cur.rowcount > 0

    def message_count(self, conversation_id: int) -> int:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT count(*) AS n FROM messages WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        return int(row["n"]) if row else 0

    def search(
        self, query: str, limit: int = 40, offset: int = 0
    ) -> tuple[list[dict[str, Any]], bool]:
        """搜索所有分支；点击结果时由前端激活命中的分支。"""
        needle = query.strip().lower()
        if not needle:
            return [], False

        def snippet(text: str, radius: int = 48) -> str:
            compact = re.sub(r"\s+", " ", text or "").strip()
            index = compact.lower().find(needle)
            if index < 0:
                return compact[: radius * 2]
            start = max(0, index - radius)
            end = min(len(compact), index + len(needle) + radius)
            return ("…" if start else "") + compact[start:end] + ("…" if end < len(compact) else "")

        results: list[dict[str, Any]] = []
        with self.connect() as conn:
            conversations = conn.execute(
                "SELECT * FROM conversations ORDER BY updated_at DESC, id DESC LIMIT 200"
            ).fetchall()
            for conversation in conversations:
                messages = conn.execute(
                    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC",
                    (conversation["id"],),
                ).fetchall()
                title_match = needle in str(conversation["title"]).lower()
                matched = [
                    message
                    for message in messages
                    if needle in str(message["content"] or "").lower()
                ]

                if matched:
                    for message in matched:
                        results.append(
                            {
                                "conversation_id": int(conversation["id"]),
                                "conversation_title": conversation["title"],
                                "message_id": int(message["id"]),
                                "role": message["role"],
                                "snippet": snippet(str(message["content"] or "")),
                                "updated_at": conversation["updated_at"],
                            }
                        )
                elif title_match:
                    results.append(
                        {
                            "conversation_id": int(conversation["id"]),
                            "conversation_title": conversation["title"],
                            "message_id": None,
                            "role": None,
                            "snippet": "会话标题匹配",
                            "updated_at": conversation["updated_at"],
                        }
                    )

                if len(results) >= offset + limit + 1:
                    break

        has_more = len(results) > offset + limit
        return results[offset : offset + limit], has_more

    def has_streaming_message(self, conversation_id: int) -> bool:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM messages WHERE conversation_id = ? AND status = 'streaming' LIMIT 1",
                (conversation_id,),
            ).fetchone()
        return row is not None

    def mark_interrupted(self) -> int:
        """服务器重启后，把未完成的流标记为中断，避免界面一直显示“生成中”。"""
        with self.connect() as conn:
            cur = conn.execute(
                "UPDATE messages SET status = 'interrupted', updated_at = ? WHERE status = 'streaming'",
                (now_ms(),),
            )
        return cur.rowcount

    # ------------------------------------------------------------------
    # context
    # ------------------------------------------------------------------

    def get_context(
        self,
        conversation_id: int,
        max_chars: int = 60_000,
        *,
        leaf_id: int | None = None,
        single_turn: bool = False,
    ) -> list[dict[str, Any]]:
        full_path = self.get_active_path(conversation_id, leaf_id=leaf_id)
        last_user_id = next(
            (
                int(message["id"])
                for message in reversed(full_path)
                if message["role"] == "user"
            ),
            None,
        )
        path = full_path[-1:] if single_turn and full_path else full_path
        message_ids = [int(message["id"]) for message in path]
        files_by_message: dict[int, list[str]] = {}
        if message_ids:
            placeholders = ",".join("?" for _ in message_ids)
            with self.connect() as conn:
                attachment_rows = conn.execute(
                    f"SELECT message_id, file_id FROM attachments WHERE message_id IN ({placeholders}) ORDER BY created_at",
                    message_ids,
                ).fetchall()
            for row in attachment_rows:
                files_by_message.setdefault(int(row["message_id"]), []).append(
                    str(row["file_id"])
                )

        rows = [
            message
            for message in path
            if (message["content"] or files_by_message.get(int(message["id"])))
            and (message["role"] == "user" or message["status"] in ("complete", "stopped"))
        ]

        def text_length(content: Any) -> int:
            if isinstance(content, str):
                return len(content)
            if isinstance(content, list):
                return sum(
                    len(str(part.get("text", "")))
                    for part in content
                    if isinstance(part, dict)
                )
            return 0

        selected: list[dict[str, Any]] = []
        total = 0
        for row in reversed(rows):
            text = str(row["content"])
            if int(row["id"]) == last_user_id:
                quotes = parse_quotes(row.get("quotes_json", ""))
                if quotes:
                    prefix = quote_prefix(quotes)
                    text = f"{prefix}\n\n{text}" if text else prefix
            file_ids = files_by_message.get(int(row["id"])) or []
            if file_ids:
                content: Any = []
                if text:
                    content.append({"type": "text", "text": text})
                for file_id in file_ids:
                    content.append({"type": "file", "file_id": file_id})
            else:
                content = text
            length = text_length(content)
            if selected and total + length > max_chars:
                break
            selected.append({"role": str(row["role"]), "content": content})
            total += length
            if len(selected) >= 80:
                break
        selected.reverse()

        # 裁剪后如果第一条是 assistant，去掉它，尽量让上下文从 user 开始。
        if selected and selected[0]["role"] == "assistant":
            selected.pop(0)
        return selected
