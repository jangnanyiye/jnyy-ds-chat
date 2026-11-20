from __future__ import annotations

import json

import pytest

import app.main as main_module
from app.deepseek import StreamChunk


@pytest.mark.asyncio
async def test_login_session_logout(client, access_password):
    assert (await client.get("/api/auth/session")).json() == {"authenticated": False}

    bad = await client.post("/api/auth/login", json={"password": "wrong"})
    assert bad.status_code == 401

    ok = await client.post("/api/auth/login", json={"password": access_password})
    assert ok.status_code == 200
    assert (await client.get("/api/auth/session")).json() == {"authenticated": True}

    out = await client.post("/api/auth/logout")
    assert out.status_code == 200
    assert (await client.get("/api/auth/session")).json() == {"authenticated": False}


@pytest.mark.asyncio
async def test_conversation_crud_requires_auth(client, access_password):
    assert (await client.get("/api/conversations")).status_code == 401
    login = await client.post(
        "/api/auth/login", json={"password": access_password}
    )
    assert login.status_code == 200
    auth_client = client

    created = await auth_client.post("/api/conversations", json={"title": "测试", "model": "deepseek-v4-pro"})
    assert created.status_code == 200
    conversation = created.json()["conversation"]
    assert conversation["title"] == "测试"

    listed = await auth_client.get("/api/conversations")
    assert len(listed.json()["conversations"]) == 1

    patched = await auth_client.patch(
        f"/api/conversations/{conversation['id']}", json={"title": "改名了"}
    )
    assert patched.status_code == 200
    assert patched.json()["conversation"]["title"] == "改名了"

    detail = await auth_client.get(f"/api/conversations/{conversation['id']}")
    assert detail.status_code == 200
    assert detail.json()["messages"] == []

    deleted = await auth_client.delete(f"/api/conversations/{conversation['id']}")
    assert deleted.status_code == 200
    assert (await auth_client.get(f"/api/conversations/{conversation['id']}")).status_code == 404


@pytest.mark.asyncio
async def test_chat_stream_and_persistence(auth_client, monkeypatch):
    async def fake_stream_chat(**_kwargs):
        yield StreamChunk(reasoning="先想一下")
        yield StreamChunk(content="你好")
        yield StreamChunk(
            content="，世界",
            usage={
                "prompt_tokens": 12,
                "completion_tokens": 4,
                "completion_tokens_details": {"reasoning_tokens": 3},
                "prompt_tokens_details": {"cached_tokens": 2},
            },
        )

    monkeypatch.setattr(main_module, "stream_chat", fake_stream_chat)

    async with auth_client.stream(
        "POST",
        "/api/chat",
        json={"content": "打个招呼", "model": "deepseek-chat"},
    ) as response:
        assert response.status_code == 200
        body = await response.aread()
        text = body.decode("utf-8")

    assert "event: meta" in text
    assert "event: reasoning" in text
    assert "event: delta" in text
    assert "event: done" in text

    meta_line = next(line for line in text.splitlines() if line.startswith("data:") and '"conversation"' in line)
    meta = json.loads(meta_line[5:].strip())
    conversation_id = meta["conversation"]["id"]

    detail = await auth_client.get(f"/api/conversations/{conversation_id}")
    data = detail.json()
    assert data["conversation"]["title"] == "打个招呼"
    assert len(data["messages"]) == 2
    user, assistant = data["messages"]
    assert user["content"] == "打个招呼"
    assert assistant["content"] == "你好，世界"
    assert assistant["reasoning"] == "先想一下"
    assert assistant["status"] == "complete"
    assert assistant["prompt_tokens"] == 12
    assert assistant["completion_tokens"] == 4
    assert assistant["reasoning_tokens"] == 3
    assert assistant["cached_tokens"] == 2


@pytest.mark.asyncio
async def test_edit_user_message_truncates_and_regenerates(auth_client, monkeypatch):
    async def first_stream(**_kwargs):
        yield StreamChunk(content="第一版")

    monkeypatch.setattr(main_module, "stream_chat", first_stream)
    async with auth_client.stream(
        "POST", "/api/chat", json={"content": "原始问题"}
    ) as response:
        await response.aread()

    listed = (await auth_client.get("/api/conversations")).json()["conversations"]
    conversation_id = listed[0]["id"]
    detail = (await auth_client.get(f"/api/conversations/{conversation_id}")).json()
    user_id = detail["messages"][0]["id"]

    async def second_stream(**_kwargs):
        yield StreamChunk(content="编辑后的回答")

    monkeypatch.setattr(main_module, "stream_chat", second_stream)
    async with auth_client.stream(
        "POST",
        f"/api/conversations/{conversation_id}/messages/{user_id}/edit",
        json={"content": "修改后的问题"},
    ) as response:
        assert response.status_code == 200
        await response.aread()

    updated = (await auth_client.get(f"/api/conversations/{conversation_id}")).json()
    assert updated["conversation"]["title"] == "修改后的问题"
    assert len(updated["messages"]) == 2
    assert updated["messages"][0]["content"] == "修改后的问题"
    assert updated["messages"][1]["content"] == "编辑后的回答"
    assert updated["messages"][0]["version_count"] == 2

    # 旧分支没有被删除，可以通过版本切换回到它。
    activated = await auth_client.post(
        f"/api/conversations/{conversation_id}/messages/{user_id}/activate"
    )
    assert activated.status_code == 200
    old_branch = activated.json()["messages"]
    assert old_branch[0]["content"] == "原始问题"
    assert old_branch[1]["content"] == "第一版"


