from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator

import httpx

logger = logging.getLogger("dschat.deepseek")


class UpstreamError(Exception):
    def __init__(self, status_code: int, message: str, detail: str = ""):
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.detail = detail


@dataclass
class StreamChunk:
    content: str = ""
    reasoning: str = ""
    usage: dict[str, Any] | None = None
    tool_event: dict[str, Any] | None = None
    sources: list[dict[str, Any]] | None = None
    annotations: list[dict[str, Any]] | None = None


def _friendly_error(status_code: int, detail: str) -> str:
    if status_code == 400:
        return "请求参数有误，可能是对话上下文过长"
    if status_code == 401:
        return "DeepSeek API Key 无效或已失效"
    if status_code == 402:
        return "DeepSeek 账户余额不足"
    if status_code == 403:
        return "DeepSeek 拒绝了本次请求"
    if status_code == 429:
        return "请求过于频繁，请稍后再试"
    if status_code >= 500:
        return "DeepSeek 服务暂时不可用，请稍后重试"
    return f"DeepSeek 返回错误（HTTP {status_code}）"


def _extract_error(body: bytes) -> str:
    text = body.decode("utf-8", errors="replace").strip()
    if not text:
        return ""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return text[:300]
    error = data.get("error")
    if isinstance(error, dict):
        message = error.get("message") or error.get("type") or ""
        return str(message)[:300]
    return text[:300]


def _friendly_file_error(status_code: int, detail: str) -> str:
    if status_code == 400:
        return "文件无法解析，可能格式不支持、设有密码或已损坏"
    if status_code == 413:
        return "文件超过了 DeepSeek 的大小限制"
    if status_code == 408:
        return "文件上传超时，请稍后重试"
    if status_code == 429:
        return "同时解析的文件过多，请稍后重试"
    if status_code == 504:
        return "文件解析超时，请尝试更小的文件"
    if status_code == 401:
        return "DeepSeek API Key 无效或已失效"
    if status_code == 402:
        return "DeepSeek 账户余额不足"
    if status_code >= 500:
        return "DeepSeek 文件服务暂时不可用"
    return f"文件上传失败（HTTP {status_code}）"


async def upload_file(
    *,
    base_url: str,
    api_key: str,
    file_path: Path,
    filename: str,
    content_type: str,
    purpose: str,
    timeout: float = 300.0,
) -> dict[str, Any]:
    """把本地临时文件转发到 DeepSeek Files API，返回 file_id。"""
    headers = {"Authorization": f"Bearer {api_key}", "User-Agent": "ds-chat/1.0"}
    # 不设置过期时间，保证历史对话长期可用；删除会话/附件时会主动清理。
    fields: list[tuple[str, tuple[None, str]]] = [
        ("purpose", (None, purpose)),
    ]
    limits = httpx.Timeout(connect=20.0, read=timeout, write=timeout, pool=30.0)

    with file_path.open("rb") as file_handle:
        files = [
            *fields,
            (
                "file",
                (
                    filename,
                    file_handle,
                    content_type or "application/octet-stream",
                ),
            ),
        ]
        async with httpx.AsyncClient(timeout=limits) as client:
            try:
                response = await client.post(
                    f"{base_url}/files", headers=headers, files=files
                )
            except httpx.TimeoutException as exc:
                raise UpstreamError(504, "文件上传超时，请稍后重试") from exc
            except httpx.HTTPError as exc:
                raise UpstreamError(502, "无法连接 DeepSeek 文件服务") from exc

    if response.status_code != 200:
        detail = _extract_error(response.content)
        message = _friendly_file_error(response.status_code, detail)
        logger.warning(
            "DeepSeek file upload error status=%s detail=%s",
            response.status_code,
            detail[:300],
        )
        raise UpstreamError(response.status_code, message, detail)

    data = response.json()
    file_id = data.get("id")
    if not file_id:
        raise UpstreamError(502, "DeepSeek 没有返回文件 ID")
    return data


