from __future__ import annotations

import json


CASE_SYSTEM = """You are a research-paper analyst and instructional designer.
Your job is to turn one empirical AI/ML paper into a structured, source-grounded "court case file" for a learning game called PaperQuest.

The game treats reading a paper as a court trial: the paper's authors are the prosecution making claims, an AI challenger attacks each claim, and the player is the judge who must rule based on evidence from the original paper.

Hard rules:
1. Use only the supplied paper text. Never invent facts, numbers, datasets, methods, or quotes.
2. Every evidence_quote must be an exact verbatim sentence or clause from the paper, in the paper's original language. Do not paraphrase, translate, shorten with ellipses, or stitch distant fragments together.
3. Write explanatory fields in Simplified Chinese. Keep technical terms in English where that is clearer.
4. If the paper does not report something, write "论文未报告" instead of guessing.
5. Extract 3 to 5 core claims. Each claim needs: a Chinese statement, an exact evidence quote, the section, support strength, concept keywords for visualization, 1-2 potential attacks (from the paper's own limitations or methodology), and an author defense that cites the paper.
6. Extract 3 to 5 result findings with exact quotes.
7. Extract 4 to 6 limitations.
8. Extract 5 to 8 glossary terms.
9. domain is a short label for the paper's field (e.g. "NLP", "CV", "RL", "System", "Theory"), used to style generated images.
10. Output only one valid JSON object. No markdown, no code fences, no commentary.
"""

CASE_SCHEMA = """{
  "paper": {
    "title": "string",
    "authors": "string",
    "year": "string",
    "venue": "string",
    "domain": "string, e.g. NLP / CV / RL / System",
    "paper_type": "string",
    "one_sentence_summary": "Chinese, one sentence",
    "research_question": "Chinese",
    "gap": "Chinese",
    "method": {
      "summary": "Chinese",
      "key_components": ["string", "..."],
      "dataset": "string",
      "baselines": ["string", "..."],
      "metrics": ["string", "..."]
    },
    "claims": [
      {
        "id": "C1",
        "text": "Chinese claim statement",
        "evidence_quote": "exact verbatim quote from the paper",
        "section": "section name",
        "support": "strong | partial | weak",
        "concept_keywords": "English keywords describing the core concept, for image generation, e.g. 'transformer attention mechanism diagram'",
        "attacks": ["Chinese attack point grounded in the paper's limitations or methodology"],
        "author_defense": "Chinese defense that cites the paper's actual response"
      }
    ],
    "results": [
      {
        "finding": "Chinese finding, include numbers if reported",
        "evidence_quote": "exact verbatim quote",
        "section": "section name"
      }
    ],
    "limitations": ["Chinese", "..."],
    "glossary": [{"term": "string", "definition": "Chinese"}],
    "gameability": {"score": 0.0, "notes": "Chinese"},
    "estimated_minutes": 25
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

Build the court case file. Use the exact schema below. Keep all source quotes verbatim from the paper text above.
Schema:
{CASE_SCHEMA}

Return only the JSON object."""


LEVELS_SYSTEM = """You are a game designer for a paper-reading game called PaperQuest (论文庭审).
Given a source-grounded court case file and the paper text, create exactly four playable levels that form a court trial.

Level blueprint:

Level 1 "证据开示 (Discovery)" — type "discovery".
The player must locate each core claim's evidence in the original paper text.
For each claim, provide the claim text, the correct evidence quote, the section where it appears, and a Chinese hint that narrows the search without giving away the exact quote.
The player will select text in the paper; the system checks if the selection contains the evidence quote.
Do NOT include the evidence quote in the visible prompt — it is the answer the player must find.

Level 2 "证据链拼图 (Evidence Chain)" — type "evidence_chain".
Pick one central claim. Provide 4-6 evidence cards (each with a short Chinese description and its source quote) that, when ordered correctly, form the reasoning chain supporting the claim.
The correct order is the logical chain: method design → experimental setup → key result → claim.
Shuffle the cards for the player. Provide the correct order as an array of indices.

Level 3 "庭审质证 (Cross-examination)" — type "cross_examination".
For 2-3 core claims, present a mini-trial:
- The claim statement
- An attack from the challenger (Chinese)
- The author's defense (Chinese, citing the paper)
- Three ruling options for the player: 成立 / 存疑 / 不成立
- The correct ruling based on the paper's actual support strength
- A list of candidate evidence quotes from which the player must pick one as the basis for their ruling
- An explanation of why the correct ruling fits

Level 4 "陪审团裁决 (Verdict)" — type "verdict".
This is the final output stage, not a multiple-choice question. Provide:
- A summary of all claims and their true support strengths (for the AI to score the player's verdict)
- Guidance prompt asking the player to write: (1) core contribution in one sentence, (2) most credible claim + reason, (3) most doubtful claim + reason, (4) key detail for reproduction
- A suggested scoring rubric in Chinese

Hard rules:
1. Write all prompts, options, explanations, hints in Simplified Chinese. Keep technical terms in English where useful.
2. All evidence quotes must be exact verbatim quotes from the paper. Do not paraphrase.
3. In Level 1, never include the evidence quote in the player-facing prompt — only in the answer field.
4. In Level 3, the correct ruling must match the claim's support strength from the case file (strong→成立, partial→存疑, weak→不成立).
5. Output only one valid JSON object. No markdown, no code fences, no commentary.
"""

