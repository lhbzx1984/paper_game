from __future__ import annotations

import json
import os
import re
import uuid
from hashlib import sha256
from datetime import timedelta
from io import BytesIO
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, send_file, send_from_directory
from werkzeug.exceptions import RequestEntityTooLarge

import auth
import billing
from llm_client import LLMError, chat_json, public_status, set_config, test_connection
from paper_utils import (
    build_digest,
    extract_pdf_bytes,
    guess_title,
    normalize_case,
    normalize_levels,
    section_meta,
    verify_quotes,
)
from prompts import (
    CASE_SYSTEM,
    LEVELS_SYSTEM,
    build_case_prompt,
    build_levels_prompt,
)
import storage


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "static"
GAME_KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")


def _env_flag(name: str) -> bool:
    return os.getenv(name, "0").strip().lower() in {"1", "true", "yes", "on"}


app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024
app.json.ensure_ascii = False
app.secret_key = auth.secret_key()
app.config.update(
    SESSION_COOKIE_NAME="pq_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=_env_flag("COOKIE_SECURE"),
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)
storage.init_db()


def api_error(
    message: str,
    status: int = 400,
    detail: str | None = None,
    code: str | None = None,
    extra: dict[str, Any] | None = None,
):
    payload: dict[str, Any] = {"error": message}
    if detail:
        payload["detail"] = detail[:1600]
    if code:
        payload["code"] = code
    if extra:
        payload.update(extra)
    return jsonify(payload), status

DEMO_TEXT = (DATA_DIR / "demo_paper.txt").read_text(encoding="utf-8")
DEMO_CASE_RAW = json.loads((DATA_DIR / "demo_case.json").read_text(encoding="utf-8"))
DEMO_LEVELS_RAW = json.loads((DATA_DIR / "demo_levels.json").read_text(encoding="utf-8"))


def _decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "utf-16", "gb18030", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _demo_payload() -> dict[str, Any]:
    case = normalize_case(DEMO_CASE_RAW, DEMO_TEXT)
    levels = normalize_levels(DEMO_LEVELS_RAW, DEMO_TEXT)
    meta = {
        "source": "demo",
        "mock": False,
        "pages": 5,
        "chars": len(DEMO_TEXT),
        "sections": section_meta(DEMO_TEXT),
        "title_guess": case["paper"]["title"],
        "quote_stats": {"total": 12, "verified": 12},
        "notice": "",
    }
    return {
        "case_file": case,
        "levels": levels,
        "paper_text": DEMO_TEXT,
        "meta": meta,
        "pdf_url": "/api/demo/pdf",
    }


@app.after_request
def add_no_cache(response):
    if request.path.startswith("/static/") or request.path == "/":
        response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


# ---------------------------------------------------------------- accounts & billing


def _public_user(user: dict[str, Any] | None) -> dict[str, Any] | None:
    if not user:
        return None
    return {
        "email": user["email"],
        "free_trial_available": not bool(user["free_game_used"]),
        "created_at": user["created_at"],
    }


def _quota_of(access: dict[str, Any]) -> dict[str, Any]:
    return {
        "unit": access.get("quota_unit") or "COUNT",
        "total": access.get("total"),
        "used": access.get("used"),
        "remaining": access.get("remaining"),
        "as_of_time": access.get("as_of_time"),
    }


def _billing_state(user: dict[str, Any] | None) -> dict[str, Any]:
    info = billing.public_info()
    if not info["enabled"]:
        return {
            "enabled": False,
            "free_trial_available": False,
            "quota": None,
            "notice": "服务端未配置一人付凭证，当前不扣次数。",
        }
    state: dict[str, Any] = {
        "enabled": True,
        "free_trial_available": bool(user and not user["free_game_used"]),
        "quota": None,
        "notice": "",
        "error": "",
    }
    if user:
        try:
            access = billing.client.access(user["id"], 1)
            state["quota"] = _quota_of(access)
        except billing.BillingError as exc:
            state["error"] = exc.message
            state["notice"] = "暂时读不到剩余次数，请稍后刷新。"
    try:
        product = billing.client.product()
        state["product"] = {
            "name": product.get("product_name") or "PaperQuest",
            "billing_mode": product.get("billing_mode") or "",
            "quota_unit": product.get("quota_unit") or "",
            "capability_status": product.get("capability_status") or "",
            "charging_options": product.get("charging_options") or [],
        }
        if product.get("quota_unit") and product.get("quota_unit") != "COUNT":
            state["notice"] = "一人付项目当前不是「次数包（COUNT）」，请在控制台切换后再收款。"
    except billing.BillingError:
        pass
    if state["free_trial_available"]:
        state["notice"] = "首局免费，本局不扣次数。"
    return state


