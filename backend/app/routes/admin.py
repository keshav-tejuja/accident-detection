"""
Super Admin Routes
==================
Provides protected administrative endpoints.

All endpoints require role == 'admin' or 'super_admin' — enforced server-side.
The Super Admin account is seeded via POST /api/admin/init-super-admin
using credentials from environment variables (SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD).

Endpoints:
    POST /api/admin/init-super-admin    — one-time admin account seeding
    GET  /api/admin/stats               — dashboard overview counts
    GET  /api/admin/incidents           — all incidents (all users)
    GET  /api/admin/incidents/{id}      — incident detail
    PATCH /api/admin/incidents/{id}/status  — update review status
    POST /api/admin/incidents/{id}/notify-authorities  — authority escalation
    GET  /api/admin/reports             — all reports (all users)
    GET  /api/admin/analytics           — aggregate analytics for charts + CSV
"""

import os
import time
import secrets
import csv
import io as _io
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from firebase_admin import firestore, auth

from app.services.firebase_service import get_current_user, get_firestore_client
from app.core.config import settings

router = APIRouter()


# ── Role guard ────────────────────────────────────────────────────────────────

def _require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") not in ("admin", "super_admin", "authority"):
        raise HTTPException(status_code=403, detail="Administrator access required")
    return user


# ── One-time Super Admin seeding ──────────────────────────────────────────────

