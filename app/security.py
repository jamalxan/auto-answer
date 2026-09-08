"""
Token encryption at rest (NFR-5) + JWT auth for the admin panel + password hashing.
"""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken
from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import get_settings

settings = get_settings()
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def generate_otp_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def hash_otp_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def verify_otp_code(code: str, code_hash: str) -> bool:
    return secrets.compare_digest(hash_otp_code(code), code_hash)


def _fernet() -> Fernet:
    key = settings.token_encryption_key
    if not key:
        raise RuntimeError(
            "TOKEN_ENCRYPTION_KEY is not set. Generate one with "
            "`python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\"`"
        )
    return Fernet(key.encode())


def encrypt_token(raw_token: str) -> str:
    return _fernet().encrypt(raw_token.encode()).decode()


def decrypt_token(encrypted_token: str) -> str:
    try:
        return _fernet().decrypt(encrypted_token.encode()).decode()
    except InvalidToken as exc:
        raise ValueError("Could not decrypt stored access token") from exc


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def create_access_token(subject: str, extra: Optional[dict] = None) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    payload = {"sub": subject, "exp": expire}
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.app_secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.app_secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError as exc:
        raise ValueError("Invalid or expired token") from exc
