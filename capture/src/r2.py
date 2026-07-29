"""Cloudflare R2 upload helper (S3-compatible)."""
from __future__ import annotations

import os
import boto3
import httpx
from botocore.client import Config


def _client():
    endpoint = os.environ["R2_ENDPOINT"]
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )


def upload_bytes(key: str, body: bytes, content_type: str = "application/octet-stream"):
    bucket = os.environ["R2_BUCKET"]
    _client().put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type)
    public_base = os.environ.get("R2_PUBLIC_BASE_URL", "").rstrip("/")
    return {
        "bucket": bucket,
        "key": key,
        "publicUrl": f"{public_base}/{key}" if public_base else None,
    }


def upload_stream(key: str, fileobj, content_type: str = "application/octet-stream"):
    bucket = os.environ["R2_BUCKET"]
    _client().upload_fileobj(
        fileobj,
        bucket,
        key,
        ExtraArgs={"ContentType": content_type},
    )
    public_base = os.environ.get("R2_PUBLIC_BASE_URL", "").rstrip("/")
    return {
        "bucket": bucket,
        "key": key,
        "publicUrl": f"{public_base}/{key}" if public_base else None,
    }


class _HttpxStreamReader:
    """Adapts a *synchronous* httpx streaming response to the read(size)
    file interface boto3's upload_fileobj expects.

    upload_fileobj pulls fixed-size chunks and multipart-uploads them as it
    goes, so at no point does the full body sit in memory or on disk — only
    ever a few chunks. That's the whole point: recordings run 1-2h / multi-GB,
    and this container's /tmp is a 64MB tmpfs, so buffering (RAM or disk) is
    not an option; this must be a true pass-through.
    """

    def __init__(self, response: httpx.Response):
        self._iter = response.iter_bytes()
        self._buf = b""

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            chunks = [self._buf]
            self._buf = b""
            chunks.extend(self._iter)
            return b"".join(chunks)
        while len(self._buf) < size:
            try:
                self._buf += next(self._iter)
            except StopIteration:
                break
        data, self._buf = self._buf[:size], self._buf[size:]
        return data


def upload_video_from_url(key: str, video_url: str, content_type: str = "video/mp4", timeout: float = 300):
    """GET video_url and stream the response body straight into R2.

    Uses a synchronous httpx.Client (not the app's async client) because
    boto3's upload_fileobj is itself blocking with no async form — the caller
    is expected to run this off the event loop via asyncio.to_thread. Kept
    here rather than in main.py so all R2/boto3 specifics stay in one module.
    """
    bucket = os.environ["R2_BUCKET"]
    with httpx.Client(timeout=timeout) as client:
        with client.stream("GET", video_url) as response:
            response.raise_for_status()
            fileobj = _HttpxStreamReader(response)
            _client().upload_fileobj(fileobj, bucket, key, ExtraArgs={"ContentType": content_type})
    public_base = os.environ.get("R2_PUBLIC_BASE_URL", "").rstrip("/")
    return {
        "bucket": bucket,
        "key": key,
        "publicUrl": f"{public_base}/{key}" if public_base else None,
    }
