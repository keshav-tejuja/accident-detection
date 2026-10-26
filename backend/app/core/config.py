import os
from pathlib import Path
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
    FIREBASE_CREDENTIALS_PATH: str = os.getenv("FIREBASE_CREDENTIALS_PATH", "firebase-key.json")
    RAZORPAY_KEY_ID: str = os.getenv("RAZORPAY_KEY_ID", "")
    RAZORPAY_KEY_SECRET: str = os.getenv("RAZORPAY_KEY_SECRET", "")
    PAYMENT_VERIFICATION_SECRET: str = os.getenv("PAYMENT_VERIFICATION_SECRET", "")

    # Twilio / SMS
    TWILIO_ACCOUNT_SID: str = os.getenv("TWILIO_ACCOUNT_SID", "")
    TWILIO_AUTH_TOKEN: str = os.getenv("TWILIO_AUTH_TOKEN", "")
    TWILIO_PHONE_NUMBER: str = os.getenv("TWILIO_PHONE_NUMBER", "")
    TARGET_PHONE_NUMBER: str = os.getenv("TARGET_PHONE_NUMBER", "")
    TWILIO_FROM_NUMBER: str = os.getenv(
        "TWILIO_FROM_NUMBER",
        os.getenv("TWILIO_PHONE_NUMBER", os.getenv("TARGET_PHONE_NUMBER", "")),
    )

    # Email / SMTP
    EMAIL_USER: str = os.getenv("EMAIL_USER", "")
    EMAIL_PASS: str = os.getenv("EMAIL_PASS", "")
    EMAIL_FROM: str = os.getenv("EMAIL_FROM", "")
    ALERT_EMAIL: str = os.getenv("ALERT_EMAIL", "keshavkt01@gmail.com")

    # Groq AI — for PDF report content generation
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "")
    GROQ_MODEL: str = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")

    # Super Admin — credentials configured via environment only, never hardcoded
    SUPER_ADMIN_EMAIL: str = os.getenv("SUPER_ADMIN_EMAIL", "")
    SUPER_ADMIN_PASSWORD: str = os.getenv("SUPER_ADMIN_PASSWORD", "")

    class Config:
        env_file = Path(__file__).resolve().parents[2] / ".env"

settings = Settings()