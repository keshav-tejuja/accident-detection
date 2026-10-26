"""
Report Routes — Full PDF Report Generation API
===============================================
Endpoints:
    POST /api/reports/health-insurance/{incident_id}
    POST /api/reports/motor-insurance/{incident_id}
    GET  /api/reports/{report_id}/download
    GET  /api/reports
    GET  /api/reports/admin/all   (super admin only)

Legacy:
    POST /api/report/generate-report  (kept for backwards compatibility)
"""

import os
import secrets
import time
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from firebase_admin import firestore

from app.services.firebase_service import get_current_user, get_firestore_client
from app.services.gemini_service import generate_accident_report_json

router = APIRouter()

# Directory where generated PDFs are stored on disk
_REPORTS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "generated_reports")
os.makedirs(_REPORTS_DIR, exist_ok=True)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _serialize_doc(doc_data: dict) -> dict:
    """Convert Firestore Timestamps to ISO strings so they're JSON-safe."""
    out = {}
    for k, v in doc_data.items():
        if hasattr(v, "isoformat"):
            out[k] = v.isoformat()
        elif hasattr(v, "timestamp"):
            # google.cloud.firestore_v1.base_document.DocumentSnapshot Timestamp
            try:
                out[k] = v.strftime("%Y-%m-%dT%H:%M:%SZ")
            except Exception:
                try:
                    from datetime import timezone
                    out[k] = v.ToDatetime().replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                except Exception:
                    out[k] = str(v)
        else:
            out[k] = v
    return out


def _get_accident(db, incident_id: str) -> dict:
    """Fetch accident by document ID, trying 'accidents' collection."""
    doc = db.collection("accidents").document(incident_id).get()
    if doc.exists:
        data = _serialize_doc(doc.to_dict())
        data["id"] = doc.id
        return data

    # Try to find by audit_id field (for legacy records)
    query = (
        db.collection("accidents")
        .where("audit_id", "==", incident_id)
        .limit(1)
        .get()
    )
    for q in query:
        data = _serialize_doc(q.to_dict())
        data["id"] = q.id
        return data

    return None


def _generate_report_id(report_type_prefix: str) -> str:
    hex_part = secrets.token_hex(5).upper()
    return f"{report_type_prefix}-{time.strftime('%Y%m%d')}-{hex_part}"


def _safe_filename(incident_id: str, report_type: str) -> str:
    safe_id = incident_id.replace("/", "_").replace("\\", "_")[:20]
    type_tag = "HEALTH" if "health" in report_type.lower() else "MOTOR"
    return f"{safe_id}_{type_tag}_REPORT.pdf"


# ── Legacy route kept for backwards compat ────────────────────────────────────

class ReportRequest(BaseModel):
    accident_id: str

@router.post("/generate-report")
async def generate_report(request: ReportRequest, user: dict = Depends(get_current_user)):
    db = get_firestore_client()
    doc = db.collection("accidents").document(request.accident_id).get()

    if not doc.exists:
        raise HTTPException(status_code=404, detail="Accident record not found")

    accident_data = doc.to_dict()

    if user["role"] not in ("authority", "admin", "super_admin") and accident_data.get("userId") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not authorized to view this record")

    report = generate_accident_report_json(accident_data)
    return report


# ── PDF Report Generation ─────────────────────────────────────────────────────