@router.post("/init-super-admin")
async def init_super_admin():
    """
    Idempotent admin account seeder.
    Run once via:  POST /api/admin/init-super-admin
    Requires SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD in the environment.
    Does NOT create a duplicate if an admin with this email already exists.
    """
    email = settings.SUPER_ADMIN_EMAIL
    password = settings.SUPER_ADMIN_PASSWORD

    if not email or not password:
        raise HTTPException(
            status_code=503,
            detail="SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set in environment variables."
        )

    db = get_firestore_client()

    # Check if already exists in Firestore by email
    existing_query = (
        db.collection("users")
        .where("email", "==", email)
        .where("role", "==", "admin")
        .limit(1)
        .get()
    )
    for _ in existing_query:
        return {"status": "already_exists", "message": "Super admin account already initialized."}

    # Try to create or fetch Firebase Auth user
    try:
        firebase_user = auth.create_user(email=email, password=password)
        uid = firebase_user.uid
        action = "created"
    except auth.EmailAlreadyExistsError:
        firebase_user = auth.get_user_by_email(email)
        uid = firebase_user.uid
        action = "linked_existing"

    # Set custom claim (server-side role)
    auth.set_custom_user_claims(uid, {"role": "admin"})

    # Upsert Firestore user document
    db.collection("users").document(uid).set({
        "uid": uid,
        "email": email,
        "fullname": "System Administrator",
        "role": "admin",
        "is_admin": True,
        "contacts": [],
        "created_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    return {
        "status": "success",
        "action": action,
        "uid": uid,
        "email": email,
        "message": "Super admin account initialized. Log in with these credentials."
    }


# ── Dashboard statistics ──────────────────────────────────────────────────────

@router.get("/stats")
async def admin_stats(user: dict = Depends(_require_admin)):
    """Return real counts from Firestore for the admin dashboard overview cards."""
    db = get_firestore_client()

    accidents_ref = db.collection("accidents")
    reports_ref   = db.collection("reports")

    # Count all accidents
    all_accidents = list(accidents_ref.stream())
    total_incidents    = len(all_accidents)
    total_accidents    = sum(1 for d in all_accidents if d.to_dict().get("accidentDetected"))
    total_no_accident  = total_incidents - total_accidents
    live_detections    = sum(1 for d in all_accidents if d.to_dict().get("source") in ("live_stream", "autonomous_dispatch"))
    video_uploads      = sum(1 for d in all_accidents if d.to_dict().get("source") not in ("live_stream", "autonomous_dispatch"))
    pending_review     = sum(1 for d in all_accidents if d.to_dict().get("status") == "pending_review")

    # Count reports
    all_reports  = list(reports_ref.stream())
    total_reports = len(all_reports)

    # Count authority notifications
    auth_notif_ref = db.collection("authority_notifications")
    try:
        total_authority_notifications = len(list(auth_notif_ref.stream()))
    except Exception:
        total_authority_notifications = 0

    # Count SOS dispatches
    try:
        total_sos = len(list(db.collection("sos_dispatches").stream()))
    except Exception:
        total_sos = 0

    return {
        "total_incidents": total_incidents,
        "total_accidents": total_accidents,
        "total_no_accident": total_no_accident,
        "live_detections": live_detections,
        "video_uploads": video_uploads,
        "pending_review": pending_review,
        "total_reports": total_reports,
        "total_sos_dispatches": total_sos,
        "total_authority_notifications": total_authority_notifications,
    }


# ── All incidents ─────────────────────────────────────────────────────────────

@router.get("/incidents")
async def admin_list_incidents(
    user: dict = Depends(_require_admin),
    limit: int = Query(100, le=200),
    offset: int = Query(0, ge=0),
    accident_only: Optional[bool] = Query(None),
    source: Optional[str] = Query(None),
):
    """List all incidents across all users with optional filters."""
    db = get_firestore_client()
    query = db.collection("accidents").order_by("created_at", direction=firestore.Query.DESCENDING)

    incidents = []
    for doc in query.limit(limit + offset).stream():
        data = doc.to_dict()
        data["id"] = doc.id
        # Convert Timestamps
        for k, v in data.items():
            if hasattr(v, "isoformat"):
                data[k] = v.isoformat()
            elif hasattr(v, "timestamp"):
                try:
                    data[k] = str(v)
                except Exception:
                    pass
        # Remove large base64 snapshots from list view
        data.pop("snapshot_base64", None)
        data.pop("snapshots", None)
        incidents.append(data)

    # Apply filters
    if accident_only is not None:
        incidents = [i for i in incidents if i.get("accidentDetected") == accident_only]
    if source:
        incidents = [i for i in incidents if i.get("source") == source]

    return {
        "incidents": incidents[offset:offset + limit],
        "total": len(incidents),
    }


@router.get("/incidents/{incident_id}")
async def admin_get_incident(incident_id: str, user: dict = Depends(_require_admin)):
    """Get full incident detail including timeline and associated reports."""
    db = get_firestore_client()
    doc = db.collection("accidents").document(incident_id).get()

    if not doc.exists:
        raise HTTPException(status_code=404, detail="Incident not found")

    data = doc.to_dict()
    data["id"] = doc.id

    # Serialize timestamps
    for k, v in data.items():
        if hasattr(v, "isoformat"):
            data[k] = v.isoformat()
        elif hasattr(v, "timestamp"):
            try:
                data[k] = str(v)
            except Exception:
                pass

    # Fetch associated reports
    reports_query = (
        db.collection("reports")
        .where("incident_id", "==", incident_id)
        .get()
    )
    reports = []
    for r in reports_query:
        rd = r.to_dict()
        rd.pop("storage_path", None)
        rd["download_url"] = (
            f"/api/reports/{rd['report_id']}/download"
            if rd.get("generation_status") == "success"
            else None
        )
        reports.append(rd)
    data["associated_reports"] = reports

    # Fetch authority notifications
    auth_notif_query = (
        db.collection("authority_notifications")
        .where("incident_id", "==", incident_id)
        .get()
    )
    auth_notifs = []
    for n in auth_notif_query:
        nd = n.to_dict()
        for k, v in nd.items():
            if hasattr(v, "isoformat"):
                nd[k] = v.isoformat()
            elif hasattr(v, "timestamp"):
                try:
                    nd[k] = str(v)
                except Exception:
                    pass
        auth_notifs.append(nd)
    data["authority_notifications"] = auth_notifs

    return data


class IncidentStatusUpdate(BaseModel):
    status: str  # new | under_review | assistance_requested | closed


@router.patch("/incidents/{incident_id}/status")
async def update_incident_status(
    incident_id: str,
    body: IncidentStatusUpdate,
    user: dict = Depends(_require_admin),
):
    """Update the review status of an incident. Creates an audit trail entry."""
    allowed = ("new", "under_review", "assistance_requested", "closed", "pending_review")
    if body.status not in allowed:
        raise HTTPException(status_code=400, detail=f"Invalid status. Allowed: {allowed}")

    db = get_firestore_client()
    doc = db.collection("accidents").document(incident_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Incident not found")

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    db.collection("accidents").document(incident_id).update({
        "status": body.status,
        "reviewed_by": user["uid"],
        "reviewed_at": now,
        "timeline": firestore.ArrayUnion([{
            "event": f"Status Updated to: {body.status.replace('_', ' ').title()}",
            "timestamp": now,
            "actor": user["uid"],
            "actor_role": user.get("role", "admin"),
            "status": body.status,
        }]),
    })

    return {"status": "updated", "incident_id": incident_id, "new_status": body.status}


# ── Authority Notification ────────────────────────────────────────────────────

class AuthorityNotifyRequest(BaseModel):
    confirm: bool = False  # caller must set True to proceed


@router.post("/incidents/{incident_id}/notify-authorities")
async def notify_authorities(
    incident_id: str,
    body: AuthorityNotifyRequest,
    user: dict = Depends(_require_admin),
):
    """
    Send an authority escalation email for a confirmed accident incident.
    Implements idempotency: duplicate sends within 10 minutes are rejected.
    Email is sent using the same SMTP configuration as the existing emergency email service.
    """
    if not body.confirm:
        raise HTTPException(
            status_code=400,
            detail="Confirmation required: set confirm=true to send authority notification."
        )

    db = get_firestore_client()
    doc = db.collection("accidents").document(incident_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Incident not found")

    incident = doc.to_dict()
    if not incident.get("accidentDetected", False):
        raise HTTPException(
            status_code=422,
            detail="Authority notification only available for confirmed accident incidents."
        )

    # Idempotency: prevent duplicate sends within 10 minutes
    now_ts = time.time()
    idempotency_window = 600  # 10 minutes
    existing_notif = (
        db.collection("authority_notifications")
        .where("incident_id", "==", incident_id)
        .where("status", "==", "sent")
        .limit(1)
        .get()
    )
    for notif in existing_notif:
        notif_data = notif.to_dict()
        sent_at = notif_data.get("sent_at_epoch", 0)
        if (now_ts - sent_at) < idempotency_window:
            return {
                "status": "duplicate_prevented",
                "message": "Authority notification already sent for this incident within the last 10 minutes.",
                "notification_id": notif.id,
                "time_since_last_send_seconds": int(now_ts - sent_at),
            }

    # Build notification email
    incident_id_display = incident.get("audit_id") or incident_id[:8].upper()
    timestamp      = incident.get("timestamp", "Unknown")
    location       = incident.get("location") or incident.get("geo_location", "Not available")
    severity       = incident.get("severity", "Unknown")
    confidence     = incident.get("max_confidence") or incident.get("confidence", "Unknown")
    maps_url       = incident.get("google_maps_url", "")
    llm_summary    = incident.get("llm_summary", "")[:500]
    now_str        = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    notif_id       = secrets.token_hex(6).upper()
    alert_email    = settings.ALERT_EMAIL

    subject = f"[URGENT 🚨 EMERGENCY DISPATCH] Road Accident Detected — Incident {incident_id_display} — SafeTrack AI"

    body_html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #dc2626; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 18px;">
          🚨 EMERGENCY ASSISTANCE REQUEST
        </h1>
        <p style="color: #fecaca; margin: 6px 0 0; font-size: 12px;">
          SafeTrack AI — Internal Test Notification
          (This email was sent to the configured test recipient, NOT to a police station or emergency service)
        </p>
      </div>
      <div style="background: #f8fafc; padding: 20px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
          <tr><td style="padding: 6px 8px; background: #f1f5f9; font-weight: bold; font-size: 12px; color: #64748b; width: 150px;">Incident Reference</td>
              <td style="padding: 6px 8px; font-size: 13px; font-family: monospace;">{incident_id_display}</td></tr>
          <tr><td style="padding: 6px 8px; background: #f1f5f9; font-weight: bold; font-size: 12px; color: #64748b;">Detection Timestamp</td>
              <td style="padding: 6px 8px; font-size: 13px;">{timestamp}</td></tr>
          <tr><td style="padding: 6px 8px; background: #f1f5f9; font-weight: bold; font-size: 12px; color: #64748b;">Location</td>
              <td style="padding: 6px 8px; font-size: 13px;">{location}</td></tr>
          <tr><td style="padding: 6px 8px; background: #f1f5f9; font-weight: bold; font-size: 12px; color: #64748b;">Severity</td>
              <td style="padding: 6px 8px; font-size: 13px; color: #dc2626; font-weight: bold;">{severity}</td></tr>
          <tr><td style="padding: 6px 8px; background: #f1f5f9; font-weight: bold; font-size: 12px; color: #64748b;">Detection Confidence</td>
              <td style="padding: 6px 8px; font-size: 13px;">{confidence}</td></tr>
          <tr><td style="padding: 6px 8px; background: #f1f5f9; font-weight: bold; font-size: 12px; color: #64748b;">Notification ID</td>
              <td style="padding: 6px 8px; font-size: 13px; font-family: monospace;">{notif_id}</td></tr>
          <tr><td style="padding: 6px 8px; background: #f1f5f9; font-weight: bold; font-size: 12px; color: #64748b;">Escalation Time</td>
              <td style="padding: 6px 8px; font-size: 13px;">{now_str}</td></tr>
          <tr><td style="padding: 6px 8px; background: #f1f5f9; font-weight: bold; font-size: 12px; color: #64748b;">Escalated By</td>
              <td style="padding: 6px 8px; font-size: 13px;">{user.get('email', user['uid'])}</td></tr>
        </table>
        {"<p style='font-size:13px;'><b>AI Summary:</b> " + llm_summary + "</p>" if llm_summary else ""}
        {"<p><a href='" + maps_url + "' style='background:#dc2626;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px;'>📍 View on Maps</a></p>" if maps_url else ""}
        <div style="margin-top: 20px; padding: 12px; background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 4px;">
          <p style="margin: 0; font-size: 12px; color: #92400e;">
            <strong>TEST NOTIFICATION DISCLAIMER:</strong>
            This email was sent to the configured SafeTrack AI test recipient ({alert_email}).
            It was NOT sent to a real police station, ambulance service, or government authority.
            This demonstrates the authority escalation workflow for the capstone project demonstration.
            In a production deployment, this notification would be routed to verified emergency contacts.
          </p>
        </div>
        <p style="font-size: 11px; color: #94a3b8; margin-top: 16px;">
          SafeTrack AI — AI-Based Accident Detection & Emergency Response System<br>
          Do not reply to this email.
        </p>
      </div>
    </div>
    """

    body_text = (
        f"EMERGENCY ASSISTANCE REQUEST — SafeTrack AI\n"
        f"Incident: {incident_id_display}\n"
        f"Timestamp: {timestamp}\n"
        f"Location: {location}\n"
        f"Severity: {severity}\n"
        f"Confidence: {confidence}\n"
        f"Maps: {maps_url}\n"
        f"Notification ID: {notif_id}\n"
        f"Escalation Time: {now_str}\n"
        f"Escalated By: {user.get('email', user['uid'])}\n\n"
        f"[TEST NOTIFICATION — sent to configured test email, not an actual authority]"
    )

    # Save notification record (pending)
    notif_doc = {
        "notification_id": notif_id,
        "incident_id": incident_id,
        "incident_ref": incident_id_display,
        "notification_type": "authority_escalation",
        "intended_recipient": alert_email,
        "actual_recipient": alert_email,
        "is_test": True,
        "status": "pending",
        "sent_at_epoch": now_ts,
        "initiated_by": user["uid"],
        "initiated_at": now_str,
        "idempotency_key": f"{incident_id}_{int(now_ts // idempotency_window)}",
        "created_at": firestore.SERVER_TIMESTAMP,
    }
    notif_ref = db.collection("authority_notifications").document(notif_id)
    notif_ref.set(notif_doc)

    # Send email
    email_sent = False
    email_error = None
    try:
        from app.services.email_service import _send_mail
        success = _send_mail(
            to=alert_email,
            subject=subject,
            html=body_html,
            text=body_text,
        )
        email_sent = success
        if not success:
            email_error = "Email service returned False — check SMTP configuration."
    except Exception as e:
        email_error = str(e)

    # Update notification record
    final_status = "sent" if email_sent else "failed"
    notif_ref.update({
        "status": final_status,
        "email_sent": email_sent,
        "email_error": email_error,
        "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })

    # Update incident timeline
    try:
        db.collection("accidents").document(incident_id).update({
            "status": "assistance_requested",
            "timeline": firestore.ArrayUnion([{
                "event": "Authority Notification Sent" if email_sent else "Authority Notification Failed",
                "timestamp": now_str,
                "actor": user["uid"],
                "status": final_status,
                "notification_id": notif_id,
                "recipient": alert_email,
                "is_test": True,
            }]),
        })
    except Exception:
        pass

    return {
        "status": final_status,
        "notification_id": notif_id,
        "incident_id": incident_id,
        "email_sent": email_sent,
        "recipient": alert_email,
        "is_test_notification": True,
        "message": (
            "Authority escalation email sent successfully (to configured test recipient)."
            if email_sent
            else f"Email failed: {email_error}"
        ),
        "disclaimer": (
            "This notification was sent to the configured test email address, "
            "not to a real emergency service. This is a demonstration of the "
            "authority escalation workflow."
        ),
    }


# ── Admin: all reports ─────────────────────────────────────────────────────────

@router.get("/all-reports")
async def admin_all_reports(user: dict = Depends(_require_admin)):
    """List all generated reports across all users."""
    db = get_firestore_client()
    reports = []
    for doc in db.collection("reports").order_by("generation_timestamp", direction=firestore.Query.DESCENDING).limit(200).stream():
        data = doc.to_dict()
        data.pop("storage_path", None)
        data["download_url"] = (
            f"/api/reports/{data['report_id']}/download"
            if data.get("generation_status") == "success"
            else None
        )
        reports.append(data)
    return {"reports": reports, "count": len(reports)}


# ── Analytics ─────────────────────────────────────────────────────────────────

@router.get("/analytics")
async def admin_analytics(
    user: dict = Depends(_require_admin),
    export_csv: bool = Query(False),
):
    """
    Aggregate incident analytics from real Firestore data.
    Returns counts by day, severity distribution, report stats.
    With ?export_csv=true returns a downloadable CSV.
    """
    from collections import defaultdict, Counter

    db = get_firestore_client()
    accidents = list(db.collection("accidents").stream())
    reports   = list(db.collection("reports").stream())

    by_day: dict[str, dict] = defaultdict(lambda: {"accidents": 0, "no_accident": 0, "total": 0})
    severity_dist: Counter = Counter()
    source_dist: Counter = Counter()
    uncertain_count = 0

    rows_for_csv = []

    for doc in accidents:
        data = doc.to_dict()
        # Get date from timestamp or created_at
        ts = data.get("timestamp") or data.get("created_at")
        day = "Unknown"
        if ts:
            try:
                if hasattr(ts, "strftime"):
                    day = ts.strftime("%Y-%m-%d")
                else:
                    from datetime import datetime
                    day = str(ts)[:10]
            except Exception:
                day = str(ts)[:10]

        detected = data.get("accidentDetected", False)
        severity = str(data.get("severity", "NONE")).upper()
        source   = data.get("source", "unknown")

        by_day[day]["total"] += 1
        if detected:
            by_day[day]["accidents"] += 1
            severity_dist[severity] += 1
        else:
            by_day[day]["no_accident"] += 1

        source_dist[source] += 1

        rows_for_csv.append({
            "incident_id": data.get("audit_id") or doc.id[:8],
            "timestamp": str(ts)[:19],
            "day": day,
            "accident_detected": detected,
            "severity": severity,
            "source": source,
            "location": data.get("location") or data.get("geo_location", ""),
            "status": data.get("status", ""),
        })

    report_stats = {"total": len(reports), "success": 0, "failed": 0, "pending": 0}
    for r in reports:
        rd = r.to_dict()
        st = rd.get("generation_status", "unknown")
        if st in report_stats:
            report_stats[st] += 1

    if export_csv:
        output = _io.StringIO()
        fieldnames = ["incident_id", "timestamp", "day", "accident_detected", "severity", "source", "location", "status"]
        writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows_for_csv)
        csv_content = output.getvalue().encode("utf-8")
        return StreamingResponse(
            iter([csv_content]),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=safetrackai_incidents.csv"}
        )

    # Format by_day into sorted list
    timeline = sorted(
        [{"date": d, **v} for d, v in by_day.items()],
        key=lambda x: x["date"]
    )

    return {
        "timeline": timeline,
        "severity_distribution": dict(severity_dist),
        "source_distribution": dict(source_dist),
        "report_statistics": report_stats,
        "totals": {
            "incidents": len(accidents),
            "accidents": sum(1 for d in accidents if d.to_dict().get("accidentDetected")),
            "no_accident": sum(1 for d in accidents if not d.to_dict().get("accidentDetected")),
        }
    }
