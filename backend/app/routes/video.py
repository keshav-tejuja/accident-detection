from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, HttpUrl
from app.services.firebase_service import get_current_user, get_firestore_client
from app.services.detection_service import process_video_detection
from app.services.email_service import send_emergency_alert, send_emergency_email
from firebase_admin import firestore
import uuid
import time

router = APIRouter()

class DetectRequest(BaseModel):
    video_url: HttpUrl

@router.post("/detect")
async def detect_accident_route(request: DetectRequest, user: dict = Depends(get_current_user)):
    if not request.video_url:
        raise HTTPException(status_code=400, detail="video_url is required")
        
    try:
        from app.services.gemini_service import generate_accident_report_json
        
        # 1. Processing the video through the YOLO wrapper
        detection_result = process_video_detection(str(request.video_url))
        
        # 2. Saving to Firestore
        db = get_firestore_client()
        accident_id = str(uuid.uuid4())
        
        accident_data = {
            "userId": user["uid"],
            "videoUrl": str(request.video_url),
            "location": "Unknown",
            "accidentDetected": detection_result.get("accident", False),
            "severity": detection_result.get("severity", "LOW"),
            "timestamp": firestore.SERVER_TIMESTAMP
        }
        db.collection("accidents").document(accident_id).set(accident_data)
        
        gemini_report = None
        email_dispatched = False
        if accident_data["accidentDetected"]:
            # Create a serializable version for Gemini
            serializable_data = accident_data.copy()
            serializable_data.pop("timestamp", None)
            gemini_report = generate_accident_report_json(serializable_data)
            
            user_doc = db.collection("users").document(user["uid"]).get()
            contacts = []
            if user_doc.exists:
                # Harmonize with frontend: both should use 'contacts'
                contacts = user_doc.to_dict().get("contacts", [])
            
            message = f"🚨 CRASH ALERT\nSeverity: {accident_data['severity']}\nUser: {user.get('email', 'unknown')}"
            send_emergency_alert(contacts, message)

            # ── Email dispatch (hardcoded) ────────────────────────────────
            ALERT_EMAIL = "keshavkt01@gmail.com"
            iso_timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            try:
                send_emergency_email(
                    ALERT_EMAIL,
                    message,
                    severity=accident_data["severity"],
                    audit_id=accident_id[:8].upper(),
                    timestamp=iso_timestamp,
                    coordinates="Video Upload — Location Unknown",
                    maps_url="",
                )
                email_dispatched = True
                print(f"✅ Video accident email sent to {ALERT_EMAIL}")
            except Exception as email_err:
                print(f"❌ Video email error: {email_err}")
            
        return {
            "accident": accident_data["accidentDetected"],
            "severity": accident_data["severity"],
            "report": gemini_report,
            "email_dispatched": email_dispatched,
            "message": "Detection processing completed successfully."
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