@router.post("/health-insurance/{incident_id}")
async def generate_health_insurance_report(
    incident_id: str,
    user: dict = Depends(get_current_user)
):
    """
    Generate and store a professional Health Insurance Accident Incident Report PDF.
    Returns report metadata + report_id for download.
    """
    db = get_firestore_client()
    accident_data = _get_accident(db, incident_id)

    if not accident_data:
        raise HTTPException(status_code=404, detail=f"Incident '{incident_id}' not found")

    # Access control: owner or admin
    if user["role"] not in ("authority", "admin", "super_admin") and accident_data.get("userId") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not authorized to generate report for this incident")

    if not accident_data.get("accidentDetected", False):
        raise HTTPException(
            status_code=422,
            detail="Cannot generate an accident report: no accident was detected for this incident."
        )

    # Idempotency: check for existing successful report
    existing = (
        db.collection("reports")
        .where("incident_id", "==", incident_id)
        .where("report_type", "==", "health_insurance")
        .where("generation_status", "==", "success")
        .where("owner_uid", "==", user["uid"])
        .limit(1)
        .get()
    )
    for ex in existing:
        ex_data = ex.to_dict()
        return {
            "status": "already_exists",
            "report_id": ex_data["report_id"],
            "incident_id": incident_id,
            "report_type": "health_insurance",
            "message": "Report already generated. Use the download endpoint.",
            "download_url": f"/api/reports/{ex_data['report_id']}/download",
        }

    report_id = _generate_report_id("HLTH")
    generation_timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # Save a pending record first
    report_meta = {
        "report_id": report_id,
        "incident_id": incident_id,
        "report_type": "health_insurance",
        "owner_uid": user["uid"],
        "generation_status": "pending",
        "generation_timestamp": generation_timestamp,
        "storage_path": None,
        "error": None,
        "created_at": firestore.SERVER_TIMESTAMP,
    }
    db.collection("reports").document(report_id).set(report_meta)

    # Add audit event to incident
    try:
        db.collection("accidents").document(accident_data["id"]).update({
            "timeline": firestore.ArrayUnion([{
                "event": "Health Insurance Report Generation Requested",
                "timestamp": generation_timestamp,
                "actor": user["uid"],
                "status": "pending",
            }])
        })
    except Exception:
        pass  # Non-critical

    try:
        # Step 1: Generate content with Groq
        from app.services.groq_service import generate_health_insurance_content
        content = generate_health_insurance_content(accident_data, report_id)

        # Step 2: Render PDF
        from app.services.pdf_service import generate_health_insurance_pdf, count_pdf_pages
        pdf_bytes = generate_health_insurance_pdf(content, report_id)

        # Step 3: Verify minimum 2 pages
        page_count = count_pdf_pages(pdf_bytes)
        if page_count < 2:
            raise RuntimeError(f"Generated PDF has only {page_count} page(s). Minimum 2 required.")

        # Step 4: Save to disk
        filename = _safe_filename(incident_id, "health_insurance")
        pdf_path = os.path.join(_REPORTS_DIR, f"{report_id}_{filename}")
        with open(pdf_path, "wb") as f:
            f.write(pdf_bytes)

        # Step 5: Update Firestore metadata
        db.collection("reports").document(report_id).update({
            "generation_status": "success",
            "storage_path": pdf_path,
            "filename": f"{report_id}_{filename}",
            "page_count": page_count,
            "file_size_bytes": len(pdf_bytes),
        })

        # Update incident timeline
        try:
            db.collection("accidents").document(accident_data["id"]).update({
                "timeline": firestore.ArrayUnion([{
                    "event": "Health Insurance Report Generated",
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "actor": user["uid"],
                    "status": "success",
                    "report_id": report_id,
                }])
            })
        except Exception:
            pass

        return {
            "status": "success",
            "report_id": report_id,
            "incident_id": incident_id,
            "report_type": "health_insurance",
            "page_count": page_count,
            "file_size_bytes": len(pdf_bytes),
            "download_url": f"/api/reports/{report_id}/download",
            "filename": f"{report_id}_{filename}",
        }

    except Exception as e:
        error_msg = str(e)
        # Update report status to failed
        db.collection("reports").document(report_id).update({
            "generation_status": "failed",
            "error": error_msg[:500],
        })
        # Update timeline
        try:
            db.collection("accidents").document(accident_data["id"]).update({
                "timeline": firestore.ArrayUnion([{
                    "event": "Health Insurance Report Generation Failed",
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "actor": user["uid"],
                    "status": "failed",
                    "error": error_msg[:200],
                }])
            })
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"Report generation failed: {error_msg}")


