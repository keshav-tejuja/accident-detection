"""
Email Service — Python equivalent of Nodemailer
================================================
Mirrors the pattern: createTransport → verify → sendMail
Uses Gmail SMTP with App Passwords.
"""

import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

try:
    from twilio.rest import Client
except Exception:
    Client = None

from app.core.config import settings


# ── Gmail SMTP Transporter (equivalent to nodemailer.createTransport) ─────────
_SMTP_HOST = "smtp.gmail.com"
_SMTP_PORT = 587          # TLS (more reliable than SSL/465 on many networks)
_email_ready = False       # Set to True after successful verify()


def verify_email_service():
    """
    Equivalent to nodemailer's transporter.verify().
    Called once at startup to confirm Gmail SMTP credentials work.
    """
    global _email_ready

    email_user = settings.EMAIL_USER
    email_pass = settings.EMAIL_PASS

    if not email_user or not email_pass:
        print("❌ Email service error: EMAIL_USER or EMAIL_PASS missing in .env")
        _email_ready = False
        return

    try:
        context = ssl.create_default_context()
        server = smtplib.SMTP(_SMTP_HOST, _SMTP_PORT, timeout=10)
        server.ehlo()
        server.starttls(context=context)
        server.ehlo()
        server.login(email_user, email_pass)
        server.quit()
        _email_ready = True
        print("✅ Email service ready")
    except smtplib.SMTPAuthenticationError as e:
        _email_ready = False
        print(f"❌ Email service error: Authentication failed — {e}")
        print("   → Make sure EMAIL_PASS is a Gmail App Password (not your regular password)")
        print("   → Generate one at: https://myaccount.google.com/apppasswords")
    except Exception as e:
        _email_ready = False
        print(f"❌ Email service error: {e}")


# ── Send Email (equivalent to transporter.sendMail) ──────────────────────────
def _send_mail(*, to: str, subject: str, html: str, text: str = "") -> bool:
    """
    Low-level send function — mirrors nodemailer's transporter.sendMail().
    Returns True on success, False on failure.
    """
    email_user = settings.EMAIL_USER
    email_pass = settings.EMAIL_PASS
    email_from = settings.EMAIL_FROM or email_user

    if not email_user or not email_pass:
        print("📧 Email skipped — credentials not configured")
        return False

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = email_from
        msg["To"] = to

        # Plain-text fallback
        if text:
            msg.attach(MIMEText(text, "plain", "utf-8"))

        # Rich HTML version
        msg.attach(MIMEText(html, "html", "utf-8"))

        # Use TLS on port 587 (more reliable than SSL/465)
        context = ssl.create_default_context()
        server = smtplib.SMTP(_SMTP_HOST, _SMTP_PORT, timeout=15)
        server.ehlo()
        server.starttls(context=context)
        server.ehlo()
        server.login(email_user, email_pass)
        server.send_message(msg)
        server.quit()

        print(f"📧 Email sent to {to}")
        return True
    except Exception as e:
        print(f"Email send failed: {e}")
        return False


# ── HTML Email Templates ─────────────────────────────────────────────────────

def build_crash_alert_email(
    *,
    severity: str = "Critical",
    audit_id: str = "N/A",
    timestamp: str = "N/A",
    coordinates: str = "N/A",
    maps_url: str = "",
) -> str:
    """
    Build HTML email template for crash alert.
    Equivalent to buildPriceAlertEmail from your Nodemailer code.
    """
    severity_color = "#dc2626" if severity == "Critical" else "#f59e0b"

    maps_button = ""
    if maps_url and maps_url != "N/A":
        maps_button = f"""
        <a href="{maps_url}"
           style="display:inline-block;background:#dc2626;color:#fff;
                  padding:14px 36px;border-radius:8px;text-decoration:none;
                  font-weight:700;font-size:14px;letter-spacing:1px;
                  text-transform:uppercase;margin-top:8px;">
          📍 Open in Google Maps
        </a>
        """

    return f"""
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #dc2626, #991b1b); padding: 28px 24px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 22px; letter-spacing: 2px;">🚨 SafeTrack AI — CRASH ALERT</h1>
        <p style="color: #fecaca; margin: 8px 0 0; font-size: 13px; letter-spacing: 1px;">
          Autonomous Collision Detection System
        </p>
      </div>
      <div style="background: #f8fafc; padding: 28px 24px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0; border-top: none;">
        <p style="color: #334155; font-size: 15px; line-height: 1.6; margin-top: 0;">
          A collision event has been detected by the AI monitoring system.
          Immediate emergency response may be required.
        </p>
        <div style="background: white; padding: 20px; border-radius: 10px;
                    border-left: 5px solid {severity_color}; margin: 20px 0;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.06);">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-size: 13px; font-weight: 600; width: 130px;">Severity</td>
              <td style="padding: 8px 0; color: {severity_color}; font-size: 13px; font-weight: 700;">{severity}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-size: 13px; font-weight: 600;">Audit ID</td>
              <td style="padding: 8px 0; color: #1e293b; font-size: 13px; font-family: monospace;">{audit_id}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-size: 13px; font-weight: 600;">Timestamp</td>
              <td style="padding: 8px 0; color: #1e293b; font-size: 13px;">{timestamp}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-size: 13px; font-weight: 600;">Coordinates</td>
              <td style="padding: 8px 0; color: #1e293b; font-size: 13px;">{coordinates}</td>
            </tr>
          </table>
        </div>
        <div style="text-align: center; margin: 24px 0 16px;">
          {maps_button}
        </div>
        <p style="color: #94a3b8; font-size: 11px; margin-top: 24px; text-align: center; letter-spacing: 0.5px;">
          This alert was generated automatically by SafeTrack AI.
          Emergency services may have been notified via SMS.
        </p>
      </div>
    </div>
    """


