"""
AURA AI — secure backend proxy for the Groq API.

The browser never holds a Groq key: the frontend posts chat messages here
and this server calls Groq with keys read from environment variables
(backend/.env locally, the host's dashboard in production).

Endpoints
---------
GET  /health           liveness + non-secret config summary
POST /api/chat          text chat completions
POST /api/chat/vision   image analysis (vision model)

Local run (from this folder):
    uvicorn main:app --reload
"""

from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# Read backend/.env no matter which directory the server was started from.
load_dotenv(Path(__file__).with_name(".env"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("aura")

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

# Model IDs must be active on your Groq account (override them in .env).
TEXT_MODEL = os.getenv("GROQ_TEXT_MODEL", "openai/gpt-oss-120b")
VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "qwen/qwen3.8-27b")

DEFAULT_MAX_TOKENS = 1024
MAX_MAX_TOKENS = 4096          # hard ceiling, whatever the client asks for
DEFAULT_TEMPERATURE = 0.7
MAX_MESSAGE_CHARS = 2_000_000  # ~4 compressed images + text; beyond that refuse
ROTATE_ON = {401, 403, 429}    # upstream statuses where another key may work

# Origins allowed to call this API from a browser (comma-separated in .env).
DEFAULT_ORIGINS = (
    "http://localhost:3000,http://localhost:8000,http://127.0.0.1:3000"
)


def configured_keys() -> list[str]:
    """Every configured Groq key, in order, without duplicates.

    Checks GROQ_KEY_1 … GROQ_KEY_20 first, then the single-key
    GROQ_API_KEY fallback. Empty entries are skipped, so you can add
    GROQ_KEY_2 later without touching the others.
    """
    keys: list[str] = []
    for i in range(1, 21):
        value = os.getenv(f"GROQ_KEY_{i}", "").strip()
        if value:
            keys.append(value)
    fallback = os.getenv("GROQ_API_KEY", "").strip()
    if fallback:
        keys.append(fallback)
    return list(dict.fromkeys(keys))   # de-duplicate, keep order


def allowed_origins() -> list[str]:
    raw = os.getenv("ALLOWED_ORIGINS", DEFAULT_ORIGINS)
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


class Message(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str | list[dict[str, Any]]


class ChatRequest(BaseModel):
    """What the frontend sends. Unknown fields (e.g. a client-chosen
    `model`) are ignored, so the server always decides which model runs."""

    messages: list[Message]
    max_tokens: int | None = None
    temperature: float | None = None


def clamp(req: ChatRequest) -> tuple[int, float]:
    max_tokens = req.max_tokens if req.max_tokens else DEFAULT_MAX_TOKENS
    temperature = (
        req.temperature if req.temperature is not None else DEFAULT_TEMPERATURE
    )
    max_tokens = max(1, min(max_tokens, MAX_MAX_TOKENS))
    temperature = max(0.0, min(temperature, 2.0))
    return max_tokens, temperature


def error(status: int, message: str) -> JSONResponse:
    """The one error shape the frontend understands.

    Nothing internal ever leaves this process: no stack traces, no raw
    upstream bodies, no key material.
    """
    return JSONResponse(status_code=status, content={"error": {"message": message}})


def _json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def _snippet(body: Any) -> str:
    """Truncated upstream body for logs only — never sent to clients."""
    if body is None:
        return ""
    try:
        return json.dumps(body)[:400]
    except (TypeError, ValueError):
        return str(body)[:400]


async def call_groq(
    client: httpx.AsyncClient, payload: dict[str, Any], keys: list[str]
) -> tuple[int, Any]:
    """POST to Groq, moving to the next key on 401/403/429.

    Any other status is returned immediately: retrying with a different
    key cannot fix a malformed request or a retired model.
    """
    status, body = 502, None
    for index, key in enumerate(keys, start=1):
        try:
            response = await client.post(
                GROQ_URL,
                json=payload,
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
            )
        except httpx.HTTPError as exc:
            log.warning("network error calling groq with key #%d: %s", index, type(exc).__name__)
            status, body = 502, None
            continue

        status, body = response.status_code, _json(response)
        if status not in ROTATE_ON:
            return status, body
        log.warning("groq returned %d using key #%d — trying the next key", status, index)
    return status, body


async def handle(req: ChatRequest, *, model: str, token_param: str, request: Request) -> JSONResponse:
    keys = configured_keys()
    if not keys:
        log.error("no Groq key configured — set GROQ_KEY_1 (or GROQ_API_KEY) in backend/.env")
        return error(500, "The server is missing its AI API key configuration.")

    if not req.messages:
        return error(400, "No messages were supplied.")

    size = sum(
        len(m.content)
        if isinstance(m.content, str)
        else len(json.dumps(m.content))
        for m in req.messages
    )
    if size > MAX_MESSAGE_CHARS:
        return error(413, "That message is too large for the server.")

    max_tokens, temperature = clamp(req)
    payload: dict[str, Any] = {
        "model": model,
        token_param: max_tokens,
        "temperature": temperature,
        "messages": [m.model_dump() for m in req.messages],
    }

    client: httpx.AsyncClient = request.app.state.client
    status, body = await call_groq(client, payload, keys)

    # If this model rejects the token parameter name, retry once with the
    # other spelling so swapping models via .env keeps working.
    if status == 400 and token_param in _snippet(body):
        alt = "max_completion_tokens" if token_param == "max_tokens" else "max_tokens"
        log.warning("model %s rejected %s — retrying with %s", model, token_param, alt)
        payload.pop(token_param, None)
        payload[alt] = max_tokens
        status, body = await call_groq(client, payload, keys)

    if status == 200:
        return JSONResponse(content=body if isinstance(body, dict) else {})
    if status == 429:
        return error(429, "The AI service is rate-limited right now. Please try again in a few seconds.")
    if status in (401, 403):
        log.warning("groq rejected the configured key (status %s)", status)
        return error(502, "The AI service rejected the server's API key.")
    if status == 404:
        log.warning("model not available: %s", model)
        return error(502, "The configured AI model is not available on this account.")
    if status == 400:
        log.warning("groq rejected the request: %s", _snippet(body))
        return error(400, "The AI service rejected that request.")

    log.warning("groq returned unhandled status %s: %s", status, _snippet(body))
    return error(502, "The AI service is temporarily unavailable.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.client = httpx.AsyncClient(
        timeout=httpx.Timeout(60.0, connect=10.0),
        headers={"Content-Type": "application/json"},
    )
    yield
    await app.state.client.aclose()


app = FastAPI(title="AURA AI proxy", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    """Public liveness check — reports counts and model names, never keys."""
    return {
        "ok": True,
        "keys_configured": len(configured_keys()),
        "text_model": TEXT_MODEL,
        "vision_model": VISION_MODEL,
        "allowed_origins": allowed_origins(),
    }


@app.post("/api/chat")
async def chat(req: ChatRequest, request: Request) -> JSONResponse:
    return await handle(req, model=TEXT_MODEL, token_param="max_tokens", request=request)


@app.post("/api/chat/vision")
async def chat_vision(req: ChatRequest, request: Request) -> JSONResponse:
    return await handle(
        req, model=VISION_MODEL, token_param="max_completion_tokens", request=request
    )
