#!/usr/bin/env python3
"""
GOmetta backend — аккаунты, чаты и сообщения в реальном времени.

Только стандартная библиотека Python: ни Flask, ни WebSocket не нужны.
Доставка сообщений — long-polling через GET /api/state.

Запуск:
    python server.py
    PORT=8080 python server.py

Переменные окружения:
    PORT        — порт (по умолчанию 8099)
    HOST        — адрес (по умолчанию 0.0.0.0)
    GOMETTA_DB  — путь к файлу SQLite (по умолчанию gometta.db рядом)
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("GOMETTA_DB", os.path.join(ROOT, "gometta.db"))
PORT = int(os.environ.get("PORT", "8099"))
HOST = os.environ.get("HOST", "0.0.0.0")

# Telegram: имя бота для ссылки входа и токен для проверки initData.
BOT_USERNAME = os.environ.get("GOMETTA_BOT", "").strip().lstrip("@")
BOT_TOKEN = os.environ.get("GOMETTA_BOT_TOKEN", "").strip()

CV = threading.Condition()
VERSION = 1
MAX_TEXT = 4000

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
}


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    global VERSION
    with closing(connect()) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                phone TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                username TEXT NOT NULL DEFAULT '',
                pin_hash TEXT NOT NULL DEFAULT '',
                pin_salt TEXT NOT NULL DEFAULT '',
                telegram_id TEXT NOT NULL DEFAULT '',
                hue INTEGER NOT NULL DEFAULT 210,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tokens (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_members (
                chat_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                last_read INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (chat_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                text TEXT NOT NULL,
                ts INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, ts);
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        row = conn.execute("SELECT value FROM meta WHERE key='version'").fetchone()
        if row:
            VERSION = int(row["value"])
        else:
            conn.execute("INSERT INTO meta(key, value) VALUES('version', '1')")
        conn.commit()


def bump():
    """Увеличивает версию состояния и будит все long-poll запросы."""
    global VERSION
    with CV:
        VERSION += 1
        with closing(connect()) as conn:
            conn.execute(
                "INSERT INTO meta(key, value) VALUES('version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(VERSION),),
            )
            conn.commit()
        CV.notify_all()


def wait_version(since, timeout):
    with CV:
        CV.wait_for(lambda: VERSION > since, timeout=timeout)
        return VERSION


def now_ms():
    return int(time.time() * 1000)


def new_id(prefix):
    return prefix + "_" + secrets.token_hex(8)


def normalize_phone(value):
    digits = re.sub(r"\D", "", str(value or ""))
    return "+" + digits if digits else ""


def valid_phone(phone):
    return 7 <= len(re.sub(r"\D", "", phone)) <= 15


def parse_init_data(init_data):
    data = {}
    for part in str(init_data or "").split("&"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        data[key] = unquote(value)
    return data


def valid_init_data(init_data):
    """Проверяет подпись Telegram initData, если задан GOMETTA_BOT_TOKEN.

    Без токена проверка невозможна (локальная разработка), поэтому доверяем
    данным клиента — это отмечено в README как ограничение.
    """
    if not BOT_TOKEN:
        return True
    data = parse_init_data(init_data)
    received = data.pop("hash", "")
    if not received:
        return False
    try:
        auth_date = int(data.get("auth_date", "0") or 0)
    except ValueError:
        return False
    if auth_date and abs(time.time() - auth_date) > 86400:
        return False
    check_string = "\n".join(f"{key}={data[key]}" for key in sorted(data))
    secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    calculated = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    return secrets.compare_digest(calculated, received)


def hue_for(text):
    digest = hashlib.sha256(str(text).encode("utf-8")).hexdigest()
    return int(digest[:8], 16) % 360


def user_json(row):
    return {
        "id": row["id"],
        "phone": row["phone"],
        "name": row["name"],
        "username": row["username"],
        "hue": row["hue"],
    }


def issue_token(conn, user_id):
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO tokens(token, user_id, created_at) VALUES(?, ?, ?)",
        (token, user_id, now_ms()),
    )
    return token


def find_chat_between(conn, a, b):
    row = conn.execute(
        """
        SELECT c.id FROM chats c
        JOIN chat_members ma ON ma.chat_id = c.id AND ma.user_id = ?
        JOIN chat_members mb ON mb.chat_id = c.id AND mb.user_id = ?
        WHERE (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) = 2
        LIMIT 1
        """,
        (a, b),
    ).fetchone()
    return row["id"] if row else None


def build_state(conn, user_id):
    user = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    chats = conn.execute(
        """
        SELECT c.id, c.created_at FROM chats c
        JOIN chat_members m ON m.chat_id = c.id
        WHERE m.user_id = ?
        ORDER BY c.created_at DESC
        """,
        (user_id,),
    ).fetchall()

    result = []
    for chat in chats:
        other = conn.execute(
            """
            SELECT u.* FROM chat_members m
            JOIN users u ON u.id = m.user_id
            WHERE m.chat_id = ? AND m.user_id <> ?
            LIMIT 1
            """,
            (chat["id"], user_id),
        ).fetchone()
        mine = conn.execute(
            "SELECT last_read FROM chat_members WHERE chat_id=? AND user_id=?",
            (chat["id"], user_id),
        ).fetchone()
        last_read = mine["last_read"] if mine else 0
        other_read = 0
        if other:
            row = conn.execute(
                "SELECT last_read FROM chat_members WHERE chat_id=? AND user_id=?",
                (chat["id"], other["id"]),
            ).fetchone()
            other_read = row["last_read"] if row else 0

        messages = []
        unread = 0
        for msg in conn.execute(
            "SELECT * FROM messages WHERE chat_id=? ORDER BY ts ASC LIMIT 1000",
            (chat["id"],),
        ).fetchall():
            is_mine = msg["sender_id"] == user_id
            if not is_mine and msg["ts"] > last_read:
                unread += 1
            messages.append(
                {
                    "id": msg["id"],
                    "from": "me" if is_mine else "them",
                    "text": msg["text"],
                    "ts": msg["ts"],
                    "status": "read" if is_mine and other_read >= msg["ts"] else "sent",
                }
            )

        result.append(
            {
                "id": chat["id"],
                "name": other["name"] if other else "Чат",
                "phone": other["phone"] if other else "",
                "hue": other["hue"] if other else 210,
                "group": False,
                "pinned": False,
                "demo": False,
                "unread": unread,
                "createdAt": chat["created_at"],
                "messages": messages,
            }
        )

    return {
        "version": VERSION,
        "user": user_json(user),
        "chats": result,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "GOmetta/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("GOMETTA_LOG") == "1":
            super().log_message(fmt, *args)

    # ---------- helpers ----------

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.cors()
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            # клиент закрыл long-poll раньше — это нормально
            pass

    def fail(self, status, message):
        self.send_json(status, {"error": message})

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 1_000_000:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    def auth_user(self, conn):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return None
        token = header[7:].strip()
        if not token:
            return None
        row = conn.execute(
            "SELECT u.* FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?",
            (token,),
        ).fetchone()
        return row

    def require_user(self, conn):
        user = self.auth_user(conn)
        if not user:
            self.fail(401, "Нужна авторизация")
            return None
        return user

    def serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        relative = path.lstrip("/")
        file_path = os.path.normpath(os.path.join(ROOT, relative))
        if not file_path.startswith(ROOT + os.sep) or not os.path.isfile(file_path):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.cors()
            self.end_headers()
            return
        ext = os.path.splitext(file_path)[1].lower()
        try:
            with open(file_path, "rb") as handle:
                body = handle.read()
        except OSError:
            self.send_response(500)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        if ext in (".html", ".js", ".css", ".json"):
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=3600")
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    # ---------- HTTP ----------

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.serve_static(parsed.path)
            return

        query = parse_qs(parsed.query)
        path = parsed.path

        if path == "/api/config":
            self.send_json(200, {"telegram": bool(BOT_USERNAME), "bot": BOT_USERNAME})
            return

        if path == "/api/state":
            self.handle_state(query)
            return

        with closing(connect()) as conn:
            user = self.require_user(conn)
            if not user:
                return

            if path == "/api/me":
                self.send_json(200, {"user": user_json(user)})
                return

            if path == "/api/chats":
                self.send_json(200, build_state(conn, user["id"]))
                return

        self.fail(404, "Не найдено")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if not path.startswith("/api/"):
            self.fail(404, "Не найдено")
            return

        body = self.read_json()

        if path == "/api/auth/telegram":
            self.handle_telegram(body)
            return

        with closing(connect()) as conn:
            user = self.require_user(conn)
            if not user:
                return

            if path == "/api/logout":
                token = self.headers.get("Authorization", "")[7:].strip()
                conn.execute("DELETE FROM tokens WHERE token=?", (token,))
                conn.commit()
                self.send_json(200, {"ok": True})
                return

            if path == "/api/chats":
                self.handle_create_chat(conn, user, body)
                return

            match = re.fullmatch(r"/api/chats/([^/]+)/messages", path)
            if match:
                self.handle_send(conn, user, match.group(1), body)
                return

            match = re.fullmatch(r"/api/chats/([^/]+)/read", path)
            if match:
                self.handle_read(conn, user, match.group(1))
                return

            match = re.fullmatch(r"/api/chats/([^/]+)/clear", path)
            if match:
                self.handle_clear(conn, user, match.group(1))
                return

        self.fail(404, "Не найдено")

    def do_PATCH(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/me":
            self.fail(404, "Не найдено")
            return
        body = self.read_json()
        with closing(connect()) as conn:
            user = self.require_user(conn)
            if not user:
                return
            name = str(body.get("name", user["name"])).strip()[:60]
            username = re.sub(r"^@+", "", str(body.get("username", user["username"]))).strip()[:40]
            if not name:
                self.fail(400, "Имя не может быть пустым")
                return
            conn.execute(
                "UPDATE users SET name=?, username=? WHERE id=?",
                (name, username, user["id"]),
            )
            conn.commit()
            bump()
            row = conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
            self.send_json(200, {"user": user_json(row)})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        match = re.fullmatch(r"/api/chats/([^/]+)", parsed.path)
        if not match:
            self.fail(404, "Не найдено")
            return
        chat_id = match.group(1)
        with closing(connect()) as conn:
            user = self.require_user(conn)
            if not user:
                return
            member = conn.execute(
                "SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?",
                (chat_id, user["id"]),
            ).fetchone()
            if not member:
                self.fail(404, "Чат не найден")
                return
            conn.execute("DELETE FROM messages WHERE chat_id=?", (chat_id,))
            conn.execute("DELETE FROM chat_members WHERE chat_id=?", (chat_id,))
            conn.execute("DELETE FROM chats WHERE id=?", (chat_id,))
            conn.commit()
            bump()
            self.send_json(200, {"ok": True})

    # ---------- handlers ----------

    def handle_telegram(self, body):
        phone = normalize_phone(body.get("phone"))
        name = str(body.get("name", "")).strip()[:60] or "Пользователь"
        telegram_id = str(body.get("telegramId", "")).strip()[:40]
        init_data = str(body.get("initData", ""))
        if not telegram_id:
            self.fail(400, "Telegram не передал пользователя")
            return
        if not valid_init_data(init_data):
            self.fail(401, "Не удалось проверить данные Telegram. Откройте GOmetta из бота.")
            return
        if BOT_TOKEN:
            try:
                tg_user = json.loads(parse_init_data(init_data).get("user", "{}"))
            except ValueError:
                tg_user = {}
            if str(tg_user.get("id", "")) != telegram_id:
                self.fail(401, "Данные Telegram не совпадают")
                return
        if not valid_phone(phone):
            self.fail(400, "Введите корректный номер")
            return
        with closing(connect()) as conn:
            row = conn.execute("SELECT * FROM users WHERE phone=?", (phone,)).fetchone()
            if row:
                if row["telegram_id"] and row["telegram_id"] != telegram_id:
                    self.fail(403, "Этот номер уже привязан к другому Telegram-аккаунту")
                    return
                conn.execute("UPDATE users SET telegram_id=? WHERE id=?", (telegram_id, row["id"]))
                token = issue_token(conn, row["id"])
                conn.commit()
                self.send_json(200, {"token": token, "user": user_json(row)})
                return
            user_id = new_id("user")
            conn.execute(
                "INSERT INTO users(id, phone, name, username, pin_hash, pin_salt, telegram_id, hue, created_at) "
                "VALUES(?, ?, ?, '', '', '', ?, ?, ?)",
                (user_id, phone, name, telegram_id, hue_for(phone), now_ms()),
            )
            token = issue_token(conn, user_id)
            conn.commit()
            row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
            self.send_json(201, {"token": token, "user": user_json(row)})

    def handle_create_chat(self, conn, user, body):
        phone = normalize_phone(body.get("phone"))
        fallback_name = str(body.get("name", "")).strip()[:60]
        if not valid_phone(phone):
            self.fail(400, "Введите номер друга")
            return
        target = conn.execute("SELECT * FROM users WHERE phone=?", (phone,)).fetchone()
        if not target:
            self.fail(404, "Пользователь с таким номером не найден")
            return
        if target["id"] == user["id"]:
            self.fail(400, "Нельзя создать чат с самим собой")
            return
        chat_id = find_chat_between(conn, user["id"], target["id"])
        if not chat_id:
            chat_id = new_id("chat")
            conn.execute("INSERT INTO chats(id, created_at) VALUES(?, ?)", (chat_id, now_ms()))
            conn.execute(
                "INSERT INTO chat_members(chat_id, user_id, last_read) VALUES(?, ?, 0)",
                (chat_id, user["id"]),
            )
            conn.execute(
                "INSERT INTO chat_members(chat_id, user_id, last_read) VALUES(?, ?, 0)",
                (chat_id, target["id"]),
            )
            conn.commit()
            bump()
        self.send_json(
            200,
            {
                "chat": {
                    "id": chat_id,
                    "name": target["name"] or fallback_name,
                    "phone": target["phone"],
                }
            },
        )

    def handle_send(self, conn, user, chat_id, body):
        member = conn.execute(
            "SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?",
            (chat_id, user["id"]),
        ).fetchone()
        if not member:
            self.fail(404, "Чат не найден")
            return
        text = str(body.get("text", "")).strip()[:MAX_TEXT]
        if not text:
            self.fail(400, "Пустое сообщение")
            return
        message_id = new_id("m")
        ts = now_ms()
        conn.execute(
            "INSERT INTO messages(id, chat_id, sender_id, text, ts) VALUES(?, ?, ?, ?, ?)",
            (message_id, chat_id, user["id"], text, ts),
        )
        conn.execute(
            "UPDATE chat_members SET last_read=? WHERE chat_id=? AND user_id=?",
            (ts, chat_id, user["id"]),
        )
        conn.commit()
        bump()
        self.send_json(201, {"message": {"id": message_id, "ts": ts}})

    def handle_read(self, conn, user, chat_id):
        member = conn.execute(
            "SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?",
            (chat_id, user["id"]),
        ).fetchone()
        if not member:
            self.fail(404, "Чат не найден")
            return
        conn.execute(
            "UPDATE chat_members SET last_read=? WHERE chat_id=? AND user_id=?",
            (now_ms(), chat_id, user["id"]),
        )
        conn.commit()
        bump()
        self.send_json(200, {"ok": True})

    def handle_clear(self, conn, user, chat_id):
        member = conn.execute(
            "SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?",
            (chat_id, user["id"]),
        ).fetchone()
        if not member:
            self.fail(404, "Чат не найден")
            return
        conn.execute("DELETE FROM messages WHERE chat_id=?", (chat_id,))
        conn.execute(
            "UPDATE chat_members SET last_read=? WHERE chat_id=?",
            (now_ms(), chat_id),
        )
        conn.commit()
        bump()
        self.send_json(200, {"ok": True})

    def handle_state(self, query):
        try:
            since = int(query.get("since", ["0"])[0] or 0)
        except (TypeError, ValueError):
            since = 0
        try:
            timeout = float(query.get("timeout", ["20"])[0] or 20)
        except (TypeError, ValueError):
            timeout = 20.0
        timeout = max(0.0, min(timeout, 30.0))

        with closing(connect()) as conn:
            user = self.require_user(conn)
            if not user:
                return

        if timeout > 0:
            wait_version(since, timeout)

        with closing(connect()) as conn:
            state = build_state(conn, user["id"])
            self.send_json(200, state)


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        if isinstance(error, (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def main():
    init_db()
    server = QuietServer((HOST, PORT), Handler)
    print(f"GOmetta server: http://{HOST}:{PORT}  (db: {DB_PATH})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено", flush=True)


if __name__ == "__main__":
    main()
