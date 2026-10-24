"""SQLite persistence for saved paper cases, generated levels and progress."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent / "data" / "paperquest.db"
MAX_PDF_BYTES = 25 * 1024 * 1024


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with closing(_connect()) as conn, conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS papers (
                id TEXT PRIMARY KEY,
                content_hash TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL DEFAULT '',
                authors TEXT NOT NULL DEFAULT '',
                year TEXT NOT NULL DEFAULT '',
                venue TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT 'upload',
                filename TEXT NOT NULL DEFAULT '',
                paper_text TEXT NOT NULL,
                case_json TEXT NOT NULL,
                levels_json TEXT NOT NULL,
                meta_json TEXT NOT NULL,
                progress_json TEXT NOT NULL DEFAULT '{}',
                level_count INTEGER NOT NULL DEFAULT 0,
                score INTEGER NOT NULL DEFAULT 0,
                completed INTEGER NOT NULL DEFAULT 0,
                pdf_name TEXT NOT NULL DEFAULT '',
                pdf_size INTEGER NOT NULL DEFAULT 0,
                pdf_blob BLOB,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_papers_updated ON papers(updated_at DESC);
            """
        )
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(papers)").fetchall()}
        if "pdf_name" not in columns:
            conn.execute("ALTER TABLE papers ADD COLUMN pdf_name TEXT NOT NULL DEFAULT ''")
        if "pdf_size" not in columns:
            conn.execute("ALTER TABLE papers ADD COLUMN pdf_size INTEGER NOT NULL DEFAULT 0")
        if "pdf_blob" not in columns:
            conn.execute("ALTER TABLE papers ADD COLUMN pdf_blob BLOB")


