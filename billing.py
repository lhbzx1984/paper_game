"""一人付（YiRenFu）服务端计费客户端。

计费模式固定为「次数包」：每局游戏扣减 1 次（quota_unit=COUNT）。
凭证只保存在服务端环境变量，绝不能下发到浏览器。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
import time
from typing import Any
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv

load_dotenv()

DEFAULT_BASE_URL = "https://ai6666.com/opcpay/api/pay/v1"
CONSUME_REASON = "PaperQuest 开局一次"


class BillingError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
        detail: str | None = None,
        request_id: str | None = None,
    ):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.detail = detail
        self.request_id = request_id


def _env_flag(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


class BillingClient:
    def __init__(self) -> None:
        # 优先使用一人付官方约定的 opcpay_api_key，兼容历史 YIRENFU_API_KEY。
        self.api_key = (
            os.getenv("opcpay_api_key", "").strip()
            or os.getenv("OPCPAY_API_KEY", "").strip()
            or os.getenv("YIRENFU_API_KEY", "").strip()
        )
        self.base_url = (
            os.getenv("opcpay_base_url", "").strip()
            or os.getenv("OPCPAY_BASE_URL", "").strip()
            or os.getenv("YIRENFU_BASE_URL", DEFAULT_BASE_URL).strip()
        ).rstrip("/")
        self.timeout = float(os.getenv("YIRENFU_TIMEOUT", "60") or 60)
        self._product_cache: dict[str, Any] | None = None
        self._product_cache_at = 0.0
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return bool(self.api_key) and not _env_flag("BILLING_DISABLED")

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _request(self, path: str, body: dict[str, Any] | None = None, method: str | None = None) -> dict[str, Any]:
        if not self.api_key:
            raise BillingError("尚未配置一人付服务端凭证", code="NOT_CONFIGURED")
        url = f"{self.base_url}{path}"
        verb = method or ("GET" if body is None else "POST")
        try:
            response = requests.request(
                verb,
                url,
                json=body,
                headers=self._headers(),
                timeout=self.timeout,
                allow_redirects=False,
            )
        except requests.RequestException as exc:
            raise BillingError("无法连接一人付服务，请稍后重试", detail=str(exc)) from None

        request_id = response.headers.get("X-Request-ID") or ""
        try:
            data = response.json()
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}

        if response.status_code >= 400:
            code = str(data.get("error_code") or data.get("code") or "")
            message = str(data.get("error") or data.get("message") or "").strip()
            raise BillingError(
                _HTTP_MESSAGES.get(response.status_code, f"一人付返回 HTTP {response.status_code}"),
                status=response.status_code,
                code=code or None,
                detail=json.dumps(data, ensure_ascii=False)[:1200] if data else message or None,
                request_id=request_id or None,
            )
        return data

    def product(self, force: bool = False) -> dict[str, Any]:
        with self._lock:
            fresh = self._product_cache is not None and (time.monotonic() - self._product_cache_at) < 60
            if fresh and not force:
                return self._product_cache or {}
        data = self._request("/product")
        with self._lock:
            self._product_cache = data
            self._product_cache_at = time.monotonic()
        return data

    def access(self, user_id: str, amount: int = 1) -> dict[str, Any]:
        return self._request("/access", {"user_id": user_id, "amount": amount})

    def consume(self, user_id: str, idempotency_key: str, amount: int = 1, reason: str = CONSUME_REASON) -> dict[str, Any]:
        return self._request(
            "/consume",
            {
                "user_id": user_id,
                "idempotency_key": idempotency_key,
                "amount": amount,
                "reason": reason,
            },
        )

    def consumption(self, user_id: str, idempotency_key: str) -> dict[str, Any]:
        return self._request("/consumption", {"user_id": user_id, "idempotency_key": idempotency_key})

    def purchase(self, user_id: str, idempotency_key: str, sku_id: str = "", callback_url: str = "") -> dict[str, Any]:
        body: dict[str, Any] = {"user_id": user_id, "idempotency_key": idempotency_key}
        if sku_id:
            body["sku_id"] = sku_id
        if callback_url:
            body["callback_url"] = callback_url
        return self._request("/purchase", body)

    def purchase_query(self, user_id: str, idempotency_key: str) -> dict[str, Any]:
        """恢复原购买入口记录（不是支付宝逐笔支付状态）。"""
        return self._request("/purchase/query", {"user_id": user_id, "idempotency_key": idempotency_key})

    def webhook(self) -> dict[str, Any]:
        """查询当前 webhook 配置。"""
        return self._request("/webhook")

    def save_webhook(self, url: str, enabled: bool = True) -> dict[str, Any]:
        """注册/更新 webhook 回调地址。"""
        return self._request("/webhook", {"url": url, "enabled": enabled}, method="PUT")

    def rotate_webhook(self) -> dict[str, Any]:
        """轮换 webhook 签名密钥。"""
        return self._request("/webhook/rotate", {})

    def events(self, options: dict[str, Any] | None = None) -> dict[str, Any]:
        """列出权益/核销事件。"""
        return self._request("/events/list", options or {})

    def capabilities(self) -> dict[str, Any]:
        return self._request("/capabilities")


client = BillingClient()

_HTTP_MESSAGES = {
    400: "一人付请求参数不正确",
    401: "一人付服务端凭证无效，请检查 YIRENFU_API_KEY",
    404: "一人付找不到对应的原业务记录",
    409: "一人付收费配置或业务编号冲突",
    429: "一人付请求过于频繁，请稍后再试",
    500: "一人付服务异常，请稍后重试",
    502: "一人付上游支付宝返回异常",
    503: "一人付尚未完成支付宝正式配置",
}


def enabled() -> bool:
    return client.enabled


def public_info() -> dict[str, Any]:
    host = ""
    if client.base_url:
        host = urlparse(client.base_url).netloc or client.base_url
    return {
        "enabled": client.enabled,
        "host": host,
        "reason": CONSUME_REASON,
    }


def quota_ready(product: dict[str, Any]) -> tuple[bool, str, list[dict[str, Any]]]:
    """判断一人付产品是否按次数计费且已启用，返回 (是否可用, 提示, 可售套餐)。"""
    options = product.get("charging_options") or []
    quota_options = [
        item for item in options
        if isinstance(item, dict)
        and item.get("entitlement_rule") == "QUOTA"
        and item.get("billing_mode") == "QUANTITY"
        and item.get("quota_unit") in {"COUNT", None}
    ]
    capability = str(product.get("capability_status") or "").upper()
    ready = (
        product.get("billing_mode") == "QUANTITY"
        and product.get("quota_unit") == "COUNT"
        and capability == "ENABLED"
        and bool(quota_options)
    )
    if ready:
        return True, "", quota_options
    if capability and capability != "ENABLED":
        message = "一人付产品当前未启用（capability_status != ENABLED），请在控制台开启后再收款。"
    else:
        message = (
            "一人付产品当前不是「次数包」（需要 QUANTITY / COUNT / QUOTA），"
            "请在控制台改成按次计费，并上架「1 元 1 次」「9.9 元 10 次」两个套餐后再收款。"
        )
    return False, message, quota_options


def webhook_secret() -> str:
    return (
        os.getenv("opcpay_webhook_secret", "").strip()
        or os.getenv("OPCPAY_WEBHOOK_SECRET", "").strip()
        or os.getenv("YIRENFU_WEBHOOK_SECRET", "").strip()
    )


def verify_webhook(raw_body: bytes, headers: dict[str, str], secret: str, now: float | None = None) -> dict[str, Any]:
    """校验一人付通知签名。headers 的键必须是小写。"""
    if not isinstance(raw_body, bytes) or not raw_body:
        raise ValueError("通知正文为空")
    if not secret:
        raise ValueError("未配置通知签名密钥")
    stamp = str(headers.get("yirenfu-timestamp", ""))
    if not stamp.isascii() or not stamp.isdigit() or not 10 <= len(stamp) <= 12:
        raise ValueError("通知时间戳无效")
    if abs((time.time() if now is None else now) - int(stamp)) > 300:
        raise ValueError("通知已过期")
    expected = "v1=" + hmac.new(
        secret.encode("utf-8"),
        stamp.encode("utf-8") + b"." + raw_body,
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, str(headers.get("yirenfu-signature", ""))):
        raise ValueError("通知签名不匹配")
    event = json.loads(raw_body)
    if not isinstance(event, dict) or not event.get("id"):
        raise ValueError("通知缺少事件 ID")
    if str(event["id"]) != str(headers.get("yirenfu-event-id", "")):
        raise ValueError("通知事件 ID 不一致")
    return event