async def delete_file(*, base_url: str, api_key: str, file_id: str) -> None:
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            await client.delete(f"{base_url}/files/{file_id}", headers=headers)
    except httpx.HTTPError:
        logger.info("failed to delete upstream file %s", file_id)


async def stream_chat(
    *,
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int,
    timeout: float,
    web_search: bool = False,
    thinking: bool = False,
) -> AsyncIterator[StreamChunk]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
        "max_tokens": max_tokens,
        "stream_options": {"include_usage": True},
    }
    if web_search:
        payload["tools"] = [
            {"type": "deepseek_web_search"},
            {"type": "deepseek_read_url"},
        ]
    payload["thinking"] = {"type": "enabled" if thinking else "disabled"}
    # temperature 等采样参数使用模型默认值，不显式传。
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "User-Agent": "ds-chat/1.0",
    }
    limits = httpx.Timeout(connect=15.0, read=timeout, write=30.0, pool=30.0)

    async with httpx.AsyncClient(timeout=limits) as client:
        try:
            async with client.stream(
                "POST",
                f"{base_url}/chat/completions",
                headers=headers,
                json=payload,
            ) as response:
                if response.status_code != 200:
                    body = await response.aread()
                    detail = _extract_error(body)
                    message = _friendly_error(response.status_code, detail)
                    logger.warning(
                        "DeepSeek upstream error status=%s detail=%s",
                        response.status_code,
                        detail[:300],
                    )
                    raise UpstreamError(response.status_code, message, detail)

                async for raw_line in response.aiter_lines():
                    line = raw_line.strip()
                    if not line or line.startswith(":"):
                        continue
                    if not line.startswith("data:"):
                        continue
                    data_text = line[5:].strip()
                    if not data_text or data_text == "[DONE]":
                        continue
                    try:
                        data = json.loads(data_text)
                    except json.JSONDecodeError:
                        continue

                    if isinstance(data, dict) and data.get("error"):
                        error = data["error"]
                        detail = error.get("message", "") if isinstance(error, dict) else str(error)
                        raise UpstreamError(502, "DeepSeek 返回了错误", str(detail)[:300])

                    choices = data.get("choices") or []
                    content = ""
                    reasoning = ""
                    tool_event: dict[str, Any] | None = None
                    sources: list[dict[str, Any]] = []
                    annotations: list[dict[str, Any]] = []
                    if choices:
                        choice = choices[0]
                        delta = choice.get("delta") or {}
                        content = delta.get("content") or ""
                        reasoning = delta.get("reasoning_content") or ""
                        event = choice.get("server_tool_event")
                        if isinstance(event, dict):
                            tool_event = event
                            call = event.get("call") or {}
                            for source in call.get("sources") or []:
                                if isinstance(source, dict):
                                    sources.append(source)

                        for step in delta.get("server_tool_calls") or []:
                            for call in step.get("calls") or []:
                                for source in call.get("sources") or []:
                                    if isinstance(source, dict):
                                        sources.append(source)
                        for annotation in delta.get("annotations") or []:
                            if isinstance(annotation, dict):
                                annotations.append(annotation)

                    usage = data.get("usage")
                    if content or reasoning or usage or tool_event or sources or annotations:
                        yield StreamChunk(
                            content=content,
                            reasoning=reasoning,
                            usage=usage if isinstance(usage, dict) else None,
                            tool_event=tool_event,
                            sources=sources or None,
                            annotations=annotations or None,
                        )
        except UpstreamError:
            raise
        except httpx.TimeoutException as exc:
            logger.warning("DeepSeek timeout: %s", exc)
            raise UpstreamError(504, "DeepSeek 响应超时，请稍后重试") from exc
        except httpx.HTTPError as exc:
            logger.warning("DeepSeek transport error: %s", exc)
            raise UpstreamError(502, "无法连接 DeepSeek，请稍后重试") from exc
