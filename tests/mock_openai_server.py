"""A tiny OpenAI-compatible mock used only for local end-to-end tests."""
import json
from pathlib import Path

from flask import Flask, jsonify, request

ROOT = Path(__file__).resolve().parents[1]
CASE = json.loads((ROOT / "data" / "demo_case.json").read_text(encoding="utf-8"))
LEVELS = json.loads((ROOT / "data" / "demo_levels.json").read_text(encoding="utf-8"))

app = Flask(__name__)


@app.post("/v1/chat/completions")
def completions():
    body = request.get_json(silent=True) or {}
    messages = body.get("messages") or []
    user = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "user")
    if "Create exactly four levels" in user or "LEVELS_SCHEMA" in user:
        payload = LEVELS
    elif "Build the case file" in user or "CASE_SCHEMA" in user:
        payload = CASE
    else:
        payload = {"ok": True}
    content = json.dumps(payload, ensure_ascii=False)
    return jsonify(
        {
            "id": "mock-completion",
            "object": "chat.completion",
            "model": body.get("model", "mock"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }
    )


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5055, debug=False)
