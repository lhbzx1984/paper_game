"""Agnes Image 2.5 Flash 图像生成客户端。

复用与 LLM 相同的 API Key（agnes-ai 平台通用）。
用于论文庭审游戏的概念可视化、场景氛围图、裁决书海报等。
"""

from __future__ import annotations

import os
from typing import Any

import requests
from dotenv import load_dotenv

load_dotenv()

DEFAULT_BASE_URL = "https://apihub.agnes-ai.com/v1"
DEFAULT_MODEL = "agnes-image-2.5-flash"

# 支持的尺寸档位与宽高比
VALID_SIZES = {"1K", "2K", "3K", "4K", "1024x768", "1024x1024"}
VALID_RATIOS = {"1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"}


class ImageError(RuntimeError):
    def __init__(self, message: str, detail: str | None = None, status: int | None = None):
        super().__init__(message)
        self.message = message
        self.detail = detail
        self.status = status


def _api_key() -> str:
    return os.getenv("LLM_API_KEY", "").strip() or os.getenv("AGNES_API_KEY", "").strip()


def _base_url() -> str:
    base = os.getenv("LLM_BASE_URL", "").strip()
    if base:
        # LLM_BASE_URL 通常是 https://apihub.agnes-ai.com/v1，图像端点同域
        return base.rstrip("/")
    return os.getenv("AGNES_BASE_URL", DEFAULT_BASE_URL).strip().rstrip("/")


def enabled() -> bool:
    return bool(_api_key())


def generate(
    prompt: str,
    *,
    size: str = "1K",
    ratio: str = "1:1",
    images: list[str] | None = None,
    return_base64: bool = False,
    timeout: int = 120,
) -> dict[str, Any]:
    """调用 Agnes Image 生成图像。

    Args:
        prompt: 图像生成/编辑指令。
        size: 1K / 2K / 3K / 4K，或精确尺寸如 1024x768。
        ratio: 宽高比，默认 1:1。
        images: 图生图/多图合成的输入图像 URL 或 Data URI 列表。
        return_base64: True 时返回 Base64，否则返回 URL。
        timeout: 请求超时（秒），建议 60-360。

    Returns:
        {"url": ...} 或 {"b64_json": ...}
    """
    key = _api_key()
    if not key:
        raise ImageError("未配置 Agnes API Key")

    if size not in VALID_SIZES and not _is_custom_size(size):
        raise ImageError(f"不支持的尺寸: {size}")
    if ratio not in VALID_RATIOS:
        raise ImageError(f"不支持的宽高比: {ratio}")

    body: dict[str, Any] = {
        "model": os.getenv("AGNES_IMAGE_MODEL", DEFAULT_MODEL),
        "prompt": prompt,
        "size": size,
        "ratio": ratio,
    }

    extra_body: dict[str, Any] = {}
    if images:
        extra_body["image"] = images
    if return_base64:
        extra_body["response_format"] = "b64_json"
    else:
        extra_body["response_format"] = "url"
    if extra_body:
        body["extra_body"] = extra_body

    url = f"{_base_url()}/images/generations"
    try:
        resp = requests.post(
            url,
            json=body,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise ImageError("图像生成请求失败", detail=str(exc)) from None

    try:
        data = resp.json()
    except ValueError:
        raise ImageError("图像生成返回非 JSON", detail=resp.text[:500], status=resp.status_code)

    if resp.status_code >= 400:
        raise ImageError(
            f"图像生成失败: HTTP {resp.status_code}",
            detail=str(data)[:800],
            status=resp.status_code,
        )

    items = data.get("data") or []
    if not items:
        raise ImageError("图像生成返回空 data", detail=str(data)[:500])
    first = items[0]
    if return_base64:
        b64 = first.get("b64_json")
        if not b64:
            raise ImageError("图像生成未返回 b64_json", detail=str(data)[:500])
        return {"b64_json": b64}
    img_url = first.get("url")
    if not img_url:
        raise ImageError("图像生成未返回 url", detail=str(data)[:500])
    return {"url": img_url}


def _is_custom_size(size: str) -> bool:
    """兼容 1024x768 这类精确尺寸写法。"""
    parts = size.lower().split("x")
    if len(parts) != 2:
        return False
    return parts[0].isdigit() and parts[1].isdigit()