LEVELS_SCHEMA = """{
  "levels": [
    {
      "id": "discovery",
      "type": "discovery",
      "kicker": "LEVEL 01",
      "title": "证据开示",
      "skill": "原文精读",
      "points": 25,
      "objective": "在论文原文中找到每条核心主张的证据出处",
      "claims": [
        {
          "id": "C1",
          "text": "Chinese claim statement shown to player",
          "section": "section name hint",
          "hint": "Chinese hint narrowing the search",
          "evidence_quote": "exact verbatim quote — the answer, NOT shown to player directly"
        }
      ]
    },
    {
      "id": "evidence_chain",
      "type": "evidence_chain",
      "kicker": "LEVEL 02",
      "title": "证据链拼图",
      "skill": "论证结构",
      "points": 25,
      "objective": "将证据卡片按逻辑链条排序，还原主张的推理过程",
      "claim_text": "the central claim this chain supports",
      "cards": [
        {"id": 0, "text": "Chinese description of this evidence step", "quote": "exact verbatim quote"}
      ],
      "correct_order": [0, 1, 2, 3],
      "explanation": "Chinese explanation of the logical chain"
    },
    {
      "id": "cross_examination",
      "type": "cross_examination",
      "kicker": "LEVEL 03",
      "title": "庭审质证",
      "skill": "批判评价",
      "points": 25,
      "trials": [
        {
          "claim_id": "C1",
          "claim_text": "Chinese claim statement",
          "attack": "Chinese attack from the challenger",
          "defense": "Chinese author defense citing the paper",
          "ruling_options": ["成立", "存疑", "不成立"],
          "correct_ruling": "成立",
          "evidence_candidates": [
            {"id": "E1", "quote": "exact verbatim quote", "label": "Chinese short label"},
            {"id": "E2", "quote": "exact verbatim quote", "label": "Chinese short label"}
          ],
          "correct_evidence_id": "E1",
          "explanation": "Chinese explanation of why this ruling and evidence fit"
        }
      ]
    },
    {
      "id": "verdict",
      "type": "verdict",
      "kicker": "LEVEL 04",
      "title": "陪审团裁决",
      "skill": "综合判断",
      "points": 25,
      "objective": "输出你的最终裁决，系统将与论文真实情况对比评分",
      "claims_summary": [
        {"id": "C1", "text": "Chinese claim", "true_support": "strong"}
      ],
      "prompt": "Chinese instructions for the player's open-ended verdict",
      "rubric": "Chinese scoring rubric for the AI judge"
    }
  ]
}"""


def build_levels_prompt(case_file: dict, digest: str) -> str:
    case_json = json.dumps(case_file, ensure_ascii=False, indent=2)
    return f"""Court case file:
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


VERDICT_SCORE_SYSTEM = """You are an impartial judge for the PaperQuest (论文庭审) learning game.
The player has just completed a court-trial style reading of an academic paper and submitted a final verdict.
Score the player's verdict against the paper's actual claims and evidence.

Hard rules:
1. Score each of the 4 dimensions from 0 to 25. Total must be 0-100.
2. Base your judgment only on the provided case file (true claims and support strengths) and the player's verdict text.
3. The "most credible claim" should be one with strong support; the "most doubtful claim" should acknowledge a real limitation.
4. The reproduction detail must cite a concrete value from the paper (e.g. probability, dataset, model, span length).
5. Be strict but fair: vague answers that avoid specifics should get low scores.
6. Output only one valid JSON object. No markdown, no code fences, no commentary.
"""


VERDICT_SCORE_SCHEMA = """{
  "scores": {
    "contribution": 0,
    "credible_claim": 0,
    "doubtful_claim": 0,
    "reproduction_detail": 0
  },
  "total": 0,
  "feedback": "Chinese overall feedback to the player, 2-4 sentences, citing what they did well and what they missed."
}"""


def build_verdict_score_prompt(case_file: dict, verdict: str) -> str:
    paper = case_file.get("paper", {}) if isinstance(case_file, dict) else {}
    claims = paper.get("claims", [])
    claims_brief = []
    for c in claims:
        if isinstance(c, dict):
            claims_brief.append(
                f"- {c.get('id', '?')}: {c.get('text', '')} [support={c.get('support', '?')}]"
            )
    claims_text = "\n".join(claims_brief) or "(无主张)"
    return f"""Paper title: {paper.get('title', '未知')}

True claims (with actual support strength from the paper):
{claims_text}

Player's verdict:
---
{verdict}
---

Score the player's verdict using the schema below.
Schema:
{VERDICT_SCORE_SCHEMA}

Return only the JSON object."""
