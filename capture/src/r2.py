"""Cloudflare R2 upload helper (S3-compatible)."""
from __future__ import annotations

import os
import boto3
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
