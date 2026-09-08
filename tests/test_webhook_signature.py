import base64
import hashlib
import hmac
import json

import pytest

from app.routers.webhooks import _valid_signature, parse_signed_request, settings


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setattr(settings, "meta_app_secret", "test-secret")
    yield


def _sign(body: bytes, secret: str = "test-secret") -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_valid_signature_accepted():
    body = b'{"object":"instagram"}'
    assert _valid_signature(body, _sign(body)) is True


def test_wrong_secret_rejected():
    body = b'{"object":"instagram"}'
    assert _valid_signature(body, _sign(body, secret="wrong-secret")) is False


def test_tampered_body_rejected():
    body = b'{"object":"instagram"}'
    sig = _sign(body)
    tampered = b'{"object":"tampered"}'
    assert _valid_signature(tampered, sig) is False


def test_missing_signature_rejected():
    assert _valid_signature(b"{}", None) is False


def test_signature_without_sha256_prefix_rejected():
    assert _valid_signature(b"{}", "deadbeef") is False


def test_malformed_signature_rejected():
    assert _valid_signature(b"{}", "sha256=not-valid-hex-zz") is False


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _make_signed_request(payload: dict, secret: str = "test-secret") -> str:
    encoded_payload = _b64url(json.dumps(payload).encode())
    sig = hmac.new(secret.encode(), encoded_payload.encode(), hashlib.sha256).digest()
    return f"{_b64url(sig)}.{encoded_payload}"


def test_signed_request_valid_roundtrips_payload():
    sr = _make_signed_request({"user_id": "12345", "algorithm": "HMAC-SHA256"})
    assert parse_signed_request(sr, "test-secret") == {"user_id": "12345", "algorithm": "HMAC-SHA256"}


def test_signed_request_wrong_secret_rejected():
    sr = _make_signed_request({"user_id": "12345"}, secret="test-secret")
    with pytest.raises(ValueError):
        parse_signed_request(sr, "wrong-secret")


def test_signed_request_missing_separator_rejected():
    with pytest.raises(ValueError):
        parse_signed_request("not-a-signed-request", "test-secret")


def test_signed_request_tampered_payload_rejected():
    sr = _make_signed_request({"user_id": "12345"})
    sig, payload = sr.split(".", 1)
    tampered_payload = _b64url(json.dumps({"user_id": "99999"}).encode())
    with pytest.raises(ValueError):
        parse_signed_request(f"{sig}.{tampered_payload}", "test-secret")
