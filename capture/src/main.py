"""ghost-capture — handles raw media streams + provider webhooks.

Responsibility split:
  * api service  — owns GEMINI_API_KEY, runs the analysis brain
  * capture      — owns Recall.ai and R2 surfaces, ingests media, calls back into api
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from . import r2

app = FastAPI(title="ghost-capture")

API_SERVICE_URL = os.environ.get("API_SERVICE_URL", "http://api:3000")
RECALL_REGION = os.environ.get("RECALL_AI_REGION", "us-west-2")
RECALL_API_KEY = os.environ.get("RECALL_AI_API_KEY", "")
RECALL_BASE = f"https://{RECALL_REGION}.recall.ai/api/v1"

# Svix-style signing secret Recall.ai issues per webhook subscription. Format:
# "whsec_<base64>". When set we verify every /webhooks/recall request; when
# empty we log a warning and accept anyway (dev mode — required so a fresh
# checkout can run before the operator has registered a subscription).
RECALL_WEBHOOK_SECRET = os.environ.get("RECALL_AI_WEBHOOK_SECRET", "")
# Replay-protection window. Svix recommends 5 minutes.
RECALL_WEBHOOK_TOLERANCE_SEC = 5 * 60


# ----------------------------------------------------------------- Health

@app.get("/health")
def health():
    return {"status": "ok", "service": "ghost-capture"}


@app.get("/webhooks/healthz")
def webhooks_healthz():
    return {"status": "ok", "endpoint": "webhooks"}


# ----------------------------------------------------------------- Webhooks

@app.post("/webhooks/skribby")
async def skribby_webhook(request: Request):
    _ = os.environ.get("SKRIBBY_WEBHOOK_SECRET", "")
    await request.body()
    return {"received": True, "provider": "skribby"}


def _verify_svix_signature(headers, body: bytes) -> tuple[bool, str]:
    """Verify a Svix-style webhook signature against RECALL_WEBHOOK_SECRET.

    Returns (ok, reason). When the secret is unset (dev mode) returns
    (True, 'no-secret-configured') and the caller is expected to log a
    warning so the operator notices the open door.

    Svix scheme (https://docs.svix.com/receiving/verifying-payloads/how-manual):
      signed_content = f"{svix-id}.{svix-timestamp}.{body}"
      signature      = base64(hmac_sha256(decoded_secret, signed_content))
      svix-signature header = "v1,<sig1> v1,<sig2> ..." (rotation-friendly)
    """
    if not RECALL_WEBHOOK_SECRET:
        return True, "no-secret-configured"

    if not RECALL_WEBHOOK_SECRET.startswith("whsec_"):
        return False, "secret-missing-whsec-prefix"

    msg_id = headers.get("svix-id") or headers.get("webhook-id")
    msg_ts = headers.get("svix-timestamp") or headers.get("webhook-timestamp")
    msg_sig = headers.get("svix-signature") or headers.get("webhook-signature")
    if not (msg_id and msg_ts and msg_sig):
        return False, "missing-svix-headers"

    try:
        ts = int(msg_ts)
    except ValueError:
        return False, "bad-timestamp"
    if abs(int(time.time()) - ts) > RECALL_WEBHOOK_TOLERANCE_SEC:
        return False, "timestamp-outside-tolerance"

    try:
        key = base64.b64decode(RECALL_WEBHOOK_SECRET[len("whsec_"):])
    except Exception:  # noqa: BLE001
        return False, "secret-not-base64"

    signed = msg_id.encode() + b"." + msg_ts.encode() + b"." + body
    expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()

    # Header is space-separated entries like "v1,<sig>" — any one matching wins.
    for entry in msg_sig.split():
        try:
            version, sig = entry.split(",", 1)
        except ValueError:
            continue
        if version != "v1":
            continue
        if hmac.compare_digest(sig, expected):
            return True, "verified"
    return False, "signature-mismatch"


# Lifecycle events — security-critical because they trigger `_on_bot_done`,
# which fetches the canonical transcript + video and runs the Gemini pipeline.
# An attacker who can spoof these can replay any prior meeting and burn quota.
_LIFECYCLE_EVENTS = frozenset({
    "bot.status_change", "bot.done", "bot.recording_done", "recording.done",
})


@app.post("/webhooks/recall")
async def recall_webhook(request: Request):
    # Read raw bytes once — Svix verification needs the exact body the sender
    # signed, so we cannot let FastAPI reparse JSON before this point.
    body = await request.body()
    try:
        payload: dict[str, Any] = json.loads(body) if body else {}
    except ValueError:
        return JSONResponse({"error": "invalid-json"}, status_code=400)

    event = payload.get("event") or payload.get("type") or "unknown"
    ok, reason = _verify_svix_signature(request.headers, body)

    # Signature policy:
    #   * Lifecycle events (bot.status_change → done) MUST verify when the
    #     secret is configured — these drive the analysis pipeline.
    #   * Realtime stream events (transcript.data, transcript.partial_data)
    #     are accept-with-warning if unsigned: forging them can only pollute
    #     a per-event log, since the canonical transcript is fetched from
    #     Recall's S3 inside _on_bot_done before any analysis runs.
    is_lifecycle = event in _LIFECYCLE_EVENTS
    if not ok:
        if is_lifecycle:
            print(f"[recall-webhook] rejecting {event}: {reason}")
            return JSONResponse({"error": "unauthorized", "reason": reason}, status_code=401)
        # Non-lifecycle, signature failed → log loudly but accept.
        print(f"[recall-webhook] WARNING: unsigned {event} accepted ({reason})")
    elif reason == "no-secret-configured":
        print(f"[recall-webhook] WARNING: {event} accepted without check — RECALL_AI_WEBHOOK_SECRET not set")

    data = payload.get("data", payload)
    bot_id = (
        data.get("bot_id")
        or data.get("bot", {}).get("id")
        or payload.get("bot_id")
    )

    print(f"[recall-webhook] event={event} bot={bot_id}")

    # Real-time transcript chunks arrive frequently. Keep these cheap — just
    # stash to Redis later if needed. For the First Loop we only need bot.done.
    if event in ("transcript.data", "transcript.partial_data"):
        return {"received": True, "type": event}

    # When the recording completes, kick off the analysis pipeline.
    # Recall.ai v1 (2026-05) replaced bot.done / bot.recording_done with
    # bot.status_change carrying a status.code of "done" / "call_ended" /
    # "recording_done". Accept both shapes so older test fixtures still work.
    status_code = ((data.get("status") or {}) if isinstance(data, dict) else {}).get("code")
    is_done = (
        event in ("bot.done", "bot.recording_done", "recording.done")
        or (event == "bot.status_change" and status_code in ("done", "recording_done", "call_ended"))
    )
    if is_done:
        try:
            await _on_bot_done(bot_id, data)
        except Exception as exc:  # noqa: BLE001 — webhook receipts must 200
            print(f"[recall-webhook] processing failed: {exc!r}")
        return {"received": True, "type": event, "bot_id": bot_id, "status": status_code}

    return {"received": True, "type": event, "bot_id": bot_id}


async def _on_bot_done(bot_id: str | None, _data: dict[str, Any]):
    if not bot_id:
        print("[recall-webhook] bot.done without bot_id, skipping")
        return

    # 1) Fetch bot details. Recall.ai v1 (2026-05) moved transcript + video
    # off dedicated endpoints — they're now signed S3 URLs hanging off
    # bot.recordings[0].media_shortcuts.{transcript,video_mixed}.data.download_url.
    async with httpx.AsyncClient(timeout=60) as client:
        bot = await _recall_get(client, f"/bot/{bot_id}/")
        recordings = bot.get("recordings") or []
        shortcuts = (recordings[0].get("media_shortcuts") if recordings else {}) or {}
        transcript_dl = ((shortcuts.get("transcript") or {}).get("data") or {}).get("download_url")
        video_dl = ((shortcuts.get("video_mixed") or {}).get("data") or {}).get("download_url")

        transcript_raw: Any = []
        if transcript_dl:
            # Signed S3 URL — no Authorization header.
            res = await client.get(transcript_dl)
            res.raise_for_status()
            transcript_raw = res.json()
        else:
            print(f"[recall-webhook] bot={bot_id} has no transcript media_shortcut")

    transcript = _normalize_recall_transcript(bot, transcript_raw)
    video_url = video_dl or bot.get("video_url")  # fallback for legacy fixtures

    # 2) Pull video → R2 (best-effort; First Loop tolerates this failing).
    archived = None
    if video_url:
        try:
            archived = await _archive_video(bot_id, video_url)
        except Exception as exc:  # noqa: BLE001
            print(f"[recall-webhook] R2 archive failed: {exc!r}")

    # 3) Hand off to api service for Gemini analysis + portal creation.
    meeting_id = (bot.get("metadata") or {}).get("meetingId")
    if not meeting_id:
        print(f"[recall-webhook] no meetingId in bot.metadata for bot={bot_id}")
        return

    async with httpx.AsyncClient(timeout=120) as client:
        await client.post(
            f"{API_SERVICE_URL}/_internal/meetings/{meeting_id}/process",
            json={
                "transcript": transcript,
                "videoUrl": (archived or {}).get("publicUrl") or video_url,
            },
        )


# ----------------------------------------------------------------- Helpers

async def _recall_get(client: httpx.AsyncClient, path: str) -> dict[str, Any]:
    res = await client.get(
        RECALL_BASE + path,
        headers={"Authorization": f"Token {RECALL_API_KEY}", "Accept": "application/json"},
    )
    res.raise_for_status()
    return res.json()


def _word_time(word: dict[str, Any], end: bool = False) -> float:
    """Pull a word's start/end seconds across legacy and v1 shapes."""
    key = "end_timestamp" if end else "start_timestamp"
    ts = word.get(key)
    if isinstance(ts, dict):
        return float(ts.get("relative") or 0)
    legacy_key = "end_time" if end else "start_time"
    return float(word.get(legacy_key) or word.get("end" if end else "start") or 0)


def _normalize_recall_transcript(bot: dict[str, Any], transcript_raw: Any) -> dict[str, Any]:
    """Convert Recall.ai transcript shape into the shape api/src/analysis.js expects.

    Handles both legacy ([{speaker, words:[{text,start_time}]}]) and v1
    diarized ([{participant:{name,is_host}, words:[{text,start_timestamp:{relative}}]}])
    payloads. Roles: meeting host → 'rep', everyone else → 'prospect'.
    """
    segments: list[list[Any]] = []
    participants_seen: dict[str, dict[str, str]] = {}

    if isinstance(transcript_raw, list):
        for utt in transcript_raw:
            participant = utt.get("participant") or {}
            speaker = (
                participant.get("name")
                or utt.get("speaker")
                or utt.get("name")
                or "speaker"
            )
            words = utt.get("words") or []
            if not words:
                continue
            start = _word_time(words[0], end=False)
            end = _word_time(words[-1], end=True) or start
            text = " ".join(w.get("text", "") for w in words).strip()
            if not text:
                continue
            if speaker not in participants_seen:
                role = "rep" if participant.get("is_host") else (
                    "rep" if not participants_seen else "prospect"
                )
                participants_seen[speaker] = {"role": role, "name": speaker}
            role = participants_seen[speaker]["role"]
            segments.append([round(start), round(end), role, text])

    return {
        "meetingTitle": (bot.get("metadata") or {}).get("title") or "DealScope Note Taker Report",
        "durationSeconds": int(bot.get("duration_seconds") or (segments[-1][1] if segments else 0)),
        "participants": list(participants_seen.values()) or [{"role": "rep", "name": "Rep"}],
        "segments": segments,
    }


async def _archive_video(bot_id: str, video_url: str) -> dict[str, Any]:
    """Stream the Recall.ai video URL into R2 under recordings/<bot>/<ts>.mp4."""
    timestamp = int(time.time())
    key = f"recordings/{bot_id}/{timestamp}.mp4"
    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream("GET", video_url) as upstream:
            upstream.raise_for_status()
            content = await upstream.aread()
    return r2.upload_bytes(key, content, content_type="video/mp4")