def _account_payload(user: dict[str, Any] | None) -> dict[str, Any]:
    return {"user": _public_user(user), "billing": _billing_state(user)}


def _game_key_from_request() -> str:
    raw = (request.form.get("game_id") or "").strip()
    if not raw:
        payload = request.get_json(silent=True)
        if isinstance(payload, dict):
            raw = str(payload.get("game_id") or "").strip()
    if not raw:
        return uuid.uuid4().hex
    if not GAME_KEY_RE.match(raw):
        raise ValueError("局号格式不正确")
    return raw


def _billing_gate(user: dict[str, Any], game_key: str, content_hash: str) -> tuple[dict[str, Any] | None, Any]:
    """确定这一局是否已付费；返回 (game, error_response)。"""
    existing = storage.get_game(user["id"], game_key)
    if existing:
        if existing["content_hash"] and content_hash and existing["content_hash"] != content_hash:
            return None, api_error(
                "这个局号已经用于另一篇论文，请重新上传开始新的一局。",
                409,
                code="GAME_KEY_REUSED",
            )
        if existing["charge_status"] in {"free", "charged", "disabled"}:
            if existing["billing_mode"] == "free":
                storage.mark_free_trial_used(user["id"])
            storage.update_game(user["id"], game_key, status="analyzing")
            return existing, None
        # 上一次 /consume 结果为 PROCESSING / UNKNOWN，先查原核销结果。
        try:
            result = billing.client.consumption(user["id"], game_key)
        except billing.BillingError as exc:
            return None, api_error(
                "上一局的扣费结果还在确认中，请稍后重试（沿用同一局号，不会重复扣费）。",
                409,
                exc.message,
                code="BILLING_PENDING",
            )
        status = str(result.get("status") or "").upper()
        if status == "SUCCEEDED" and result.get("confirmed") is True:
            storage.update_game(user["id"], game_key, charge_status="charged", status="analyzing")
            return existing, None
        if status in {"PROCESSING", "UNKNOWN"}:
            return None, api_error(
                "上一局的扣费结果还在确认中，请稍后重试（不会重复扣费）。",
                409,
                code="BILLING_PENDING",
            )
        return None, api_error(
            "上一局扣费未成功，请重新开始一局。",
            402,
            code="BILLING_FAILED",
            extra={"billing": _billing_state(user)},
        )

    if storage.mark_free_trial_used(user["id"]):
        game = storage.create_game(game_key, user["id"], "free", "free", content_hash=content_hash)
        return game, None

    try:
        access = billing.client.access(user["id"], 1)
    except billing.BillingError as exc:
        return None, api_error("暂时无法读取剩余次数，请稍后重试。", 502, exc.message, code="BILLING_UNAVAILABLE")

    remaining = access.get("remaining")
    if access.get("requires_consumption") and isinstance(remaining, int) and remaining < 1:
        return None, api_error(
            "本局需要 1 次游戏次数，当前次数不足，请先购买。",
            402,
            code="QUOTA_REQUIRED",
            extra={"billing": _billing_state(user)},
        )

    try:
        result = billing.client.consume(user["id"], game_key, 1, billing.CONSUME_REASON)
    except billing.BillingError as exc:
        code = "BILLING_FAILED" if exc.status in {409, 400} else "BILLING_UNAVAILABLE"
        return None, api_error(
            f"扣减次数失败：{exc.message}",
            402 if code == "BILLING_FAILED" else 502,
            exc.detail,
            code=code,
        )

    status = str(result.get("status") or "").upper()
    if status == "SUCCEEDED" and result.get("confirmed") is True:
        game = storage.create_game(game_key, user["id"], "quota", "charged", content_hash=content_hash)
        return game, None
    if status in {"PROCESSING", "UNKNOWN"}:
        storage.create_game(game_key, user["id"], "quota", "pending", content_hash=content_hash)
        return None, api_error(
            "扣费结果正在确认，请稍后用同一篇论文重试。",
            409,
            code="BILLING_PENDING",
        )
    reason = result.get("reason_code") or result.get("message") or "次数扣减未成功"
    storage.create_game(
        game_key,
        user["id"],
        "quota",
        "failed",
        status="failed",
        content_hash=content_hash,
    )
    return None, api_error(
        "次数不足或扣费未成功，请购买后再开始。",
        402,
        str(reason),
        code="QUOTA_REQUIRED",
        extra={"billing": _billing_state(user)},
    )


