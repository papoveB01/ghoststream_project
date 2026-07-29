"""Coverage for _verify_svix_signature (src/main.py).

Why this exists: the function used to return "ok" whenever
RECALL_AI_WEBHOOK_SECRET was unset, and docker-compose defaults that var to
empty — so one missing env line left /webhooks/recall fully unauthenticated
and replayable. Anyone who knew (or guessed) a bot id could POST a fake
bot.status_change "done" and re-trigger the archive + Gemini pipeline,
burning the ~$1/bot Recall.ai meter and reprocessing past meetings. The fix
fails closed by default and only accepts unsigned requests when a developer
explicitly opts in via ALLOW_UNSIGNED_WEBHOOKS=1. These tests pin that
contract so it can't quietly regress back to fail-open.

Run: python -m pytest tests -q   (from capture/, so `src` resolves — see
capture/Dockerfile, which runs uvicorn as `src.main:app` the same way).
"""
import base64
import hashlib
import hmac
import time

from src import main as capture_main

# Not a real secret — arbitrary bytes standing in for what Recall.ai issues.
_SECRET_RAW = b"unit-test-secret-material-not-real"
_WHSEC = "whsec_" + base64.b64encode(_SECRET_RAW).decode()


def _sign(msg_id: str, ts: str, body: bytes, whsec: str = _WHSEC) -> str:
    key = base64.b64decode(whsec[len("whsec_"):])
    signed = f"{msg_id}.{ts}.".encode() + body
    sig = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
    return f"v1,{sig}"


def _headers(msg_id: str, ts: str, sig: str) -> dict:
    return {"svix-id": msg_id, "svix-timestamp": ts, "svix-signature": sig}


def test_unset_secret_fails_closed(monkeypatch):
    # The core regression: no secret configured must REJECT, not accept.
    monkeypatch.setattr(capture_main, "RECALL_WEBHOOK_SECRET", "")
    monkeypatch.setattr(capture_main, "ALLOW_UNSIGNED_WEBHOOKS", False)

    ok, reason = capture_main._verify_svix_signature({}, b"{}")

    assert ok is False
    assert reason == "no-secret-configured"


def test_unset_secret_with_dev_optin_is_accepted(monkeypatch):
    # The deliberate escape hatch for a fresh local checkout with no webhook
    # subscription registered yet — must require the explicit env var.
    monkeypatch.setattr(capture_main, "RECALL_WEBHOOK_SECRET", "")
    monkeypatch.setattr(capture_main, "ALLOW_UNSIGNED_WEBHOOKS", True)

    ok, reason = capture_main._verify_svix_signature({}, b"{}")

    assert ok is True
    assert reason == "no-secret-configured-dev-optin"


def test_valid_signature_verifies(monkeypatch):
    monkeypatch.setattr(capture_main, "RECALL_WEBHOOK_SECRET", _WHSEC)
    monkeypatch.setattr(capture_main, "ALLOW_UNSIGNED_WEBHOOKS", False)
    body = b'{"event":"bot.status_change","data":{"status":{"code":"done"}}}'
    msg_id, ts = "msg_1", str(int(time.time()))
    sig = _sign(msg_id, ts, body)

    ok, reason = capture_main._verify_svix_signature(_headers(msg_id, ts, sig), body)

    assert ok is True
    assert reason == "verified"


def test_tampered_body_is_rejected(monkeypatch):
    monkeypatch.setattr(capture_main, "RECALL_WEBHOOK_SECRET", _WHSEC)
    monkeypatch.setattr(capture_main, "ALLOW_UNSIGNED_WEBHOOKS", False)
    msg_id, ts = "msg_2", str(int(time.time()))
    sig = _sign(msg_id, ts, b'{"event":"bot.status_change"}')
    tampered_body = b'{"event":"bot.status_change","evil":true}'

    ok, reason = capture_main._verify_svix_signature(_headers(msg_id, ts, sig), tampered_body)

    assert ok is False
    assert reason == "signature-mismatch"


def test_tampered_signature_is_rejected(monkeypatch):
    monkeypatch.setattr(capture_main, "RECALL_WEBHOOK_SECRET", _WHSEC)
    monkeypatch.setattr(capture_main, "ALLOW_UNSIGNED_WEBHOOKS", False)
    body = b'{"event":"bot.status_change"}'
    msg_id, ts = "msg_3", str(int(time.time()))
    sig = _sign(msg_id, ts, body)
    flipped = sig[:-1] + ("a" if sig[-1] != "a" else "b")

    ok, reason = capture_main._verify_svix_signature(_headers(msg_id, ts, flipped), body)

    assert ok is False
    assert reason == "signature-mismatch"


def test_stale_timestamp_outside_tolerance_is_rejected(monkeypatch):
    monkeypatch.setattr(capture_main, "RECALL_WEBHOOK_SECRET", _WHSEC)
    monkeypatch.setattr(capture_main, "ALLOW_UNSIGNED_WEBHOOKS", False)
    body = b'{"event":"bot.status_change"}'
    msg_id = "msg_4"
    stale_ts = str(int(time.time()) - capture_main.RECALL_WEBHOOK_TOLERANCE_SEC - 60)
    sig = _sign(msg_id, stale_ts, body)

    ok, reason = capture_main._verify_svix_signature(_headers(msg_id, stale_ts, sig), body)

    assert ok is False
    assert reason == "timestamp-outside-tolerance"