@pytest.mark.asyncio
async def test_edit_rejects_assistant_message(auth_client, monkeypatch):
    async def fake_stream(**_kwargs):
        yield StreamChunk(content="回答")

    monkeypatch.setattr(main_module, "stream_chat", fake_stream)
    async with auth_client.stream("POST", "/api/chat", json={"content": "问题"}) as response:
        await response.aread()

    listed = (await auth_client.get("/api/conversations")).json()["conversations"]
    conversation_id = listed[0]["id"]
    detail = (await auth_client.get(f"/api/conversations/{conversation_id}")).json()
    assistant_id = detail["messages"][1]["id"]
    response = await auth_client.post(
        f"/api/conversations/{conversation_id}/messages/{assistant_id}/edit",
        json={"content": "不能编辑"},
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_web_search_forces_flash_and_persists_sources(auth_client, monkeypatch):
    captured = {}

    async def fake_stream_chat(**kwargs):
        captured.update(kwargs)
        yield StreamChunk(
            content="联网回答",
            sources=[
                {
                    "url": "https://example.com/news",
                    "title": "示例新闻",
                    "site_name": "Example",
                }
            ],
            annotations=[
                {
                    "type": "url_citation",
                    "url_citation": {"url": "https://example.com/news", "title": "示例新闻"},
                }
            ],
            usage={"prompt_tokens": 20, "completion_tokens": 5},
        )

    monkeypatch.setattr(main_module, "stream_chat", fake_stream_chat)
    async with auth_client.stream(
        "POST",
        "/api/chat",
        json={"content": "查一下最新消息", "model": "deepseek-chat", "web_search": True},
    ) as response:
        assert response.status_code == 200
        await response.aread()

    assert captured["model"] == "deepseek-flash"
    assert captured["web_search"] is True

    conversations = (await auth_client.get("/api/conversations")).json()["conversations"]
    detail = (
        await auth_client.get(f"/api/conversations/{conversations[0]['id']}")
    ).json()
    assistant = detail["messages"][1]
    assert assistant["web_search"] is True
    assert assistant["sources"][0]["url"] == "https://example.com/news"
    assert assistant["annotations"][0]["type"] == "url_citation"


@pytest.mark.asyncio
async def test_deep_thinking_flag_is_forwarded_and_persisted(auth_client, monkeypatch):
    captured = {}

    async def fake_stream_chat(**kwargs):
        captured.update(kwargs)
        yield StreamChunk(content="想好了")

    monkeypatch.setattr(main_module, "stream_chat", fake_stream_chat)
    async with auth_client.stream(
        "POST",
        "/api/chat",
        json={
            "content": "认真想一想",
            "model": "deepseek-v4-pro",
            "thinking": True,
        },
    ) as response:
        assert response.status_code == 200
        await response.aread()

    assert captured["thinking"] is True
    assert captured["model"] == "deepseek-v4-pro"
    conversations = (await auth_client.get("/api/conversations")).json()["conversations"]
    detail = (
        await auth_client.get(f"/api/conversations/{conversations[0]['id']}")
    ).json()
    assert detail["messages"][1]["thinking"] is True


@pytest.mark.asyncio
async def test_chat_rejects_unknown_model(auth_client):
    response = await auth_client.post(
        "/api/chat", json={"content": "hi", "model": "gpt-4"}
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_regenerate_replaces_last_assistant(auth_client, monkeypatch):
    async def first_stream(**_kwargs):
        yield StreamChunk(content="第一版")

    monkeypatch.setattr(main_module, "stream_chat", first_stream)
    async with auth_client.stream(
        "POST", "/api/chat", json={"content": "问题"}
    ) as response:
        await response.aread()

    conversations = (await auth_client.get("/api/conversations")).json()["conversations"]
    conversation_id = conversations[0]["id"]

    async def second_stream(**_kwargs):
        yield StreamChunk(content="第二版")

    monkeypatch.setattr(main_module, "stream_chat", second_stream)
    async with auth_client.stream(
        "POST", f"/api/conversations/{conversation_id}/regenerate", json={}
    ) as response:
        assert response.status_code == 200
        await response.aread()

    detail = (await auth_client.get(f"/api/conversations/{conversation_id}")).json()
    assert len(detail["messages"]) == 2
    assert detail["messages"][0]["content"] == "问题"
    assert detail["messages"][1]["content"] == "第二版"
    assert detail["messages"][1]["version_count"] == 2