def _finish_game(user: dict[str, Any] | None, game_key: str, delivered: bool) -> None:
    if user is None or not billing.enabled():
        return
    game = storage.get_game(user["id"], game_key)
    storage.update_game(user["id"], game_key, status="delivered" if delivered else "failed")
    if not delivered and game and game["billing_mode"] == "free":
        storage.restore_free_trial(user["id"])


def _require_login():
    user = auth.current_user()
    if user is None:
        return None, api_error("请先登录后再开始调查。", 401, code="LOGIN_REQUIRED")
    return user, None


@app.get("/")
def index():
    return send_from_directory(str(STATIC_DIR), "index.html")


@app.get("/favicon.ico")
def favicon():
    return ("", 204)


@app.get("/api/status")
def api_status():
    status = public_status()
    status["demo_available"] = True
    status["billing"] = billing.public_info()
    return jsonify(status)


@app.get("/api/auth/me")
def api_auth_me():
    return jsonify(_account_payload(auth.current_user()))


@app.post("/api/auth/register")
def api_auth_register():
    payload = request.get_json(silent=True) or {}
    try:
        user = auth.register(str(payload.get("email") or ""), str(payload.get("password") or ""))
    except auth.AuthError as exc:
        return api_error(exc.message, 400, code=exc.code)
    return jsonify({"ok": True, **_account_payload(user)}), 201


@app.post("/api/auth/login")
def api_auth_login():
    payload = request.get_json(silent=True) or {}
    try:
        user = auth.login(str(payload.get("email") or ""), str(payload.get("password") or ""))
    except auth.AuthError as exc:
        return api_error(exc.message, 401, code=exc.code)
    return jsonify({"ok": True, **_account_payload(user)})


@app.post("/api/auth/logout")
def api_auth_logout():
    auth.logout()
    return jsonify({"ok": True, **_account_payload(None)})


@app.get("/api/billing/status")
def api_billing_status():
    user = auth.current_user()
    return jsonify({"user": _public_user(user), "billing": _billing_state(user)})


@app.post("/api/billing/purchase")
def api_billing_purchase():
    if not billing.enabled():
        return api_error("服务端尚未配置一人付，暂停售卖。", 503, code="BILLING_DISABLED")
    user, error = _require_login()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    sku_id = str(payload.get("sku_id") or "").strip()
    if len(sku_id) > 128:
        return api_error("套餐编号不正确")
    callback = os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")
    key = f"buy-{uuid.uuid4().hex}"
    try:
        result = billing.client.purchase(
            user["id"],
            key,
            sku_id=sku_id,
            callback_url=f"{callback}/" if callback else "",
        )
    except billing.BillingError as exc:
        return api_error(f"创建购买入口失败：{exc.message}", 502, exc.detail, code=exc.code)
    status = str(result.get("status") or "").upper()
    if status != "READY":
        detail = result.get("message") or result.get("reason_code") or ""
        return api_error(
            "购买入口暂时不可用，请稍后重试。",
            409,
            str(detail),
            code="PURCHASE_NOT_READY",
        )
    return jsonify(
        {
            "ok": True,
            "idempotency_key": key,
            "purchase_url": result.get("purchase_url") or "",
            "purchase_qr_code": result.get("purchase_qr_code") or "",
            "expire_time": result.get("expire_time") or "",
            "option": result.get("charging_option") or None,
        }
    )