def _content_hash(paper_text: str, title: str) -> str:
    payload = f"{title.strip()}\n{paper_text.strip()}".encode("utf-8", errors="replace")
    return hashlib.sha256(payload).hexdigest()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _loads(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback


def _paper_meta(case_file: dict[str, Any], meta: dict[str, Any]) -> dict[str, str]:
    paper = case_file.get("paper") if isinstance(case_file, dict) else {}
    paper = paper if isinstance(paper, dict) else {}
    return {
        "title": str(paper.get("title") or "未命名论文")[:300],
        "authors": str(paper.get("authors") or "")[:400],
        "year": str(paper.get("year") or "")[:40],
        "venue": str(paper.get("venue") or "")[:200],
        "source": str(meta.get("source") or "upload")[:40],
        "filename": str(meta.get("filename") or "")[:300],
    }


def _progress_flags(levels: list[Any], progress: dict[str, Any]) -> tuple[int, int, int]:
    score = progress.get("score")
    try:
        score = max(0, min(100, int(score)))
    except (TypeError, ValueError):
        score = 0
    completed = 1 if progress.get("completedAt") or progress.get("completed") else 0
    return len(levels), score, completed


def _completed_level_count(progress: dict[str, Any]) -> int:
    explicit = progress.get("completedLevels")
    if isinstance(explicit, (int, float)):
        try:
            return max(0, int(explicit))
        except (TypeError, ValueError, OverflowError):
            pass
    states = progress.get("levelStates")
    if not isinstance(states, list):
        return 0
    count = 0
    for state in states:
        if not isinstance(state, dict):
            continue
        if state.get("resolved") is True or (
            state.get("mainResolved") is True and state.get("followupResolved") is True
        ):
            count += 1
    return count


def _summary(row: sqlite3.Row) -> dict[str, Any]:
    progress = _loads(row["progress_json"], {}) if "progress_json" in row.keys() else {}
    if not isinstance(progress, dict):
        progress = {}
    try:
        hints_used = max(0, int(progress.get("hintsUsed") or 0))
    except (TypeError, ValueError):
        hints_used = 0
    return {
        "id": row["id"],
        "title": row["title"],
        "authors": row["authors"],
        "year": row["year"],
        "venue": row["venue"],
        "source": row["source"],
        "filename": row["filename"],
        "level_count": row["level_count"],
        "score": row["score"],
        "completed": bool(row["completed"]),
        "completed_levels": min(row["level_count"], _completed_level_count(progress)),
        "started": bool(progress.get("startedAt") or progress.get("levelStates")),
        "hints_used": hints_used,
        "has_pdf": bool(row["pdf_size"]) if "pdf_size" in row.keys() else False,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def save_paper(
    payload: dict[str, Any],
    pdf_data: bytes | None = None,
    pdf_name: str = "",
) -> dict[str, Any]:
    case_file = payload.get("case_file")
    paper_text = str(payload.get("paper_text") or "")
    levels = payload.get("levels")
    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    progress = payload.get("progress") if isinstance(payload.get("progress"), dict) else {}

    if not isinstance(case_file, dict) or not isinstance(case_file.get("paper"), dict):
        raise ValueError("案件档案不完整")
    if not isinstance(levels, list) or not levels:
        raise ValueError("案件还没有生成关卡，暂时不能保存")
    if not paper_text.strip():
        raise ValueError("缺少论文原文，无法保存案件")

    if pdf_data is not None:
        if not pdf_data:
            pdf_data = None
        elif len(pdf_data) > MAX_PDF_BYTES:
            raise ValueError("PDF 原件超过 25 MB，无法一并保存")
        elif not pdf_data.startswith(b"%PDF"):
            raise ValueError("上传的 PDF 原件格式不正确")
        else:
            pdf_name = (pdf_name or "paper.pdf")[:300]

    paper = case_file["paper"]
    title = str(paper.get("title") or "未命名论文")
    details = _paper_meta(case_file, meta)
    content_hash = _content_hash(paper_text, title)
    level_count, score, completed = _progress_flags(levels, progress)
    now = _now()

    with closing(_connect()) as conn, conn:
        existing = conn.execute(
            "SELECT id, created_at FROM papers WHERE content_hash = ?",
            (content_hash,),
        ).fetchone()
        if existing:
            paper_id = existing["id"]
            created_at = existing["created_at"]
            if pdf_data is not None:
                conn.execute(
                    """
                    UPDATE papers SET
                        title = ?, authors = ?, year = ?, venue = ?, source = ?, filename = ?,
                        paper_text = ?, case_json = ?, levels_json = ?, meta_json = ?,
                        progress_json = ?, level_count = ?, score = ?, completed = ?,
                        pdf_name = ?, pdf_size = ?, pdf_blob = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        details["title"], details["authors"], details["year"], details["venue"],
                        details["source"], details["filename"], paper_text[:200_000],
                        _json(case_file), _json(levels), _json(meta), _json(progress),
                        level_count, score, completed, pdf_name, len(pdf_data), pdf_data,
                        now, paper_id,
                    ),
                )
            else:
                conn.execute(
                    """
                    UPDATE papers SET
                        title = ?, authors = ?, year = ?, venue = ?, source = ?, filename = ?,
                        paper_text = ?, case_json = ?, levels_json = ?, meta_json = ?,
                        progress_json = ?, level_count = ?, score = ?, completed = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        details["title"], details["authors"], details["year"], details["venue"],
                        details["source"], details["filename"], paper_text[:200_000],
                        _json(case_file), _json(levels), _json(meta), _json(progress),
                        level_count, score, completed, now, paper_id,
                    ),
                )
        else:
            paper_id = uuid.uuid4().hex
            created_at = now
            conn.execute(
                """
                INSERT INTO papers (
                    id, content_hash, title, authors, year, venue, source, filename,
                    paper_text, case_json, levels_json, meta_json, progress_json,
                    level_count, score, completed, pdf_name, pdf_size, pdf_blob,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    paper_id, content_hash, details["title"], details["authors"], details["year"],
                    details["venue"], details["source"], details["filename"],
                    paper_text[:200_000], _json(case_file), _json(levels), _json(meta),
                    _json(progress), level_count, score, completed,
                    pdf_name if pdf_data is not None else "",
                    len(pdf_data) if pdf_data is not None else 0,
                    pdf_data,
                    created_at, now,
                ),
            )
        row = conn.execute(
            """
            SELECT id, title, authors, year, venue, source, filename,
                   level_count, score, completed, progress_json, pdf_size,
                   created_at, updated_at
            FROM papers WHERE id = ?
            """,
            (paper_id,),
        ).fetchone()

    summary = _summary(row)
    summary["created"] = existing is None
    return summary


def list_papers() -> list[dict[str, Any]]:
    with closing(_connect()) as conn:
        rows = conn.execute(
            """
            SELECT id, title, authors, year, venue, source, filename,
                   level_count, score, completed, progress_json, pdf_size,
                   created_at, updated_at
            FROM papers
            ORDER BY updated_at DESC
            """
        ).fetchall()
    return [_summary(row) for row in rows]


def get_paper(paper_id: str) -> dict[str, Any] | None:
    with closing(_connect()) as conn:
        row = conn.execute(
            """
            SELECT id, title, authors, year, venue, source, filename,
                   paper_text, case_json, levels_json, meta_json, progress_json,
                   level_count, score, completed, pdf_name, pdf_size,
                   created_at, updated_at
            FROM papers WHERE id = ?
            """,
            (paper_id,),
        ).fetchone()
    if row is None:
        return None
    return {
        "item": _summary(row),
        "case_file": _loads(row["case_json"], {}),
        "levels": _loads(row["levels_json"], []),
        "meta": _loads(row["meta_json"], {}),
        "paper_text": row["paper_text"],
        "progress": _loads(row["progress_json"], {}),
    }


def get_pdf(paper_id: str) -> tuple[bytes, str] | None:
    with closing(_connect()) as conn:
        row = conn.execute(
            "SELECT pdf_blob, pdf_name, pdf_size FROM papers WHERE id = ?",
            (paper_id,),
        ).fetchone()
    if row is None or not row["pdf_size"] or row["pdf_blob"] is None:
        return None
    return bytes(row["pdf_blob"]), row["pdf_name"] or "paper.pdf"


def update_progress(paper_id: str, progress: dict[str, Any]) -> dict[str, Any] | None:
    with closing(_connect()) as conn, conn:
        row = conn.execute(
            "SELECT levels_json, created_at FROM papers WHERE id = ?",
            (paper_id,),
        ).fetchone()
        if row is None:
            return None
        levels = _loads(row["levels_json"], [])
        level_count, score, completed = _progress_flags(levels, progress)
        conn.execute(
            """
            UPDATE papers
            SET progress_json = ?, level_count = ?, score = ?, completed = ?, updated_at = ?
            WHERE id = ?
            """,
            (_json(progress), level_count, score, completed, _now(), paper_id),
        )
        updated = conn.execute(
            """
            SELECT id, title, authors, year, venue, source, filename,
                   level_count, score, completed, progress_json, pdf_size,
                   created_at, updated_at
            FROM papers WHERE id = ?
            """,
            (paper_id,),
        ).fetchone()
    return _summary(updated)


def delete_paper(paper_id: str) -> bool:
    with closing(_connect()) as conn, conn:
        cursor = conn.execute("DELETE FROM papers WHERE id = ?", (paper_id,))
        return cursor.rowcount > 0