@router.post("/motor-insurance/{incident_id}")
async def generate_motor_insurance_report(
    incident_id: str,
    user: dict = Depends(get_current_user)
):
    """
    Generate and store a professional Motor Vehicle Accident Insurance Claim Report PDF.
    """
    db = get_firestore_client()
    accident_data = _get_accident(db, incident_id)

    if not accident_data:
        raise HTTPException(status_code=404, detail=f"Incident '{incident_id}' not found")

    if user["role"] not in ("authority", "admin", "super_admin") and accident_data.get("userId") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not authorized to generate report for this incident")

    if not accident_data.get("accidentDetected", False):
        raise HTTPException(
            status_code=422,
            detail="Cannot generate an accident report: no accident was detected for this incident."
        )

    # Idempotency check
    existing = (
        db.collection("reports")
        .where("incident_id", "==", incident_id)
        .where("report_type", "==", "motor_insurance")
        .where("generation_status", "==", "success")
        .where("owner_uid", "==", user["uid"])
        .limit(1)
        .get()
    )
    for ex in existing:
        ex_data = ex.to_dict()
        return {
            "status": "already_exists",
            "report_id": ex_data["report_id"],
            "incident_id": incident_id,
            "report_type": "motor_insurance",
            "message": "Report already generated. Use the download endpoint.",
            "download_url": f"/api/reports/{ex_data['report_id']}/download",
        }

    report_id = _generate_report_id("MOTR")
    generation_timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    report_meta = {
        "report_id": report_id,
        "incident_id": incident_id,
        "report_type": "motor_insurance",
        "owner_uid": user["uid"],
        "generation_status": "pending",
        "generation_timestamp": generation_timestamp,
        "storage_path": None,
        "error": None,
        "created_at": firestore.SERVER_TIMESTAMP,
    }
    db.collection("reports").document(report_id).set(report_meta)

    try:
        db.collection("accidents").document(accident_data["id"]).update({
            "timeline": firestore.ArrayUnion([{
                "event": "Motor Insurance Report Generation Requested",
                "timestamp": generation_timestamp,
                "actor": user["uid"],
                "status": "pending",
            }])
        })
    except Exception:
        pass

    try:
        from app.services.groq_service import generate_motor_insurance_content
        content = generate_motor_insurance_content(accident_data, report_id)

        from app.services.pdf_service import generate_motor_insurance_pdf, count_pdf_pages
        pdf_bytes = generate_motor_insurance_pdf(content, report_id)

        page_count = count_pdf_pages(pdf_bytes)
        if page_count < 2:
            raise RuntimeError(f"Generated PDF has only {page_count} page(s). Minimum 2 required.")

        filename = _safe_filename(incident_id, "motor_insurance")
        pdf_path = os.path.join(_REPORTS_DIR, f"{report_id}_{filename}")
        with open(pdf_path, "wb") as f:
            f.write(pdf_bytes)

        db.collection("reports").document(report_id).update({
            "generation_status": "success",
            "storage_path": pdf_path,
            "filename": f"{report_id}_{filename}",
            "page_count": page_count,
            "file_size_bytes": len(pdf_bytes),
        })

        try:
            db.collection("accidents").document(accident_data["id"]).update({
                "timeline": firestore.ArrayUnion([{
                    "event": "Motor Insurance Report Generated",
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "actor": user["uid"],
                    "status": "success",
                    "report_id": report_id,
                }])
            })
        except Exception:
            pass

        return {
            "status": "success",
            "report_id": report_id,
            "incident_id": incident_id,
            "report_type": "motor_insurance",
            "page_count": page_count,
            "file_size_bytes": len(pdf_bytes),
            "download_url": f"/api/reports/{report_id}/download",
            "filename": f"{report_id}_{filename}",
        }

    except Exception as e:
        error_msg = str(e)
        db.collection("reports").document(report_id).update({
            "generation_status": "failed",
            "error": error_msg[:500],
        })
        try:
            db.collection("accidents").document(accident_data["id"]).update({
                "timeline": firestore.ArrayUnion([{
                    "event": "Motor Insurance Report Generation Failed",
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "actor": user["uid"],
                    "status": "failed",
                    "error": error_msg[:200],
                }])
            })
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"Report generation failed: {error_msg}")


# ── Download ──────────────────────────────────────────────────────────────────

@router.get("/{report_id}/download")
async def download_report(report_id: str, user: dict = Depends(get_current_user)):
    """Download a generated PDF by report_id. Access-controlled."""
    db = get_firestore_client()
    doc = db.collection("reports").document(report_id).get()

    if not doc.exists:
        raise HTTPException(status_code=404, detail="Report not found")

    report = doc.to_dict()

    # Access control: owner or admin
    if user["role"] not in ("authority", "admin", "super_admin") and report.get("owner_uid") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not authorized to download this report")

    if report.get("generation_status") != "success":
        raise HTTPException(
            status_code=409,
            detail=f"Report is not ready. Status: {report.get('generation_status', 'unknown')}"
        )

    storage_path = report.get("storage_path")
    if not storage_path or not os.path.exists(storage_path):
        raise HTTPException(status_code=404, detail="Report file not found on disk")

    with open(storage_path, "rb") as f:
        pdf_bytes = f.read()

    filename = report.get("filename", f"{report_id}.pdf")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(pdf_bytes)),
        }
    )


# ── List user's reports ───────────────────────────────────────────────────────

@router.get("")
async def list_reports(user: dict = Depends(get_current_user)):
    """List all reports for the current user."""
    db = get_firestore_client()
    query = (
        db.collection("reports")
        .where("owner_uid", "==", user["uid"])
        .order_by("generation_timestamp", direction=firestore.Query.DESCENDING)
        .limit(50)
    )
    reports = []
    for doc in query.stream():
        data = doc.to_dict()
        # Don't expose storage_path to client
        data.pop("storage_path", None)
        data["download_url"] = (
            f"/api/reports/{data['report_id']}/download"
            if data.get("generation_status") == "success"
            else None
        )
        reports.append(data)
    return {"reports": reports, "count": len(reports)}


# ── Admin: list all reports ───────────────────────────────────────────────────

@router.get("/admin/all")
async def admin_list_all_reports(user: dict = Depends(get_current_user)):
    """Super admin: list all reports across all users."""
    if user["role"] not in ("authority", "admin", "super_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")

    db = get_firestore_client()
    query = (
        db.collection("reports")
        .order_by("generation_timestamp", direction=firestore.Query.DESCENDING)
        .limit(200)
    )
    reports = []
    for doc in query.stream():
        data = doc.to_dict()
        data.pop("storage_path", None)
        data["download_url"] = (
            f"/api/reports/{data['report_id']}/download"
            if data.get("generation_status") == "success"
            else None
        )
        reports.append(data)
    return {"reports": reports, "count": len(reports)}