@app.post("/api/billing/webhook")
def api_billing_webhook():
    secret = os.getenv("YIRENFU_WEBHOOK_SECRET", "").strip()
    if not secret:
        return api_error("服务端未配置通知密钥", 503, code="WEBHOOK_NOT_CONFIGURED")
    raw = request.get_data(cache=True)
    headers = {key.lower(): value for key, value in request.headers.items()}
    try:
        event = billing.verify_webhook(raw, headers, secret)
    except (ValueError, json.JSONDecodeError) as exc:
        return api_error(f"通知验签失败：{exc}", 401, code="INVALID_SIGNATURE")
    storage.record_billing_event(str(event["id"]), event)
    return jsonify({"ok": True})


@app.post("/api/config")
def api_config():
    payload = request.get_json(silent=True) or {}
    try:
        status = set_config(
            payload.get("base_url"),
            payload.get("api_key"),
            payload.get("model"),
        )
        return jsonify({"ok": True, "status": status})
    except LLMError as exc:
        return api_error(exc.message, 400, exc.detail)


@app.post("/api/config/test")
def api_config_test():
    try:
        result = test_connection()
        return jsonify(result)
    except LLMError as exc:
        return api_error(exc.message, 400, exc.detail)


def _library_owner():
    user = auth.current_user()
    if billing.enabled() and user is None:
        return None, api_error("请先登录后再使用资料库。", 401, code="LOGIN_REQUIRED")
    return (user["id"] if user else ""), None


@app.get("/api/library")
def api_library_list():
    owner, error = _library_owner()
    if error:
        return error
    return jsonify({"items": storage.list_papers(owner)})


def _library_save_payload():
    if request.mimetype == "multipart/form-data":
        raw = request.form.get("payload")
        if not raw:
            raise ValueError("缺少案件数据")
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError):
            raise ValueError("案件数据格式不正确")
        if not isinstance(payload, dict):
            raise ValueError("案件数据格式不正确")
        pdf = request.files.get("pdf")
        pdf_data = pdf.read() if pdf and pdf.filename else None
        return payload, pdf_data, pdf.filename if pdf_data else ""
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        raise ValueError("案件数据格式不正确")
    return payload, None, ""


@app.post("/api/library")
def api_library_save():
    owner, error = _library_owner()
    if error:
        return error
    try:
        payload, pdf_data, pdf_name = _library_save_payload()
        item = storage.save_paper(payload, pdf_data=pdf_data, pdf_name=pdf_name, user_id=owner)
        return jsonify({"ok": True, "item": item}), 201 if item.get("created") else 200
    except ValueError as exc:
        return api_error(str(exc), 400)
    except Exception as exc:  # pragma: no cover - defensive
        app.logger.exception("library save failed")
        return api_error("保存案件时发生意外错误", 500, str(exc))


@app.get("/api/library/<paper_id>")
def api_library_get(paper_id: str):
    owner, error = _library_owner()
    if error:
        return error
    payload = storage.get_paper(paper_id, owner)
    if payload is None:
        return api_error("案件不存在或已被删除", 404)
    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    if payload["item"].get("has_pdf"):
        payload["pdf_url"] = f"/api/library/{paper_id}/pdf"
    elif meta.get("source") in {"demo", "mock"}:
        payload["pdf_url"] = "/api/demo/pdf"
    else:
        payload["pdf_url"] = ""
    return jsonify(payload)


@app.get("/api/library/<paper_id>/pdf")
def api_library_pdf(paper_id: str):
    owner, error = _library_owner()
    if error:
        return error
    pdf = storage.get_pdf(paper_id, owner)
    if pdf is None:
        return api_error("这个案件没有保存 PDF 原件", 404)
    data, name = pdf
    return send_file(
        BytesIO(data),
        mimetype="application/pdf",
        download_name=name or "paper.pdf",
        as_attachment=request.args.get("download") == "1",
    )


@app.get("/api/demo/pdf")
def api_demo_pdf():
    path = DATA_DIR / "sample_paper.pdf"
    if not path.exists():
        return api_error("示例 PDF 不存在", 404)
    return send_file(
        path,
        mimetype="application/pdf",
        download_name="sample_paper.pdf",
        as_attachment=request.args.get("download") == "1",
    )


