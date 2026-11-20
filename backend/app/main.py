from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.background import BackgroundTask

from .auth import (
    LoginLimiter,
    client_ip,
    issue_session,
    origin_allowed,
    verify_password,
    verify_session,
)
from .config import LEGACY_MODEL_ALIASES, Settings, load_settings
from .db import Database, now_ms
from .deepseek import (
    StreamChunk,
    UpstreamError,
    delete_file,
    stream_chat,
    upload_file,
)

logger = logging.getLogger("dschat")

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
DOCUMENT_EXTENSIONS = {".pdf", ".doc", ".docx", ".ppt", ".pptx"}
TEXT_EXTENSIONS = {
    ".txt",
    ".md",
    ".markdown",
    ".csv",
    ".json",
    ".jsonl",
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".html",
    ".css",
    ".yaml",
    ".yml",
    ".sh",
    ".sql",
    ".toml",
    ".ini",
    ".log",
    ".xml",
    ".xlsx",
    ".xls",
    ".epub",
    ".mobi",
}
TEXT_MIMES = {
    "application/json",
    "application/xml",
    "application/x-yaml",
    "application/javascript",
    "application/typescript",
    "text/csv",
    "text/markdown",
    "text/plain",
    "text/xml",
}
MAX_ATTACHMENTS = 6


def classify_upload(filename: str, content_type: str) -> tuple[str, str, int]:
    suffix = Path(filename).suffix.lower()
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    if suffix in IMAGE_EXTENSIONS or mime in {
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
    }:
        return "image", "user_data", 64 * 1024 * 1024
    if suffix in DOCUMENT_EXTENSIONS or mime in {
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }:
        return "document", "text_recognition", 100 * 1024 * 1024
    if suffix in TEXT_EXTENSIONS or mime in TEXT_MIMES:
        return "text", "user_data", 32 * 1024 * 1024
    raise HTTPException(
        status_code=400,
        detail="不支持的文件类型。支持图片、PDF、Word、PPT、文本、表格和电子书。",
    )


class LoginIn(BaseModel):
    password: str = Field(min_length=1, max_length=512)


class ConversationCreateIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    title: str | None = Field(default=None, max_length=120)
    model: str | None = None


class ConversationPatchIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    title: str | None = Field(default=None, max_length=120)
    model: str | None = None


class ChatIn(BaseModel):
    conversation_id: int | None = None
    content: str = Field(min_length=1, max_length=32_000)
    model: str = "deepseek-v4-pro"
    web_search: bool = False
    thinking: bool = False
    attachment_ids: list[str] = Field(default_factory=list, max_length=MAX_ATTACHMENTS)


class RegenerateIn(BaseModel):
    model: str | None = None
    web_search: bool = False
    thinking: bool = False


class EditMessageIn(BaseModel):
    content: str = Field(min_length=1, max_length=32_000)
    model: str | None = None
    web_search: bool = False
    thinking: bool = False
    attachment_ids: list[str] = Field(default_factory=list, max_length=MAX_ATTACHMENTS)


def make_title(text: str, limit: int = 28) -> str:
    title = re.sub(r"\s+", " ", text).strip()
    if not title:
        return "新对话"
    return title if len(title) <= limit else title[:limit].rstrip() + "…"


