from __future__ import annotations

import re
import unicodedata
from collections import OrderedDict
from typing import Any

import fitz


SECTION_ALIASES = [
    ("abstract", "Abstract"),
    ("introduction", "Introduction"),
    ("related work", "Related Work"),
    ("background", "Background"),
    ("method", "Method"),
    ("approach", "Method"),
    ("experimental setup", "Experiments"),
    ("experiment", "Experiments"),
    ("evaluation", "Results"),
    ("result", "Results"),
    ("ablation", "Results"),
    ("discussion", "Discussion"),
    ("limitation", "Limitations"),
    ("conclusion", "Conclusion"),
    ("reference", "References"),
    ("appendix", "Appendix"),
]

SECTION_PRIORITY = [
    "Abstract",
    "Introduction",
    "Method",
    "Experiments",
    "Results",
    "Discussion",
    "Limitations",
    "Conclusion",
    "Related Work",
    "Background",
    "Appendix",
    "References",
    "Front Matter",
    "Full Text",
]


def clean_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\u00a0", " ")
    text = text.replace("\u00ad", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


def extract_pdf_bytes(data: bytes) -> tuple[str, int]:
    doc = fitz.open(stream=data, filetype="pdf")
    pages = []
    for page in doc:
        # Block mode keeps paragraph boundaries intact, so the reader can show
        # readable paragraphs instead of one giant block per page.
        blocks = [
            block[4].strip()
            for block in page.get_text("blocks")
            if isinstance(block[4], str) and block[4].strip()
        ]
        pages.append("\n\n".join(blocks))
    page_count = doc.page_count
    doc.close()
    return clean_text("\n\n".join(pages)), page_count


def guess_title(text: str) -> str:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return "Untitled paper"
    candidates = []
    for line in lines[:12]:
        low = line.lower()
        if low in {"abstract", "introduction"}:
            break
        if len(line) > 160 or len(line.split()) < 2:
            continue
        candidates.append(line)
    if not candidates:
        return lines[0][:160]
    # Common two-line titles: take the first two short lines before authors.
    if len(candidates) >= 2 and len(candidates[0]) < 90 and len(candidates[1]) < 90:
        first, second = candidates[0], candidates[1]
        if not re.search(r"(university|institute|department|@)", second, re.I):
            return (first + " " + second).strip()
    return candidates[0]


def _strip_heading_number(line: str) -> str:
    return re.sub(r"^\s*\d+(?:\.\d+)*[\.、]?\s*", "", line).strip()


def _heading_canonical(line: str, current_main: str | None = None) -> tuple[str | None, bool]:
    raw = line.strip()
    if not raw or len(raw) > 100:
        return None, False
    if len(raw.split()) > 14:
        return None, False
    numbered = bool(re.match(r"^\s*\d+(?:\.\d+)*[\.、]?\s+", raw))
    subnumbered = bool(re.match(r"^\s*\d+\.\d+", raw))
    stripped = _strip_heading_number(raw)
    low = stripped.lower().strip(" :.-")
    if not low:
        return None, False

    if re.fullmatch(r"(abstract|references|appendix)", low):
        canonical = {"abstract": "Abstract", "references": "References", "appendix": "Appendix"}[low]
        return canonical, not subnumbered

    for alias, canonical in SECTION_ALIASES:
        if re.search(rf"\b{re.escape(alias)}\b", low):
            if subnumbered and current_main:
                return current_main, False
            return canonical, not subnumbered

    if numbered and len(stripped.split()) <= 8 and stripped[0:1].isupper():
        if subnumbered and current_main:
            return current_main, False
        return stripped, not subnumbered
    return None, False


def split_sections(text: str) -> list[dict[str, str]]:
    lines = text.splitlines()
    sections: list[dict[str, str]] = []
    current_name = "Front Matter"
    current_heading = "Front Matter"
    current_lines: list[str] = []
    current_main: str | None = None

    def flush():
        nonlocal current_lines
        body = "\n".join(current_lines).strip()
        if body:
            sections.append(
                {"canonical": current_name, "heading": current_heading, "text": body}
            )
        current_lines = []

    for line in lines:
        canonical, is_main = _heading_canonical(line, current_main)
        if canonical:
            flush()
            current_name = canonical
            current_heading = line.strip()
            if is_main:
                current_main = canonical
            continue
        current_lines.append(line)
    flush()

    if not sections or (len(sections) == 1 and sections[0]["canonical"] == "Front Matter"):
        return [{"canonical": "Full Text", "heading": "Full Text", "text": text.strip()}]
    return sections


def merge_sections(sections: list[dict[str, str]]) -> OrderedDict[str, str]:
    grouped: OrderedDict[str, list[str]] = OrderedDict()
    for sec in sections:
        grouped.setdefault(sec["canonical"], []).append(sec["text"])
    return OrderedDict((k, "\n\n".join(v)) for k, v in grouped.items())


def section_meta(text: str) -> list[dict[str, Any]]:
    sections = split_sections(text)
    grouped = merge_sections(sections)
    return [
        {"name": name, "chars": len(body), "words": len(body.split())}
        for name, body in grouped.items()
        if body.strip()
    ]


def build_digest(text: str, max_chars: int = 30000) -> str:
    grouped = merge_sections(split_sections(text))
    if not grouped:
        return text[:max_chars]
    parts: list[str] = []
    remaining = max_chars
    per_section = max(1800, max_chars // 7)
    for name in SECTION_PRIORITY:
        if name not in grouped:
            continue
        body = grouped[name].strip()
        if not body:
            continue
        body = body[:per_section]
        part = f"## {name}\n{body}"
        if len(part) > remaining:
            part = part[:remaining]
        if len(part.strip()) < 40:
            break
        parts.append(part)
        remaining -= len(part)
        if remaining <= 500:
            break
    if not parts:
        return text[:max_chars]
    return "\n\n".join(parts)


def normalize_for_match(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    value = value.replace("\u00ad", "")
    value = value.replace("–", "-").replace("—", "-").replace("−", "-")
    value = value.replace("“", '"').replace("”", '"').replace("’", "'").replace("‘", "'")
    value = re.sub(r"-\s*\n\s*", "-", value)
    value = re.sub(r"\s+", " ", value)
    value = re.sub(r"\s*-\s*", "-", value)
    return value.strip().lower()


def quote_in_text(quote: str, normalized_text: str) -> bool:
    q = normalize_for_match(quote)
    if not q or len(q) < 12:
        return False
    # For very long quotes, verify the first distinctive part. This tolerates
    # minor trailing OCR drift while still rejecting invented content.
    if len(q) > 420:
        q = q[:320]
    return q in normalized_text


def _build_normalized_map(text: str) -> tuple[str, list[int]]:
    """返回 (normalized_text, original_index_for_each_normalized_char)。"""
    result_chars: list[str] = []
    result_index: list[int] = []
    # 逐字处理，跟踪原始索引；normalize_for_match 的主要变换：
    # - 合并空白为单个空格
    # - 智能标点替换
    # - 去软连字符、合并跨行连字符
    i = 0
    n = len(text)
    pending_space = False
    while i < n:
        ch = text[i]
        # 软连字符直接删除
        if ch == "\u00ad":
            i += 1
            continue
        # 跨行连字符: "-" + 空白换行 -> 合并为 "-"
        if ch == "-" and i + 1 < n and text[i + 1] in " \t\n\r":
            # 跳过后续空白
            j = i + 1
            while j < n and text[j] in " \t\n\r":
                j += 1
            result_chars.append("-")
            result_index.append(i)
            i = j
            continue
        # 空白折叠
        if ch in " \t\n\r":
            if result_chars and not pending_space:
                pending_space = True
            i += 1
            continue
        if pending_space:
            result_chars.append(" ")
            result_index.append(i - 1)
            pending_space = False
        # 标点替换
        if ch in "–—−":
            result_chars.append("-")
            result_index.append(i)
        elif ch in "“”":
            result_chars.append('"')
            result_index.append(i)
        elif ch in "‘’":
            result_chars.append("'")
            result_index.append(i)
        else:
            result_chars.append(ch.lower())
            result_index.append(i)
        i += 1
    return "".join(result_chars), result_index


def locate_quote(text: str, quote: str) -> tuple[int, int] | None:
    """在原文中定位 quote 的字符偏移区间 [start, end)。

    使用与 quote_in_text 相同的归一化策略，保证定位结果与核验结果一致。
    找不到时返回 None。
    """
    q = normalize_for_match(quote)
    if not q or len(q) < 12:
        return None
    if len(q) > 420:
        q = q[:320]
    normalized, idx_map = _build_normalized_map(text)
    pos = normalized.find(q)
    if pos < 0:
        return None
    start = idx_map[pos]
    end_pos = pos + len(q) - 1
    if end_pos >= len(idx_map):
        end_pos = len(idx_map) - 1
    end = idx_map[end_pos] + 1
    # 安全边界
    if start < 0:
        start = 0
    if end > len(text):
        end = len(text)
    return (start, end)


def verify_quotes(obj: Any, full_text: str) -> dict[str, int]:
    normalized = normalize_for_match(full_text)
    stats = {"total": 0, "verified": 0}

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for key in ("evidence_quote", "source_quote"):
                value = node.get(key)
                if isinstance(value, str) and value.strip():
                    ok = quote_in_text(value, normalized)
                    node["verified"] = ok
                    stats["total"] += 1
                    if ok:
                        stats["verified"] += 1
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(obj)
    return stats


def _as_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        raw = value.strip().upper()
        if raw in {"A", "B", "C", "D"}:
            return ord(raw) - ord("A")
        m = re.search(r"-?\d+", raw)
        if m:
            return int(m.group(0))
    return default


def _string_list(value: Any, limit: int = 8) -> list[str]:
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
        elif isinstance(item, dict):
            text = item.get("text") or item.get("name") or item.get("term")
            if isinstance(text, str) and text.strip():
                out.append(text.strip())
        if len(out) >= limit:
            break
    return out


def normalize_case(raw: Any, full_text: str, fallback_title: str = "") -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("模型返回的案件档案不是 JSON 对象")
    paper = raw.get("paper") if isinstance(raw.get("paper"), dict) else raw
    if not isinstance(paper, dict):
        raise ValueError("案件档案缺少 paper 字段")

    title = str(paper.get("title") or fallback_title or "Untitled paper").strip()
    domain = str(paper.get("domain") or "AI").strip()
    method_raw = paper.get("method") if isinstance(paper.get("method"), dict) else {}
    claims_raw = paper.get("claims") if isinstance(paper.get("claims"), list) else []
    results_raw = paper.get("results") if isinstance(paper.get("results"), list) else []
    glossary_raw = paper.get("glossary") if isinstance(paper.get("glossary"), list) else []
    gameability_raw = paper.get("gameability") if isinstance(paper.get("gameability"), dict) else {}

    claims = []
    for idx, claim in enumerate(claims_raw[:6], start=1):
        if not isinstance(claim, dict):
            continue
        text = str(claim.get("text") or "").strip()
        quote = str(claim.get("evidence_quote") or "").strip()
        if not text or not quote:
            continue
        attacks_raw = claim.get("attacks") if isinstance(claim.get("attacks"), list) else []
        claims.append(
            {
                "id": str(claim.get("id") or f"C{idx}"),
                "text": text,
                "evidence_quote": quote,
                "section": str(claim.get("section") or "正文"),
                "support": str(claim.get("support") or "partial"),
                "concept_keywords": str(claim.get("concept_keywords") or "").strip(),
                "attacks": _string_list(attacks_raw, 4),
                "author_defense": str(claim.get("author_defense") or "论文未报告").strip(),
            }
        )

    results = []
    for result in results_raw[:6]:
        if not isinstance(result, dict):
            continue
        finding = str(result.get("finding") or result.get("text") or "").strip()
        quote = str(result.get("evidence_quote") or "").strip()
        if not finding or not quote:
            continue
        results.append(
            {
                "finding": finding,
                "evidence_quote": quote,
                "section": str(result.get("section") or "Results"),
            }
        )

    glossary = []
    for item in glossary_raw[:10]:
        if not isinstance(item, dict):
            continue
        term = str(item.get("term") or "").strip()
        definition = str(item.get("definition") or item.get("text") or "").strip()
        if term and definition:
            glossary.append({"term": term, "definition": definition})

    method = {
        "summary": str(method_raw.get("summary") or "论文未报告").strip(),
        "key_components": _string_list(method_raw.get("key_components"), 8),
        "dataset": str(method_raw.get("dataset") or "论文未报告").strip(),
        "baselines": _string_list(method_raw.get("baselines"), 8),
        "metrics": _string_list(method_raw.get("metrics"), 8),
    }

    try:
        score = float(gameability_raw.get("score", 0.8))
    except (TypeError, ValueError):
        score = 0.8
    score = max(0.0, min(1.0, score))

    try:
        minutes = int(paper.get("estimated_minutes") or raw.get("estimated_minutes") or 18)
    except (TypeError, ValueError):
        minutes = 18
    minutes = max(8, min(60, minutes))

    normalized = {
        "schema_version": "1.0",
        "paper": {
            "title": title,
            "domain": domain,
            "authors": str(paper.get("authors") or "论文未报告").strip(),
            "year": str(paper.get("year") or "论文未报告").strip(),
            "venue": str(paper.get("venue") or "论文未报告").strip(),
            "paper_type": str(paper.get("paper_type") or "实证研究").strip(),
            "one_sentence_summary": str(paper.get("one_sentence_summary") or "论文未报告").strip(),
            "research_question": str(paper.get("research_question") or "论文未报告").strip(),
            "gap": str(paper.get("gap") or "论文未报告").strip(),
            "method": method,
            "claims": claims,
            "results": results,
            "limitations": _string_list(paper.get("limitations"), 8),
            "glossary": glossary,
            "gameability": {
                "score": round(score, 2),
                "notes": str(gameability_raw.get("notes") or "").strip(),
            },
            "estimated_minutes": minutes,
        },
    }
    verify_quotes(normalized, full_text)
    return normalized


def _normalize_options(value: Any, min_count: int = 3) -> list[str]:
    options = _string_list(value, 6)
    if len(options) < min_count:
        raise ValueError("选项数量不足")
    # Preserve order while dropping exact duplicates.
    seen = set()
    unique = []
    for opt in options:
        key = opt.strip().lower()
        if key not in seen:
            seen.add(key)
            unique.append(opt.strip())
    return unique


def normalize_levels(raw: Any, full_text: str) -> dict[str, Any]:
    """归一化论文庭审 4 关卡结构：discovery / evidence_chain / cross_examination / verdict。"""
    if not isinstance(raw, dict) or not isinstance(raw.get("levels"), list):
        raise ValueError("模型返回的关卡格式不正确")
    levels_raw = raw["levels"]
    if len(levels_raw) != 4:
        raise ValueError(f"需要 4 个关卡，模型返回了 {len(levels_raw)} 个")

    levels = []
    for idx, level in enumerate(levels_raw, start=1):
        if not isinstance(level, dict):
            raise ValueError(f"第 {idx} 关不是对象")
        ltype = str(level.get("type") or "").strip()
        base = {
            "id": str(level.get("id") or f"level-{idx}"),
            "type": ltype,
            "kicker": str(level.get("kicker") or f"LEVEL {idx:02d}"),
            "title": str(level.get("title") or f"第 {idx} 关").strip(),
            "skill": str(level.get("skill") or "论文理解").strip(),
            "points": _as_int(level.get("points"), 25) or 25,
            "objective": str(level.get("objective") or "").strip(),
        }

        if ltype == "discovery":
            claims_raw = level.get("claims")
            if not isinstance(claims_raw, list) or len(claims_raw) < 1:
                raise ValueError(f"第 {idx} 关（证据开示）缺少 claims")
            claims = []
            for ci, c in enumerate(claims_raw, start=1):
                if not isinstance(c, dict):
                    continue
                text = str(c.get("text") or "").strip()
                quote = str(c.get("evidence_quote") or "").strip()
                if not text or not quote:
                    continue
                claims.append(
                    {
                        "id": str(c.get("id") or f"C{ci}"),
                        "text": text,
                        "section": str(c.get("section") or "正文").strip(),
                        "hint": str(c.get("hint") or "").strip(),
                        "evidence_quote": quote,
                    }
                )
            if not claims:
                raise ValueError(f"第 {idx} 关（证据开示）没有有效的 claim")
            base["claims"] = claims

        elif ltype == "evidence_chain":
            cards_raw = level.get("cards")
            correct_order = level.get("correct_order")
            if not isinstance(cards_raw, list) or len(cards_raw) < 3:
                raise ValueError(f"第 {idx} 关（证据链）卡片不足")
            cards = []
            for ci, c in enumerate(cards_raw):
                if not isinstance(c, dict):
                    continue
                text = str(c.get("text") or "").strip()
                quote = str(c.get("quote") or "").strip()
                if not text:
                    continue
                cards.append(
                    {
                        "id": _as_int(c.get("id"), ci),
                        "text": text,
                        "quote": quote,
                    }
                )
            if len(cards) < 3:
                raise ValueError(f"第 {idx} 关（证据链）有效卡片不足")
            order = []
            if isinstance(correct_order, list):
                for v in correct_order:
                    iv = _as_int(v, -1)
                    if 0 <= iv < len(cards):
                        order.append(iv)
            # 顺序去重、补全
            seen = set()
            final_order = []
            for v in order:
                if v not in seen:
                    seen.add(v)
                    final_order.append(v)
            for v in range(len(cards)):
                if v not in seen:
                    final_order.append(v)
            base["claim_text"] = str(level.get("claim_text") or "").strip()
            base["cards"] = cards
            base["correct_order"] = final_order
            base["explanation"] = str(level.get("explanation") or "").strip()

        elif ltype == "cross_examination":
            trials_raw = level.get("trials")
            if not isinstance(trials_raw, list) or len(trials_raw) < 1:
                raise ValueError(f"第 {idx} 关（庭审质证）缺少 trials")
            trials = []
            for ti, t in enumerate(trials_raw, start=1):
                if not isinstance(t, dict):
                    continue
                claim_text = str(t.get("claim_text") or "").strip()
                if not claim_text:
                    continue
                cand_raw = t.get("evidence_candidates")
                candidates = []
                if isinstance(cand_raw, list):
                    for ei, e in enumerate(cand_raw, start=1):
                        if not isinstance(e, dict):
                            continue
                        quote = str(e.get("quote") or "").strip()
                        if not quote:
                            continue
                        candidates.append(
                            {
                                "id": str(e.get("id") or f"E{ei}"),
                                "quote": quote,
                                "label": str(e.get("label") or "").strip(),
                            }
                        )
                ruling_options = _string_list(t.get("ruling_options"), 3) or ["成立", "存疑", "不成立"]
                correct_ruling = str(t.get("correct_ruling") or "").strip()
                if correct_ruling not in ruling_options:
                    correct_ruling = ruling_options[0] if ruling_options else "存疑"
                trials.append(
                    {
                        "claim_id": str(t.get("claim_id") or f"T{ti}"),
                        "claim_text": claim_text,
                        "attack": str(t.get("attack") or "").strip(),
                        "defense": str(t.get("defense") or "").strip(),
                        "ruling_options": ruling_options,
                        "correct_ruling": correct_ruling,
                        "evidence_candidates": candidates,
                        "correct_evidence_id": str(t.get("correct_evidence_id") or "").strip(),
                        "explanation": str(t.get("explanation") or "").strip(),
                    }
                )
            if not trials:
                raise ValueError(f"第 {idx} 关（庭审质证）没有有效的 trial")
            base["trials"] = trials

        elif ltype == "verdict":
            claims_summary_raw = level.get("claims_summary")
            claims_summary = []
            if isinstance(claims_summary_raw, list):
                for c in claims_summary_raw:
                    if not isinstance(c, dict):
                        continue
                    text = str(c.get("text") or "").strip()
                    support = str(c.get("true_support") or c.get("support") or "").strip()
                    if not text:
                        continue
                    claims_summary.append(
                        {
                            "id": str(c.get("id") or "").strip(),
                            "text": text,
                            "true_support": support,
                        }
                    )
            base["claims_summary"] = claims_summary
            base["prompt"] = str(level.get("prompt") or "").strip()
            base["rubric"] = str(level.get("rubric") or "").strip()

        else:
            raise ValueError(f"第 {idx} 关的未知类型: {ltype!r}")

        levels.append(base)

    result = {"schema_version": "1.0", "levels": levels}
    verify_quotes(result, full_text)
    return result
