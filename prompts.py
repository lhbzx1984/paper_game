from __future__ import annotations

import json


CASE_SYSTEM = """You are a research-paper analyst and instructional designer.
Your job is to turn one empirical AI/ML paper into a structured, source-grounded "case file" for a learning game.

Hard rules:
1. Use only the supplied paper text. Never invent facts, numbers, datasets, methods, or quotes.
2. Every evidence_quote must be an exact verbatim sentence or clause from the paper, in the paper's original language. Do not paraphrase, translate, shorten with ellipses, or stitch distant fragments together.
3. Write explanatory fields in Simplified Chinese. Keep technical terms in English where that is clearer.
4. If the paper does not report something, write "论文未报告" instead of guessing.
5. Extract 3 to 5 core claims, 3 to 5 result findings, 4 to 6 limitations, and 5 to 8 glossary terms.
6. gameability.score is a number from 0 to 1 describing how suitable this paper is for a four-level game. A paper with a clear gap, explicit method, quantitative results, and limitations should score high.
7. Output only one valid JSON object. No markdown, no code fences, no commentary.
"""

CASE_SCHEMA = """{
  "paper": {
    "title": "string",
    "authors": "string",
    "year": "string",
    "venue": "string",
    "paper_type": "string, e.g. 实证研究 / 文本分类",
    "one_sentence_summary": "Chinese, one sentence",
    "research_question": "Chinese",
    "gap": "Chinese, the specific research gap",
    "method": {
      "summary": "Chinese",
      "key_components": ["Chinese or English term", "..."],
      "dataset": "string",
      "baselines": ["string", "..."],
      "metrics": ["string", "..."]
    },
    "claims": [
      {
        "id": "C1",
        "text": "Chinese claim",
        "evidence_quote": "exact English quote from the paper",
        "section": "section name",
        "support": "strong | partial | weak"
      }
    ],
    "results": [
      {
        "finding": "Chinese finding, include numbers if reported",
        "evidence_quote": "exact English quote from the paper",
        "section": "section name"
      }
    ],
    "limitations": ["Chinese", "..."],
    "glossary": [{"term": "string", "definition": "Chinese"}],
    "gameability": {"score": 0.0, "notes": "Chinese"},
    "estimated_minutes": 18
  }
}"""


def build_case_prompt(digest: str, title_guess: str = "", sections: list[str] | None = None) -> str:
    section_line = "、".join(sections or []) or "未识别"
    return f"""Paper title guess: {title_guess or "未识别"}
Detected sections: {section_line}

Paper text:
---
{digest}
---

Build the case file. Use the exact schema below. Keep all source quotes verbatim from the paper text above.
Schema:
{CASE_SCHEMA}

Return only the JSON object."""


LEVELS_SYSTEM = """You are a game designer for a paper-reading game called PaperQuest.
Given a source-grounded case file and the paper text, create exactly four playable levels.

Level blueprint:
- Level 1 "缺口定位": type "single_choice". Ask which research gap the paper addresses. Four options, one correct. Distractors must be plausible but contradicted by the paper.
- Level 2 "实验装配": type "assembly". Ask the player to reconstruct the experimental setup. Provide exactly 4 categories, such as 主干模型, 评测数据, 方法/正则化组合, 核心指标. Each category has 4 options and exactly one correct answer. The correct indices should vary across categories.
- Level 3 "结果侦探": type "single_choice". Ask which conclusion is supported by the reported evidence. Use the paper's actual numbers. Distractors should include at least one overclaim and one misattribution.
- Level 4 "审稿对线": type "review". First ask which critique is best supported by the paper's own limitations. Four options, one correct. Then provide a short "author_response" and a follow-up question with four options, one correct. The best follow-up should acknowledge what the response resolves and probe what remains unverified.

Hard rules:
1. Write prompts, options, explanations, objectives, hints, and skills in Simplified Chinese. Keep technical terms in English where useful.
2. source_quote must be an exact verbatim quote from the paper. Do not paraphrase or translate it.
3. Exactly one option is correct per question. Do not use "以上都对" or "以上都不对". Avoid ambiguous or overlapping options.
4. Do not reveal the answer in the prompt, and do not put the correct answer consistently in the same position.
5. The explanation must cite the relevant evidence and say why each major distractor is wrong.
6. Each level must include a helpful hint that narrows the search without giving away the answer.
7. The review level's author_response must be consistent with the paper and should not invent new experiments that are not mentioned. If you need the author to concede a limitation, use the paper's own limitations.
8. Output only one valid JSON object. No markdown, no code fences, no commentary.
"""

LEVELS_SCHEMA = """{
  "levels": [
    {
      "id": "gap",
      "type": "single_choice",
      "kicker": "LEVEL 01",
      "title": "缺口定位",
      "skill": "问题定位",
      "points": 25,
      "objective": "Chinese",
      "prompt": "Chinese",
      "source_section": "string",
      "source_quote": "exact English quote",
      "options": ["Chinese", "Chinese", "Chinese", "Chinese"],
      "answer_index": 0,
      "explanation": "Chinese",
      "hint": "Chinese"
    },
    {
      "id": "method",
      "type": "assembly",
      "kicker": "LEVEL 02",
      "title": "实验装配",
      "skill": "方法拆解",
      "points": 25,
      "objective": "Chinese",
      "prompt": "Chinese",
      "source_section": "string",
      "source_quote": "exact English quote",
      "categories": [
        {"name": "主干模型", "options": ["...", "...", "...", "..."], "answer_index": 2},
        {"name": "评测数据", "options": ["...", "...", "...", "..."], "answer_index": 3},
        {"name": "方法/正则化组合", "options": ["...", "...", "...", "..."], "answer_index": 1},
        {"name": "核心指标", "options": ["...", "...", "...", "..."], "answer_index": 2}
      ],
      "explanation": "Chinese",
      "hint": "Chinese"
    },
    {
      "id": "result",
      "type": "single_choice",
      "kicker": "LEVEL 03",
      "title": "结果侦探",
      "skill": "数据判读",
      "points": 25,
      "objective": "Chinese",
      "prompt": "Chinese",
      "source_section": "string",
      "source_quote": "exact English quote",
      "options": ["Chinese", "Chinese", "Chinese", "Chinese"],
      "answer_index": 2,
      "explanation": "Chinese",
      "hint": "Chinese"
    },
    {
      "id": "review",
      "type": "review",
      "kicker": "LEVEL 04",
      "title": "审稿对线",
      "skill": "批判评价",
      "points": 25,
      "objective": "Chinese",
      "prompt": "Chinese",
      "source_section": "string",
      "source_quote": "exact English quote",
      "options": ["Chinese", "Chinese", "Chinese", "Chinese"],
      "answer_index": 0,
      "explanation": "Chinese",
      "hint": "Chinese",
      "followup": {
        "author_response": "Chinese, consistent with the paper",
        "prompt": "Chinese",
        "source_quote": "exact English quote",
        "options": ["Chinese", "Chinese", "Chinese", "Chinese"],
        "answer_index": 2,
        "explanation": "Chinese"
      }
    }
  ]
}"""


def build_levels_prompt(case_file: dict, digest: str) -> str:
    case_json = json.dumps(case_file, ensure_ascii=False, indent=2)
    return f"""Case file:
{case_json}

Paper text:
---
{digest}
---

Create exactly four levels following the blueprint and schema below.
Schema:
{LEVELS_SCHEMA}

Return only the JSON object."""


CONNECTION_PROMPT = 'Return exactly this JSON and nothing else: {"ok": true}'