@app.patch("/api/library/<paper_id>")
def api_library_progress(paper_id: str):
    owner, error = _library_owner()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    progress = payload.get("progress")
    if not isinstance(progress, dict):
        return api_error("缺少进度数据")
    if len(json.dumps(progress, ensure_ascii=False)) > 500_000:
        return api_error("进度数据过大")
    item = storage.update_progress(paper_id, progress, owner)
    if item is None:
        return api_error("案件不存在或已被删除", 404)
    return jsonify({"ok": True, "item": item})


@app.delete("/api/library/<paper_id>")
def api_library_delete(paper_id: str):
    owner, error = _library_owner()
    if error:
        return error
    if not storage.delete_paper(paper_id, owner):
        return api_error("案件不存在或已被删除", 404)
    return jsonify({"ok": True})


@app.get("/api/demo")
def api_demo():
    return jsonify(_demo_payload())


@app.post("/api/analyze")
def api_analyze():
    file = request.files.get("file")
    pasted_text = (request.form.get("text") or "").strip()
    filename = ""
    pages = 0

    try:
        if file and file.filename:
            filename = file.filename
            data = file.read()
            if not data:
                return api_error("上传的文件是空的")
            lower = filename.lower()
            if lower.endswith(".pdf"):
                text, pages = extract_pdf_bytes(data)
            elif lower.endswith((".txt", ".md")):
                text = _decode_text(data)
            else:
                return api_error("目前支持 PDF、TXT 和 Markdown 文件")
        elif pasted_text:
            text = pasted_text
        else:
            return api_error("请上传论文文件，或粘贴论文文本")

        text = text.strip()
        if len(text) < 800:
            return api_error("论文文本太短。请确认 PDF 可以提取文字（扫描版需要先 OCR），或粘贴更完整的原文。")

        status = public_status()
        if not status["mock"] and not status["real_configured"]:
            return api_error(
                "云端模型尚未配置。请点击右上角「模型设置」填写 Base URL、API Key 和模型名；也可以先试玩示例论文。",
                400,
            )

        # 计费：每上传并解析一篇论文算一局；每名用户的第一局免费。
        user = auth.current_user()
        if billing.enabled() and user is None:
            return api_error("请先登录后再开始调查。", 401, code="LOGIN_REQUIRED")
        try:
            game_key = _game_key_from_request()
        except ValueError as exc:
            return api_error(str(exc))
        if billing.enabled():
            text_hash = sha256(text.encode("utf-8", errors="replace")).hexdigest()
            _game, gate_error = _billing_gate(user, game_key, text_hash)
            if gate_error:
                return gate_error

        delivered = False
        try:
            title_guess = guess_title(text)
            sections = section_meta(text)
            digest = build_digest(text, max_chars=28000)

            if status["mock"]:
                case = normalize_case(DEMO_CASE_RAW, DEMO_TEXT, title_guess)
                levels = normalize_levels(DEMO_LEVELS_RAW, DEMO_TEXT)
                meta = {
                    "source": "mock",
                    "mock": True,
                    "pages": pages,
                    "chars": len(text),
                    "sections": sections,
                    "title_guess": title_guess,
                    "quote_stats": {"total": 12, "verified": 12},
                    "notice": "当前启用了模拟模型：案件档案与关卡来自示例论文，只用于演示流程。配置真实云端模型后会改为解析你上传的论文。",
                }
                delivered = True
                return jsonify(
                    {
                        "case_file": case,
                        "levels": levels,
                        "paper_text": DEMO_TEXT,
                        "meta": meta,
                        "pdf_url": "/api/demo/pdf",
                        "game_id": game_key,
                    }
                )

            raw = chat_json(
                CASE_SYSTEM,
                build_case_prompt(digest, title_guess, [s["name"] for s in sections]),
                max_tokens=4500,
                temperature=0.15,
            )
            case = normalize_case(raw, text, title_guess)
            quote_stats = verify_quotes(case, text)
            if quote_stats["total"] == 0 or quote_stats["verified"] == 0:
                return api_error(
                    "模型生成的案件档案没有一条引文能对上原文，已停止生成。请重试，或换用更强的模型。",
                    502,
                    "建议使用支持长上下文、指令遵循较好的模型，并确认 PDF 文本提取完整。",
                )
            notice = ""
            if quote_stats["verified"] < quote_stats["total"] * 0.5:
                notice = "部分引文未能与原文自动对齐，已标记为「待核验」。建议进入原文核对后再开始游戏。"
            meta = {
                "source": "upload",
                "mock": False,
                "pages": pages,
                "chars": len(text),
                "sections": sections,
                "title_guess": title_guess,
                "quote_stats": quote_stats,
                "notice": notice,
                "filename": filename,
                "model": status["model"],
            }
            delivered = True
            return jsonify(
                {
                    "case_file": case,
                    "levels": [],
                    "paper_text": text[:60000],
                    "meta": meta,
                    "game_id": game_key,
                }
            )
        finally:
            _finish_game(user, game_key, delivered)
    except LLMError as exc:
        return api_error(exc.message, 502, exc.detail)
    except ValueError as exc:
        return api_error(f"案件档案生成失败：{exc}", 502)
    except Exception as exc:  # pragma: no cover - defensive
        app.logger.exception("analyze failed")
        return api_error("解析论文时发生意外错误", 500, str(exc))


