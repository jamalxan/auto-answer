"""
One-off admin bootstrap: python -m app.cli create-admin --email you@example.com --password secret
"""
import argparse
import asyncio

from app.database import AsyncSessionLocal
from app.models.admin_user import AdminUser
from app.security import hash_password


async def create_admin(email: str, password: str) -> None:
    async with AsyncSessionLocal() as session:
        session.add(AdminUser(email=email, password_hash=hash_password(password), role="admin"))
        await session.commit()
    print(f"Admin user created: {email}")


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    create_parser = sub.add_parser("create-admin")
    create_parser.add_argument("--email", required=True)
    create_parser.add_argument("--password", required=True)

    args = parser.parse_args()
    if args.command == "create-admin":
        asyncio.run(create_admin(args.email, args.password))


if __name__ == "__main__":
    main()