def sse(event: str, data: dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    settings.validate()
    if settings.upload_dir is None:
        settings = replace(settings, upload_dir=settings.db_path.parent / "uploads")
    assert settings.upload_dir is not None
    settings.upload_dir.mkdir(parents=True, exist_ok=True)

    db = Database(settings.db_path)
    limiter = LoginLimiter()
    active_streams: dict[int, asyncio.Event] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        interrupted = db.mark_interrupted()
        if interrupted:
            logger.warning("marked %s stale streaming message(s) as interrupted", interrupted)
        cutoff = now_ms() - 24 * 60 * 60 * 1000
        for attachment in db.list_old_pending_attachments(cutoff):
            with contextlib.suppress(OSError):
                Path(attachment["local_path"]).unlink(missing_ok=True)
            db.delete_attachment(attachment["id"])
            await delete_file(
                base_url=settings.deepseek_base_url,
                api_key=settings.deepseek_api_key,
                file_id=attachment["file_id"],
            )
        yield

    app = FastAPI(
        title="DS Chat",
        docs_url="/api/docs" if settings.debug else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if settings.debug else None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.db = db
    app.state.limiter = limiter
    app.state.active_streams = active_streams

    def require_auth(request: Request) -> None:
        token = request.cookies.get(settings.cookie_name)
        if not verify_session(token, settings.session_secret):
            raise HTTPException(status_code=401, detail="未登录或登录已过期")

    def normalize_model(value: str | None) -> str:
        model = (value or settings.allowed_models[0]).strip()
        model = LEGACY_MODEL_ALIASES.get(model, model)
        if model not in settings.allowed_models:
            raise HTTPException(status_code=400, detail="不支持的模型")
        return model

    def request_model(
        value: str | None, web_search: bool, has_files: bool = False
    ) -> str:
        model = normalize_model(value)
        if web_search or has_files:
            if "deepseek-flash" not in settings.allowed_models:
                raise HTTPException(status_code=400, detail="当前未启用 deepseek-flash")
            # 联网工具和文件输入只在 deepseek-flash 上可用。
            model = "deepseek-flash"
        return model

    def validate_attachment_ids(attachment_ids: list[str]) -> list[str]:
        unique_ids = list(dict.fromkeys(attachment_ids))
        if len(unique_ids) > MAX_ATTACHMENTS:
            raise HTTPException(
                status_code=400,
                detail=f"每条消息最多 {MAX_ATTACHMENTS} 个附件",
            )
        if not unique_ids:
            return []
        rows = db.get_pending_attachments(unique_ids)
        if len(rows) != len(unique_ids):
            raise HTTPException(status_code=400, detail="附件不存在或已被使用")
        return unique_ids

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        if request.method in {"POST", "PATCH", "PUT", "DELETE"} and request.url.path.startswith("/api/"):
            if not origin_allowed(request, settings.public_origin, debug=settings.debug):
                return JSONResponse({"detail": "非法请求来源"}, status_code=403)

        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; "
            "object-src 'none'; img-src 'self' data: https:; font-src 'self' data:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
        )
        if settings.cookie_secure:
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
            )
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    # ------------------------------------------------------------------
    # auth
    # ------------------------------------------------------------------

    @app.get("/api/health")
    async def health():
        db.ping()
        return {"ok": True}

    @app.get("/api/auth/session")
    async def session(request: Request):
        token = request.cookies.get(settings.cookie_name)
        return {"authenticated": verify_session(token, settings.session_secret)}

    @app.post("/api/auth/login")
    async def login(payload: LoginIn, request: Request):
        ip = client_ip(request)
        wait = limiter.retry_after(ip)
        if wait:
            raise HTTPException(
                status_code=429,
                detail=f"尝试过于频繁，请 {wait} 秒后再试",
                headers={"Retry-After": str(wait)},
            )

        if not verify_password(payload.password, settings.password_hash):
            limiter.record_failure(ip)
            await asyncio.sleep(0.35)
            raise HTTPException(status_code=401, detail="密码不正确")

        limiter.reset(ip)
        token = issue_session(settings.session_secret, settings.session_ttl)
        response = JSONResponse({"ok": True})
        response.set_cookie(
            key=settings.cookie_name,
            value=token,
            max_age=settings.session_ttl,
            httponly=True,
            secure=settings.cookie_secure,
            samesite="lax",
            path="/",
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.post("/api/auth/logout")
    async def logout():
        response = JSONResponse({"ok": True})
        response.delete_cookie(
            key=settings.cookie_name,
            path="/",
            secure=settings.cookie_secure,
            httponly=True,
            samesite="lax",
        )
        return response

    # ------------------------------------------------------------------
    # files
    # ------------------------------------------------------------------

    @app.post("/api/files")
    async def upload_attachment(
        file: UploadFile = File(...),
        _: None = Depends(require_auth),
    ):
        filename = Path(file.filename or "file").name
        if not filename:
            raise HTTPException(status_code=400, detail="文件名不能为空")
        if len(filename.encode("utf-8")) > 512:
            raise HTTPException(status_code=400, detail="文件名过长")
        kind, purpose, max_bytes = classify_upload(
            filename, file.content_type or ""
        )
        local_id = uuid.uuid4().hex
        suffix = Path(filename).suffix.lower()
        temp_path = settings.upload_dir / f".{local_id}.part"
        final_path = settings.upload_dir / f"{local_id}{suffix}"
        size = 0

        try:
            with temp_path.open("wb") as target:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise HTTPException(
                            status_code=413,
                            detail=f"文件超过大小限制（最大 {max_bytes // (1024 * 1024)} MB）",
                        )
                    target.write(chunk)
            if size == 0:
                raise HTTPException(status_code=400, detail="文件为空")

            os.replace(temp_path, final_path)
            try:
                upstream = await upload_file(
                    base_url=settings.deepseek_base_url,
                    api_key=settings.deepseek_api_key,
                    file_path=final_path,
                    filename=filename,
                    content_type=file.content_type or "application/octet-stream",
                    purpose=purpose,
                    timeout=max(300.0, settings.upstream_timeout),
                )
            except UpstreamError as exc:
                raise HTTPException(
                    status_code=(
                        exc.status_code
                        if 400 <= exc.status_code < 500
                        else 502
                    ),
                    detail=exc.message,
                ) from exc

            attachment = db.create_attachment(
                file_id=str(upstream["id"]),
                filename=filename,
                mime=file.content_type or "application/octet-stream",
                size=size,
                kind=kind,
                purpose=purpose,
                local_path=str(final_path),
            )
            return {"attachment": attachment}
        except HTTPException:
            temp_path.unlink(missing_ok=True)
            final_path.unlink(missing_ok=True)
            raise
        except Exception:
            logger.exception("file upload failed")
            temp_path.unlink(missing_ok=True)
            final_path.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail="文件上传失败")
        finally:
            await file.close()

    @app.get("/api/files/{attachment_id}/content")
    async def get_attachment_content(
        attachment_id: str,
        _: None = Depends(require_auth),
    ):
        attachment = db.get_attachment(attachment_id)
        if not attachment:
            raise HTTPException(status_code=404, detail="附件不存在")
        path = Path(attachment["local_path"]).resolve()
        root = settings.upload_dir.resolve()
        if root not in path.parents or not path.is_file():
            raise HTTPException(status_code=404, detail="附件文件不存在")
        inline = attachment["kind"] == "image" or attachment["mime"] == "application/pdf"
        return FileResponse(
            path,
            media_type=attachment["mime"] or "application/octet-stream",
            filename=attachment["filename"],
            content_disposition_type="inline" if inline else "attachment",
            headers={"Cache-Control": "private, max-age=3600"},
        )

    @app.delete("/api/files/{attachment_id}")
    async def delete_attachment(
        attachment_id: str,
        _: None = Depends(require_auth),
    ):
        attachment = db.get_attachment(attachment_id)
        if not attachment:
            raise HTTPException(status_code=404, detail="附件不存在")
        if attachment["message_id"] is not None:
            raise HTTPException(status_code=400, detail="已发送的附件不能单独删除")
        if not db.delete_attachment(attachment_id):
            raise HTTPException(status_code=404, detail="附件不存在")
        with contextlib.suppress(OSError):
            Path(attachment["local_path"]).unlink(missing_ok=True)
        await delete_file(
            base_url=settings.deepseek_base_url,
            api_key=settings.deepseek_api_key,
            file_id=attachment["file_id"],
        )
        return {"ok": True}

    # ------------------------------------------------------------------
    # conversations
    # ------------------------------------------------------------------

    @app.get("/api/conversations")
    async def list_conversations(_: None = Depends(require_auth)):
        return {"conversations": db.list_conversations()}

    @app.get("/api/search")
    async def search(
        q: str = "",
        _: None = Depends(require_auth),
    ):
        return {"results": db.search(q[:100])}

    @app.post("/api/conversations")
    async def create_conversation(
        payload: ConversationCreateIn, _: None = Depends(require_auth)
    ):
        model = normalize_model(payload.model)
        title = (payload.title or "").strip() or "新对话"
        conversation = db.create_conversation(title, model)
        return {"conversation": conversation}

    @app.get("/api/conversations/{conversation_id}")
    async def get_conversation(
        conversation_id: int,
        _: None = Depends(require_auth),
    ):
        conversation = db.get_conversation(conversation_id)
        if not conversation:
            raise HTTPException(status_code=404, detail="对话不存在")
        messages = db.decorate_branches(
            conversation_id, db.get_active_path(conversation_id)
        )
        return {"conversation": conversation, "messages": messages}

    @app.patch("/api/conversations/{conversation_id}")
    async def patch_conversation(
        conversation_id: int,
        payload: ConversationPatchIn,
        _: None = Depends(require_auth),
    ):
        conversation = db.get_conversation(conversation_id)
        if not conversation:
            raise HTTPException(status_code=404, detail="对话不存在")
        title = payload.title.strip() if payload.title is not None else None
        if title is not None and not title:
            raise HTTPException(status_code=400, detail="标题不能为空")
        model = normalize_model(payload.model) if payload.model is not None else None
        updated = db.update_conversation(conversation_id, title=title or None, model=model)
        return {"conversation": updated}

    @app.delete("/api/conversations/{conversation_id}")
    async def delete_conversation(
        conversation_id: int, _: None = Depends(require_auth)
    ):
        event = active_streams.get(conversation_id)
        if event:
            event.set()
        attachments = db.list_attachments_for_conversation(conversation_id)
        if not db.delete_conversation(conversation_id):
            raise HTTPException(status_code=404, detail="对话不存在")
        for attachment in attachments:
            with contextlib.suppress(OSError):
                Path(attachment["local_path"]).unlink(missing_ok=True)
        for file_id in {attachment["file_id"] for attachment in attachments}:
            await delete_file(
                base_url=settings.deepseek_base_url,
                api_key=settings.deepseek_api_key,
                file_id=file_id,
            )
        return {"ok": True}

    @app.post("/api/conversations/{conversation_id}/stop")
    async def stop_conversation(
        conversation_id: int, _: None = Depends(require_auth)
    ):
        if not db.get_conversation(conversation_id):
            raise HTTPException(status_code=404, detail="对话不存在")
        event = active_streams.get(conversation_id)
        if event:
            event.set()
        return {"ok": True, "active": event is not None}

    @app.post("/api/conversations/{conversation_id}/messages/{message_id}/activate")
    async def activate_message(
        conversation_id: int,
        message_id: int,
        _: None = Depends(require_auth),
    ):
        conversation = db.get_conversation(conversation_id)
        if not conversation:
            raise HTTPException(status_code=404, detail="对话不存在")
        if conversation_id in active_streams or db.has_streaming_message(conversation_id):
            raise HTTPException(status_code=409, detail="该对话正在生成中，请先停止")
        message = db.get_message(message_id)
        if not message or int(message["conversation_id"]) != conversation_id:
            raise HTTPException(status_code=404, detail="消息不存在")

        leaf_id = db.latest_leaf(conversation_id, message_id)
        if leaf_id is None:
            raise HTTPException(status_code=400, detail="无法切换该分支")
        db.set_active_leaf(conversation_id, leaf_id)
        conversation = db.get_conversation(conversation_id)
        messages = db.decorate_branches(
            conversation_id, db.get_active_path(conversation_id)
        )
        return {"conversation": conversation, "messages": messages}

    # ------------------------------------------------------------------
    # chat streaming
    # ------------------------------------------------------------------

    def register_stream(conversation_id: int) -> asyncio.Event:
        if conversation_id in active_streams:
            raise HTTPException(status_code=409, detail="该对话正在生成中，请先停止")
        event = asyncio.Event()
        active_streams[conversation_id] = event
        return event

    def stream_headers() -> dict[str, str]:
        return {
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        }

    def cleanup_active_stream(conversation_id: int, event: asyncio.Event) -> None:
        if active_streams.get(conversation_id) is event:
            active_streams.pop(conversation_id, None)

    async def stream_reply(
        request: Request,
        conversation: dict[str, Any],
        user_message: dict[str, Any] | None,
        assistant_message: dict[str, Any],
        context: list[dict[str, Any]],
        model: str,
        stop_event: asyncio.Event,
        web_search: bool = False,
        thinking: bool = False,
    ) -> AsyncIterator[str]:
        conversation_id = int(conversation["id"])
        assistant_id = int(assistant_message["id"])
        queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()

        async def producer() -> None:
            try:
                async for chunk in stream_chat(
                    base_url=settings.deepseek_base_url,
                    api_key=settings.deepseek_api_key,
                    model=model,
                    messages=context,
                    max_tokens=settings.max_output_tokens,
                    timeout=settings.upstream_timeout,
                    web_search=web_search,
                    thinking=thinking,
                ):
                    await queue.put(("chunk", chunk))
                await queue.put(("done", None))
            except asyncio.CancelledError:
                raise
            except UpstreamError as exc:
                await queue.put(("error", exc))
            except Exception:
                logger.exception("unexpected DeepSeek stream failure")
                await queue.put(("error", UpstreamError(502, "生成失败，请稍后重试")))

        task = asyncio.create_task(producer())
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        usage: dict[str, Any] | None = None
        last_save = 0.0
        sources_by_url: dict[str, dict[str, Any]] = {}
        annotations: list[dict[str, Any]] = []

        def current_content() -> str:
            return "".join(content_parts)

        def current_reasoning() -> str:
            return "".join(reasoning_parts)

        def merge_sources(items: list[dict[str, Any]] | None) -> bool:
            changed = False
            for source in items or []:
                url = str(source.get("url") or "").strip()
                if url and url not in sources_by_url:
                    sources_by_url[url] = source
                    changed = True
            return changed

        async def next_queue_event() -> tuple[str, Any]:
            """同时等待下一个 token、停止信号和心跳超时。"""
            get_task = asyncio.create_task(queue.get())
            stop_task = asyncio.create_task(stop_event.wait())
            done, pending = await asyncio.wait(
                {get_task, stop_task},
                timeout=15.0,
                return_when=asyncio.FIRST_COMPLETED,
            )
            for pending_task in pending:
                pending_task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

            if stop_task in done and stop_task.result():
                return ("stop", None)
            if get_task in done:
                return get_task.result()
            return ("timeout", None)

        try:
            yield sse(
                "meta",
                {
                    "conversation": conversation,
                    "user_message": user_message,
                    "assistant_message": assistant_message,
                    "model": model,
                },
            )

            while True:
                if stop_event.is_set():
                    task.cancel()
                    final = db.update_message(
                        assistant_id,
                        content=current_content(),
                        reasoning=current_reasoning(),
                        status="stopped",
                    )
                    db.touch_conversation(conversation_id)
                    yield sse("done", {"message": final, "stopped": True})
                    break

                if await request.is_disconnected():
                    task.cancel()
                    final = db.update_message(
                        assistant_id,
                        content=current_content(),
                        reasoning=current_reasoning(),
                        status="stopped",
                    )
                    db.touch_conversation(conversation_id)
                    yield sse("done", {"message": final, "stopped": True})
                    break

                kind, payload = await next_queue_event()
                if kind == "timeout":
                    yield ": ping\n\n"
                    continue
                if kind == "stop":
                    task.cancel()
                    final = db.update_message(
                        assistant_id,
                        content=current_content(),
                        reasoning=current_reasoning(),
                        status="stopped",
                    )
                    db.touch_conversation(conversation_id)
                    yield sse("done", {"message": final, "stopped": True})
                    break

                if kind == "chunk" and isinstance(payload, StreamChunk):
                    if payload.tool_event:
                        event = payload.tool_event
                        if event.get("type") == "call_started":
                            call = event.get("call") or {}
                            action = call.get("action") or {}
                            if action.get("type") == "search":
                                yield sse(
                                    "search",
                                    {"queries": action.get("queries") or []},
                                )
                        elif event.get("type") == "call_completed":
                            call = event.get("call") or {}
                            if merge_sources(call.get("sources")):
                                yield sse(
                                    "sources",
                                    {"sources": list(sources_by_url.values())},
                                )

                    if payload.sources:
                        if merge_sources(payload.sources):
                            yield sse(
                                "sources",
                                {"sources": list(sources_by_url.values())},
                            )
                    if payload.annotations:
                        annotations.extend(payload.annotations)

                    if payload.reasoning:
                        reasoning_parts.append(payload.reasoning)
                        yield sse("reasoning", {"content": payload.reasoning})
                    if payload.content:
                        content_parts.append(payload.content)
                        yield sse("delta", {"content": payload.content})
                    if payload.usage:
                        usage = payload.usage

                    now = time.monotonic()
                    if now - last_save >= 1.0:
                        db.update_message(
                            assistant_id,
                            content=current_content(),
                            reasoning=current_reasoning(),
                            status="streaming",
                        )
                        last_save = now

                elif kind == "done":
                    usage_data = usage or {}
                    completion_details = usage_data.get("completion_tokens_details") or {}
                    prompt_details = usage_data.get("prompt_tokens_details") or {}
                    final = db.update_message(
                        assistant_id,
                        content=current_content(),
                        reasoning=current_reasoning(),
                        status="complete",
                        web_search=1 if web_search else 0,
                        thinking=1 if thinking else 0,
                        prompt_tokens=usage_data.get("prompt_tokens"),
                        completion_tokens=usage_data.get("completion_tokens"),
                        reasoning_tokens=completion_details.get("reasoning_tokens"),
                        cached_tokens=(
                            prompt_details.get("cached_tokens")
                            if prompt_details.get("cached_tokens") is not None
                            else usage_data.get("prompt_cache_hit_tokens")
                        ),
                        sources_json=(
                            json.dumps(list(sources_by_url.values()), ensure_ascii=False)
                            if sources_by_url
                            else ""
                        ),
                        annotations_json=(
                            json.dumps(annotations, ensure_ascii=False)
                            if annotations
                            else ""
                        ),
                    )
                    db.touch_conversation(conversation_id)
                    yield sse("done", {"message": final, "usage": usage})
                    break

                elif kind == "error" and isinstance(payload, UpstreamError):
                    final = db.update_message(
                        assistant_id,
                        content=current_content(),
                        reasoning=current_reasoning(),
                        status="error",
                        error=payload.message,
                    )
                    db.touch_conversation(conversation_id)
                    yield sse(
                        "error",
                        {"message": payload.message, "message_data": final},
                    )
                    break

        except asyncio.CancelledError:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            db.update_message(
                assistant_id,
                content=current_content(),
                reasoning=current_reasoning(),
                status="stopped",
            )
            raise

        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            if active_streams.get(conversation_id) is stop_event:
                active_streams.pop(conversation_id, None)

    @app.post("/api/chat")
    async def chat(
        payload: ChatIn, request: Request, _: None = Depends(require_auth)
    ):
        content = payload.content.strip()
        if not content:
            raise HTTPException(status_code=400, detail="消息不能为空")
        attachment_ids = validate_attachment_ids(payload.attachment_ids)

        parent_id: int | None = None
        has_files = bool(attachment_ids)
        if payload.conversation_id is not None:
            conversation = db.get_conversation(payload.conversation_id)
            if not conversation:
                raise HTTPException(status_code=404, detail="对话不存在")
            if conversation["id"] in active_streams or db.has_streaming_message(conversation["id"]):
                raise HTTPException(status_code=409, detail="该对话正在生成中，请先停止")
            path = db.get_active_path(conversation["id"])
            parent_id = int(path[-1]["id"]) if path else None
            has_files = has_files or db.conversation_has_attachments(conversation["id"])
        model = request_model(payload.model, payload.web_search, has_files)
        if payload.conversation_id is None:
            conversation = db.create_conversation(make_title(content), model)

        stop_event = register_stream(conversation["id"])
        try:
            if conversation["title"] in {"", "新对话"}:
                conversation = db.update_conversation(
                    conversation["id"], title=make_title(content)
                ) or conversation

            user_message = db.add_message(
                conversation["id"],
                "user",
                content,
                parent_id=parent_id,
                status="complete",
                model=model,
            )
            linked = db.link_attachments(
                attachment_ids, conversation["id"], int(user_message["id"])
            )
            user_message["attachments"] = linked
            conversation = db.update_conversation(conversation["id"], model=model) or conversation
            context = db.get_context(
                conversation["id"],
                settings.max_context_chars,
                leaf_id=int(user_message["id"]),
            )
            assistant_message = db.add_message(
                conversation["id"],
                "assistant",
                "",
                parent_id=int(user_message["id"]),
                status="streaming",
                model=model,
                web_search=payload.web_search,
                thinking=payload.thinking,
            )
        except Exception:
            active_streams.pop(conversation["id"], None)
            raise

        return StreamingResponse(
            stream_reply(
                request,
                conversation,
                user_message,
                assistant_message,
                context,
                model,
                stop_event,
                web_search=payload.web_search,
                thinking=payload.thinking,
            ),
            media_type="text/event-stream",
            headers=stream_headers(),
            background=BackgroundTask(
                cleanup_active_stream, conversation["id"], stop_event
            ),
        )

    @app.post("/api/conversations/{conversation_id}/messages/{message_id}/edit")
    async def edit_message(
        conversation_id: int,
        message_id: int,
        payload: EditMessageIn,
        request: Request,
        _: None = Depends(require_auth),
    ):
        conversation = db.get_conversation(conversation_id)
        if not conversation:
            raise HTTPException(status_code=404, detail="对话不存在")
        if conversation_id in active_streams or db.has_streaming_message(conversation_id):
            raise HTTPException(status_code=409, detail="该对话正在生成中，请先停止")

        message = db.get_message(message_id)
        if not message or int(message["conversation_id"]) != conversation_id:
            raise HTTPException(status_code=404, detail="消息不存在")
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="只能编辑用户消息")

        content = payload.content.strip()
        if not content:
            raise HTTPException(status_code=400, detail="消息不能为空")
        attachment_ids = validate_attachment_ids(payload.attachment_ids)
        has_files = bool(attachment_ids) or db.conversation_has_attachments(
            conversation_id
        )
        model = request_model(
            payload.model or conversation["model"],
            payload.web_search,
            has_files,
        )

        stop_event = register_stream(conversation_id)
        try:
            created = db.create_user_version(
                conversation_id,
                message_id,
                content,
                model,
                title=make_title(content),
            )
            if not created:
                raise HTTPException(status_code=404, detail="消息不存在")
            user_message, conversation = created
            cloned = db.clone_attachments(
                message_id, int(user_message["id"]), conversation_id
            )
            linked = db.link_attachments(
                attachment_ids, conversation_id, int(user_message["id"])
            )
            user_message["attachments"] = [*cloned, *linked]
            context = db.get_context(
                conversation_id,
                settings.max_context_chars,
                leaf_id=int(user_message["id"]),
            )
            assistant_message = db.add_message(
                conversation_id,
                "assistant",
                "",
                parent_id=int(user_message["id"]),
                status="streaming",
                model=model,
                web_search=payload.web_search,
                thinking=payload.thinking,
            )
        except Exception:
            active_streams.pop(conversation_id, None)
            raise

        return StreamingResponse(
            stream_reply(
                request,
                conversation,
                user_message,
                assistant_message,
                context,
                model,
                stop_event,
                web_search=payload.web_search,
                thinking=payload.thinking,
            ),
            media_type="text/event-stream",
            headers=stream_headers(),
            background=BackgroundTask(
                cleanup_active_stream, conversation_id, stop_event
            ),
        )

    @app.post("/api/conversations/{conversation_id}/regenerate")
    async def regenerate(
        conversation_id: int,
        payload: RegenerateIn,
        request: Request,
        _: None = Depends(require_auth),
    ):
        conversation = db.get_conversation(conversation_id)
        if not conversation:
            raise HTTPException(status_code=404, detail="对话不存在")
        if conversation_id in active_streams or db.has_streaming_message(conversation_id):
            raise HTTPException(status_code=409, detail="该对话正在生成中，请先停止")

        path = db.get_active_path(conversation_id)
        last = path[-1] if path else None
        if not last:
            raise HTTPException(status_code=400, detail="没有可重新生成的内容")
        if last["role"] == "assistant" and last["status"] == "streaming":
            raise HTTPException(status_code=409, detail="该对话正在生成中，请先停止")

        if last["role"] == "assistant":
            parent_id = last["parent_id"]
            if parent_id is None:
                raise HTTPException(status_code=400, detail="没有可重新生成的用户消息")
            context_leaf = int(parent_id)
        else:
            parent_id = int(last["id"])
            context_leaf = int(last["id"])

        stop_event = register_stream(conversation_id)
        try:
            model = request_model(
                payload.model or conversation["model"],
                payload.web_search,
                db.conversation_has_attachments(conversation_id),
            )
            conversation = db.update_conversation(conversation_id, model=model) or conversation
            context = db.get_context(
                conversation_id,
                settings.max_context_chars,
                leaf_id=context_leaf,
            )
            assistant_message = db.add_message(
                conversation_id,
                "assistant",
                "",
                parent_id=int(parent_id),
                status="streaming",
                model=model,
                web_search=payload.web_search,
                thinking=payload.thinking,
            )
        except Exception:
            active_streams.pop(conversation_id, None)
            raise

        return StreamingResponse(
            stream_reply(
                request,
                conversation,
                None,
                assistant_message,
                context,
                model,
                stop_event,
                web_search=payload.web_search,
                thinking=payload.thinking,
            ),
            media_type="text/event-stream",
            headers=stream_headers(),
            background=BackgroundTask(
                cleanup_active_stream, conversation_id, stop_event
            ),
        )

    return app