@app.post("/api/generate")
def api_generate():
    payload = request.get_json(silent=True) or {}
    if billing.enabled() and auth.current_user() is None:
        return api_error("请先登录后再生成关卡。", 401, code="LOGIN_REQUIRED")
    case_file = payload.get("case_file")
    paper_text = str(payload.get("paper_text") or "")
    if not isinstance(case_file, dict) or not case_file.get("paper"):
        return api_error("缺少案件档案，请先解析论文")
    if len(paper_text.strip()) < 800:
        return api_error("缺少论文原文，无法核验关卡引文")

    try:
        status = public_status()
        if status["mock"]:
            levels = normalize_levels(DEMO_LEVELS_RAW, DEMO_TEXT)
            return jsonify(
                {
                    "levels": levels,
                    "meta": {
                        "source": "mock",
                        "mock": True,
                        "quote_stats": {"total": 12, "verified": 12},
                        "notice": "模拟模型：关卡来自示例论文，只用于演示流程。",
                    },
                }
            )
        if not status["real_configured"]:
            return api_error("云端模型尚未配置，无法生成关卡", 400)

        digest = build_digest(paper_text, max_chars=28000)
        raw = chat_json(
            LEVELS_SYSTEM,
            build_levels_prompt(case_file, digest),
            max_tokens=5500,
            temperature=0.35,
        )
        levels = normalize_levels(raw, paper_text)
        quote_stats = verify_quotes(levels, paper_text)
        if quote_stats["total"] == 0 or quote_stats["verified"] == 0:
            return api_error(
                "关卡引文无法与原文对齐，已停止生成。请重试，或换用指令遵循更强的模型。",
                502,
            )
        notice = ""
        if quote_stats["verified"] < quote_stats["total"] * 0.5:
            notice = "部分关卡引文未能自动对齐，已标记为「待核验」。"
        return jsonify(
            {
                "levels": levels,
                "meta": {
                    "source": "upload",
                    "mock": False,
                    "quote_stats": quote_stats,
                    "notice": notice,
                },
            }
        )
    except LLMError as exc:
        return api_error(exc.message, 502, exc.detail)
    except ValueError as exc:
        return api_error(f"关卡生成失败：{exc}", 502)
    except Exception as exc:  # pragma: no cover - defensive
        app.logger.exception("generate failed")
        return api_error("生成关卡时发生意外错误", 500, str(exc))


@app.errorhandler(RequestEntityTooLarge)
def handle_large_file(_exc):
    return api_error("文件太大，请上传 25 MB 以内的论文", 413)


@app.errorhandler(404)
def handle_not_found(_exc):
    if request.path.startswith("/api/"):
        return api_error("接口不存在", 404)
    return send_from_directory(str(STATIC_DIR), "index.html")


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5173"))
    app.run(host="127.0.0.1", port=port, debug=False)
