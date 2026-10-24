from __future__ import annotations

import json
import os
import re
from io import BytesIO
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, send_file, send_from_directory
from werkzeug.exceptions import RequestEntityTooLarge

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

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024
app.json.ensure_ascii = False
storage.init_db()

DEMO_TEXT = (DATA_DIR / "demo_paper.txt").read_text(encoding="utf-8")
DEMO_CASE_RAW = json.loads((DATA_DIR / "demo_case.json").read_text(encoding="utf-8"))
DEMO_LEVELS_RAW = json.loads((DATA_DIR / "demo_levels.json").read_text(encoding="utf-8"))


def api_error(message: str, status: int = 400, detail: str | None = None):
    payload: dict[str, Any] = {"error": message}
    if detail:
        payload["detail"] = detail[:1600]
    return jsonify(payload), status


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
    return jsonify(status)


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


@app.get("/api/library")
def api_library_list():
    return jsonify({"items": storage.list_papers()})


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
    try:
        payload, pdf_data, pdf_name = _library_save_payload()
        item = storage.save_paper(payload, pdf_data=pdf_data, pdf_name=pdf_name)
        return jsonify({"ok": True, "item": item}), 201 if item.get("created") else 200
    except ValueError as exc:
        return api_error(str(exc), 400)
    except Exception as exc:  # pragma: no cover - defensive
        app.logger.exception("library save failed")
        return api_error("保存案件时发生意外错误", 500, str(exc))


@app.get("/api/library/<paper_id>")
def api_library_get(paper_id: str):
    payload = storage.get_paper(paper_id)
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
    pdf = storage.get_pdf(paper_id)
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
    payload = request.get_json(silent=True) or {}
    progress = payload.get("progress")
    if not isinstance(progress, dict):
        return api_error("缺少进度数据")
    if len(json.dumps(progress, ensure_ascii=False)) > 500_000:
        return api_error("进度数据过大")
    item = storage.update_progress(paper_id, progress)
    if item is None:
        return api_error("案件不存在或已被删除", 404)
    return jsonify({"ok": True, "item": item})


@app.delete("/api/library/<paper_id>")
def api_library_delete(paper_id: str):
    if not storage.delete_paper(paper_id):
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

        title_guess = guess_title(text)
        sections = section_meta(text)
        digest = build_digest(text, max_chars=28000)
        status = public_status()

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
            return jsonify(
                {
                    "case_file": case,
                    "levels": levels,
                    "paper_text": DEMO_TEXT,
                    "meta": meta,
                    "pdf_url": "/api/demo/pdf",
                }
            )

        if not status["real_configured"]:
            return api_error(
                "云端模型尚未配置。请点击右上角「模型设置」填写 Base URL、API Key 和模型名；也可以先试玩示例论文。",
                400,
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
        return jsonify(
            {
                "case_file": case,
                "levels": [],
                "paper_text": text[:60000],
                "meta": meta,
            }
        )
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
