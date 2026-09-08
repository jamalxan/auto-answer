import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_db
from app.models.admin_user import AdminUser
from app.models.email_otp import EmailOTP
from app.schemas.auth import LoginRequest, RegisterRequest, RequestOtpRequest, TokenResponse
from app.security import (
    create_access_token,
    generate_otp_code,
    hash_otp_code,
    hash_password,
    verify_otp_code,
    verify_password,
)
from app.services.notifications import send_otp_email

logger = logging.getLogger("auth")
router = APIRouter(prefix="/api/auth", tags=["auth"])

OTP_TTL_MINUTES = 10
OTP_RESEND_COOLDOWN_SECONDS = 60
OTP_MAX_ATTEMPTS = 5


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(AdminUser).where(AdminUser.email == payload.email))
    user = res.scalar_one_or_none()
    if user is None or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    token = create_access_token(subject=user.email, extra={"role": user.role})
    return TokenResponse(access_token=token)


@router.post("/register/request-otp", status_code=status.HTTP_204_NO_CONTENT)
async def request_register_otp(payload: RequestOtpRequest, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(AdminUser).where(AdminUser.email == payload.email))
    if res.scalar_one_or_none() is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Bu email bilan hisob allaqachon mavjud")

    res = await db.execute(
        select(EmailOTP)
        .where(EmailOTP.email == payload.email, EmailOTP.purpose == "register")
        .order_by(EmailOTP.created_at.desc())
        .limit(1)
    )
    last = res.scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if last is not None and (now - last.created_at) < timedelta(seconds=OTP_RESEND_COOLDOWN_SECONDS):
        wait = OTP_RESEND_COOLDOWN_SECONDS - int((now - last.created_at).total_seconds())
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, f"{wait} soniyadan so'ng qayta urinib ko'ring")

    code = generate_otp_code()
    otp = EmailOTP(
        email=payload.email,
        code_hash=hash_otp_code(code),
        purpose="register",
        expires_at=now + timedelta(minutes=OTP_TTL_MINUTES),
    )
    db.add(otp)

    try:
        send_otp_email(payload.email, code)
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller as-is
        logger.error("OTP email failed for %s: %s", payload.email, exc)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Email yuborib bo'lmadi: {exc}") from exc

    await db.commit()


@router.post("/register/verify", response_model=TokenResponse)
async def register_verify(payload: RegisterRequest, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(AdminUser).where(AdminUser.email == payload.email))
    if res.scalar_one_or_none() is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Bu email bilan hisob allaqachon mavjud")

    res = await db.execute(
        select(EmailOTP)
        .where(EmailOTP.email == payload.email, EmailOTP.purpose == "register", EmailOTP.consumed_at.is_(None))
        .order_by(EmailOTP.created_at.desc())
        .limit(1)
    )
    otp = res.scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if otp is None or otp.expires_at < now:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kod eskirgan yoki topilmadi. Qaytadan so'rang")
    if otp.attempts >= OTP_MAX_ATTEMPTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Urinishlar soni tugadi. Qaytadan kod so'rang")
    if not verify_otp_code(payload.code, otp.code_hash):
        otp.attempts += 1
        await db.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kod noto'g'ri")

    otp.consumed_at = now
    user = AdminUser(email=payload.email, password_hash=hash_password(payload.password))
    db.add(user)
    await db.commit()

    token = create_access_token(subject=user.email, extra={"role": user.role})
    return TokenResponse(access_token=token)
