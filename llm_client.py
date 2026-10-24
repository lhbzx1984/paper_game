from __future__ import annotations

import json
import os
import re
import time
from typing import Any
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv

load_dotenv()


class LLMError(RuntimeError):
    def __init__(self, message: str, detail: str | None = None, status: int | None = None):
        super().__init__(message)
        self.message = message
        self.detail = detail
        self.status = status


def _env_flag(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


RUNTIME: dict[str, Any] = {
    "base_url": os.getenv("LLM_BASE_URL", "").strip(),
    "api_key": os.getenv("LLM_API_KEY", "").strip(),
    "model": os.getenv("LLM_MODEL", "").strip() or "gpt-4o-mini",
    "mock": _env_flag("MOCK_LLM"),
}


def is_real_configured() -> bool:
    return bool(RUNTIME["base_url"] and RUNTIME["api_key"])


def public_status() -> dict[str, Any]:
    host = ""
    if RUNTIME["base_url"]:
        try:
            host = urlparse(RUNTIME["base_url"]).netloc or RUNTIME["base_url"]
        except ValueError:
            host = RUNTIME["base_url"]
    return {
        "configured": is_real_configured() or bool(RUNTIME["mock"]),
        "real_configured": is_real_configured(),
        "mock": bool(RUNTIME["mock"]),
        "model": RUNTIME["model"],
        "host": host,
    }


def set_config(base_url: str | None, api_key: str | None, model: str | None) -> dict[str, Any]:
    base_url = (base_url or "").strip().rstrip("/")
    api_key = (api_key or "").strip()
    model = (model or "").strip()
    # Leaving both connection fields blank keeps the current connection and
    # only updates the model name. This lets users switch models without
    # re-entering a key that the browser never receives back.
    if not base_url and not api_key:
        RUNTIME["model"] = model or RUNTIME["model"] or "gpt-4o-mini"
        return public_status()
    if base_url and not api_key:
        raise LLMError("请填写 API Key")
    if api_key and not base_url:
        raise LLMError("请填写 Base URL")
    RUNTIME["base_url"] = base_url
    RUNTIME["api_key"] = api_key
    RUNTIME["model"] = model or "gpt-4o-mini"
    RUNTIME["mock"] = False
    return public_status()


def _endpoint() -> str:
    base = RUNTIME["base_url"].rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return base + "/chat/completions"


def _extract_content(payload: dict) -> str:
    try:
        choice = payload["choices"][0]
        message = choice.get("message") or {}
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    parts.append(item["text"])
            return "".join(parts)
    except (KeyError, IndexError, TypeError):
        pass
    raise LLMError("模型返回中没有可读取的文本内容", detail=json.dumps(payload, ensure_ascii=False)[:600])


def extract_json(text: str) -> Any:
    if not isinstance(text, str):
        raise LLMError("模型返回的内容不是文本")
    cleaned = text.strip().lstrip("\ufeff")
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.I)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise LLMError("模型没有返回 JSON 对象", detail=cleaned[:500])
    candidate = cleaned[start : end + 1]
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        repaired = re.sub(r",\s*([}\]])", r"\1", candidate)
        try:
            return json.loads(repaired)
        except json.JSONDecodeError as exc:
            raise LLMError(
                "模型返回的 JSON 无法解析",
                detail=f"{exc.msg} at line {exc.lineno}, column {exc.colno}. Snippet: {candidate[:400]}",
            )


def _post_chat(system: str, user: str, max_tokens: int, temperature: float) -> str:
    if not is_real_configured():
        raise LLMError("云端模型尚未配置。请点击右上角「模型设置」填写 Base URL、API Key 和模型名。")
    headers = {
        "Authorization": f"Bearer {RUNTIME['api_key']}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": RUNTIME["model"],
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            response = requests.post(_endpoint(), headers=headers, json=payload, timeout=180)
            if response.status_code == 400 and "response_format" in response.text.lower():
                payload.pop("response_format", None)
                response = requests.post(_endpoint(), headers=headers, json=payload, timeout=180)
            if response.status_code in {401, 403}:
                raise LLMError("API 认证失败，请检查 API Key 是否有权限", detail=response.text[:500], status=response.status_code)
            if response.status_code == 429:
                last_error = LLMError("模型请求过于频繁，请稍后重试", detail=response.text[:500], status=429)
                time.sleep(2)
                continue
            if response.status_code >= 400:
                detail = response.text[:800]
                if response.status_code in {413, 422} or "context" in detail.lower() or "token" in detail.lower():
                    raise LLMError("论文可能过长，超出模型上下文限制。请尝试更短的论文或更换更大上下文的模型。", detail=detail, status=response.status_code)
                raise LLMError(f"模型请求失败（HTTP {response.status_code}）", detail=detail, status=response.status_code)
            data = response.json()
            return _extract_content(data)
        except requests.Timeout as exc:
            last_error = LLMError("模型请求超时，请稍后重试或更换模型", detail=str(exc))
            time.sleep(1)
        except requests.ConnectionError as exc:
            last_error = LLMError("无法连接模型服务，请检查 Base URL 与网络", detail=str(exc))
            time.sleep(1)
        except ValueError as exc:
            last_error = LLMError("模型返回的不是合法 JSON", detail=str(exc))
            time.sleep(1)
    if isinstance(last_error, LLMError):
        raise last_error
    raise LLMError("模型请求失败", detail=str(last_error) if last_error else None)


def chat_json(
    system: str,
    user: str,
    *,
    max_tokens: int = 4000,
    temperature: float = 0.2,
    mock_response: Any | None = None,
) -> Any:
    if RUNTIME["mock"]:
        if mock_response is None:
            return {"mock": True}
        return mock_response
    text = _post_chat(system, user, max_tokens, temperature)
    return extract_json(text)


def test_connection() -> dict[str, Any]:
    if RUNTIME["mock"]:
        return {"ok": True, "mock": True, "message": "模拟模型可用"}
    if not is_real_configured():
        raise LLMError("云端模型尚未配置")
    result = chat_json(
        "You are a connectivity test. Follow the user instruction exactly.",
        'Return exactly this JSON and nothing else: {"ok": true}',
        max_tokens=30,
        temperature=0,
    )
    return {"ok": bool(result.get("ok")), "mock": False, "message": "连接成功"}
