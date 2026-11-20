from __future__ import annotations

from pathlib import Path

from app.db import Database


def test_conversation_and_message_crud(tmp_path: Path):
    db = Database(tmp_path / "chat.db")
    conversation = db.create_conversation("测试对话", "deepseek-chat")
    assert conversation["title"] == "测试对话"

    user = db.add_message(conversation["id"], "user", "你好")
    assistant = db.add_message(
        conversation["id"],
        "assistant",
        "你好！",
        parent_id=user["id"],
        reasoning="思考",
        status="complete",
    )
    assert user["role"] == "user"
    assert assistant["reasoning"] == "思考"

    listed = db.list_conversations()
    assert len(listed) == 1
    assert listed[0]["message_count"] == 2

    messages = db.list_messages(conversation["id"])
    assert [m["role"] for m in messages] == ["user", "assistant"]

    after = db.list_messages(conversation["id"], after_id=user["id"])
    assert len(after) == 1
    assert after[0]["id"] == assistant["id"]

    updated = db.update_message(assistant["id"], content="改过了", status="stopped")
    assert updated is not None
    assert updated["status"] == "stopped"

    assert db.delete_conversation(conversation["id"])
    assert db.get_conversation(conversation["id"]) is None
    assert db.list_messages(conversation["id"]) == []


def test_context_trimming_keeps_recent_and_starts_with_user(tmp_path: Path):
    db = Database(tmp_path / "chat.db")
    conversation = db.create_conversation("上下文", "deepseek-chat")
    first = db.add_message(conversation["id"], "user", "a" * 100)
    second = db.add_message(conversation["id"], "assistant", "b" * 100, parent_id=first["id"])
    third = db.add_message(conversation["id"], "user", "c" * 100, parent_id=second["id"])
    fourth = db.add_message(conversation["id"], "assistant", "d" * 100, parent_id=third["id"])
    db.add_message(conversation["id"], "user", "e" * 100, parent_id=fourth["id"])

    context = db.get_context(conversation["id"], max_chars=250)
    assert context
    assert context[0]["role"] == "user"
    assert context[-1]["content"] == "e" * 100
    assert sum(len(m["content"]) for m in context) <= 250


def test_include_last_returns_incremental_update(tmp_path: Path):
    db = Database(tmp_path / "chat.db")
    conversation = db.create_conversation("流式", "deepseek-chat")
    user = db.add_message(conversation["id"], "user", "问题")
    assistant = db.add_message(
        conversation["id"],
        "assistant",
        "第一段",
        parent_id=user["id"],
        status="streaming",
    )

    assert db.list_messages(conversation["id"], after_id=assistant["id"]) == []

    db.update_message(assistant["id"], content="第一段，第二段", status="complete")
    incremental = db.list_messages(
        conversation["id"], after_id=assistant["id"], include_last=True
    )
    assert len(incremental) == 1
    assert incremental[0]["id"] == assistant["id"]
    assert incremental[0]["content"] == "第一段，第二段"
    assert incremental[0]["status"] == "complete"


def test_branch_versions_and_activation(tmp_path: Path):
    db = Database(tmp_path / "chat.db")
    conversation = db.create_conversation("分支", "deepseek-chat")
    user1 = db.add_message(conversation["id"], "user", "原问题")
    assistant1 = db.add_message(
        conversation["id"], "assistant", "原回答", parent_id=user1["id"]
    )

    created = db.create_user_version(
        conversation["id"], user1["id"], "新问题", "deepseek-chat", title="新问题"
    )
    assert created is not None
    user2, _ = created
    assistant2 = db.add_message(
        conversation["id"], "assistant", "新回答", parent_id=user2["id"]
    )

    active = db.decorate_branches(conversation["id"], db.get_active_path(conversation["id"]))
    assert [message["content"] for message in active] == ["新问题", "新回答"]
    assert active[0]["version_count"] == 2
    assert active[0]["version_index"] == 2

    leaf1 = db.latest_leaf(conversation["id"], user1["id"])
    assert leaf1 == assistant1["id"]
    db.set_active_leaf(conversation["id"], leaf1)
    old_path = db.decorate_branches(
        conversation["id"], db.get_active_path(conversation["id"])
    )
    assert [message["content"] for message in old_path] == ["原问题", "原回答"]
    assert old_path[0]["version_index"] == 1

    # 重新生成：在同一个 user 下创建 assistant 兄弟版本，不删除旧回答。
    regenerated = db.add_message(
        conversation["id"], "assistant", "重答", parent_id=user1["id"]
    )
    path = db.decorate_branches(conversation["id"], db.get_active_path(conversation["id"]))
    assert [message["id"] for message in path] == [user1["id"], regenerated["id"]]
    assert path[1]["version_count"] == 2
    assert path[1]["version_index"] == 2


def test_search_finds_all_branches(tmp_path: Path):
    db = Database(tmp_path / "chat.db")
    conversation = db.create_conversation("苹果计划", "deepseek-chat")
    old_user = db.add_message(conversation["id"], "user", "旧分支里的香蕉")
    db.add_message(conversation["id"], "assistant", "旧回答", parent_id=old_user["id"])

    created = db.create_user_version(
        conversation["id"], old_user["id"], "新分支里的橙子", "deepseek-chat"
    )
    assert created is not None
    new_user, _ = created
    db.add_message(conversation["id"], "assistant", "新回答", parent_id=new_user["id"])

    assert db.search("苹果")[0]["conversation_title"] == "苹果计划"
    assert db.search("橙子")[0]["message_id"] == new_user["id"]
    old_matches = db.search("香蕉")
    assert old_matches
    assert old_matches[0]["message_id"] == old_user["id"]


def test_attachments_link_context_and_clone(tmp_path: Path):
    db = Database(tmp_path / "chat.db")
    conversation = db.create_conversation("附件", "deepseek-flash")
    attachment = db.create_attachment(
        file_id="file-api-test",
        filename="note.txt",
        mime="text/plain",
        size=12,
        kind="text",
        purpose="user_data",
        local_path=str(tmp_path / "note.txt"),
    )
    user = db.add_message(conversation["id"], "user", "看看附件")
    linked = db.link_attachments([attachment["id"]], conversation["id"], user["id"])
    assert linked[0]["filename"] == "note.txt"
    assert db.conversation_has_attachments(conversation["id"])

    context = db.get_context(conversation["id"])
    assert isinstance(context[0]["content"], list)
    assert context[0]["content"][0] == {"type": "text", "text": "看看附件"}
    assert context[0]["content"][1] == {"type": "file", "file_id": "file-api-test"}

    created = db.create_user_version(
        conversation["id"], user["id"], "改一下文字", "deepseek-flash"
    )
    assert created is not None
    new_user, _ = created
    cloned = db.clone_attachments(user["id"], new_user["id"], conversation["id"])
    assert len(cloned) == 1
    assert cloned[0]["id"] != attachment["id"]
    decorated = db.decorate_branches(
        conversation["id"], db.get_active_path(conversation["id"])
    )
    assert decorated[0]["attachments"][0]["filename"] == "note.txt"

    assert db.delete_conversation(conversation["id"])
    assert db.get_attachment(attachment["id"]) is None


def test_mark_interrupted(tmp_path: Path):
    db = Database(tmp_path / "chat.db")
    conversation = db.create_conversation("中断", "deepseek-chat")
    user = db.add_message(conversation["id"], "user", "问题")
    message = db.add_message(
        conversation["id"],
        "assistant",
        "半截",
        parent_id=user["id"],
        status="streaming",
    )
    assert db.mark_interrupted() == 1
    assert db.get_message(message["id"])["status"] == "interrupted"
