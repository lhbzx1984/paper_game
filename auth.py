"""邮箱 + 密码账号与签名会话。"""

from __future__ import annotations

import os
import re
import secrets
from pathlib import Path
from typing import Any

from flask import session
from werkzeug.security import check_password_hash, generate_password_hash

import storage

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
SECRET_FILE = DATA_DIR / ".secret_key"
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$")


class AuthError(ValueError):
    def __init__(self, message: str, code: str = "AUTH_FAILED"):
        super().__init__(message)
        self.message = message
        self.code = code


def secret_key() -> str:
    value = os.getenv("SECRET_KEY", "").strip()
    if value:
        return value
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if SECRET_FILE.exists():
        saved = SECRET_FILE.read_text(encoding="utf-8").strip()
        if saved:
            return saved
    generated = secrets.token_hex(32)
    SECRET_FILE.write_text(generated, encoding="utf-8")
    try:
        SECRET_FILE.chmod(0o600)
    except OSError:
        pass
    return generated


def normalize_email(raw: str) -> str:
    email = (raw or "").strip().lower()
    if not EMAIL_RE.match(email) or len(email) > 254:
        raise AuthError("请填写有效的邮箱地址", "INVALID_EMAIL")
    return email


def register(email: str, password: str) -> dict[str, Any]:
    email = normalize_email(email)
    password = password or ""
    if len(password) < 8:
        raise AuthError("密码至少需要 8 个字符", "WEAK_PASSWORD")
    if len(password) > 200:
        raise AuthError("密码过长", "INVALID_PASSWORD")
    try:
        user = storage.create_user(email, generate_password_hash(password))
    except ValueError as exc:
        raise AuthError(str(exc), "EMAIL_TAKEN") from None
    _start_session(user["id"])
    return user


def login(email: str, password: str) -> dict[str, Any]:
    try:
        email = normalize_email(email)
    except AuthError:
        raise AuthError("邮箱或密码不正确", "INVALID_CREDENTIALS") from None
    user = storage.get_user_by_email(email)
    if user is None or not check_password_hash(user["password_hash"], password or ""):
        raise AuthError("邮箱或密码不正确", "INVALID_CREDENTIALS")
    storage.touch_user_login(user["id"])
    _start_session(user["id"])
    return user


def logout() -> None:
    session.clear()


def current_user() -> dict[str, Any] | None:
    user_id = session.get("uid")
    if not user_id:
        return None
    user = storage.get_user_by_id(str(user_id))
    if user is None:
        session.clear()
        return None
    return user


def _start_session(user_id: str) -> None:
    session.clear()
    session["uid"] = user_id
    session.permanent = True