# ── Public API (used by main.py) ─────────────────────────────────────────────

def send_emergency_email(to_email: str, message: str, **kwargs) -> bool:
    """
    High-level function called by the incident pipeline.
    Builds the HTML template and sends via Gmail SMTP.

    Extra kwargs accepted: severity, audit_id, timestamp, coordinates, maps_url
    — if not provided, they are parsed from the plain-text message.

    Returns True if email was sent, raises on failure.
    """
    if not to_email:
        print("No destination email provided.")
        return False

    if not _email_ready:
        print(f"⚠️ Email service not ready — attempting direct send to {to_email}")

    # Parse structured fields from plain-text message if kwargs not given
    severity    = kwargs.get("severity", "Critical")
    audit_id    = kwargs.get("audit_id", "N/A")
    timestamp   = kwargs.get("timestamp", "N/A")
    coordinates = kwargs.get("coordinates", "N/A")
    maps_url    = kwargs.get("maps_url", "")

    # Try to extract from message lines as fallback
    if not kwargs:
        for line in message.strip().split("\n"):
            line = line.strip()
            if line.lower().startswith("severity:"):
                severity = line.split(":", 1)[1].strip()
            elif line.lower().startswith("audit id:"):
                audit_id = line.split(":", 1)[1].strip()
            elif line.lower().startswith("timestamp:"):
                timestamp = line.split(":", 1)[1].strip()
            elif line.lower().startswith("coordinates:"):
                coordinates = line.split(":", 1)[1].strip()
            elif line.lower().startswith("maps:"):
                maps_url = line.split(":", 1)[1].strip()
                # Re-attach the "https:" that got split
                if maps_url.startswith(" //") or maps_url.startswith("//"):
                    maps_url = "https:" + maps_url.strip()
                elif not maps_url.startswith("http"):
                    maps_url = "https:" + maps_url.strip()

    html = build_crash_alert_email(
        severity=severity,
        audit_id=audit_id,
        timestamp=timestamp,
        coordinates=coordinates,
        maps_url=maps_url,
    )

    success = _send_mail(
        to=to_email,
        subject=f"🚨 CRASH ALERT — {severity} — SafeTrack AI",
        html=html,
        text=message,
    )

    if not success:
        raise RuntimeError(f"Failed to send email to {to_email}")

    return True


# ── SMS via Twilio ────────────────────────────────────────────────────────────

def send_emergency_alert(contacts: list, message: str) -> None:
    """
    Sends emergency alerts via SMS using Twilio.
    """
    if not contacts:
        print("No contacts to alert.")
        return

    if Client is None:
        print("📱 SMS skipped — Twilio not installed")
        return

    if not settings.TWILIO_ACCOUNT_SID or not settings.TWILIO_AUTH_TOKEN or not settings.TWILIO_PHONE_NUMBER:
        print("📱 SMS skipped — Twilio not configured")
        for phone in contacts:
            print(f"  [Simulated SMS to {phone}]: {message}")
        return

    try:
        client = Client(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN)
        print("=== EMERGENCY SMS ALERT TRIGGERED ===")
        for phone in contacts:
            try:
                sms = client.messages.create(
                    body=message,
                    from_=settings.TWILIO_PHONE_NUMBER,
                    to=phone
                )
                print(f"📱 SMS sent to {phone} — SID {sms.sid}")
            except Exception as e:
                print(f"SMS send failed to {phone}: {e}")
        print("=====================================")
    except Exception as e:
        print(f"Failed to initialize Twilio Client: {e}")
