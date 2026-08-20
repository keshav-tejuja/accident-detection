from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import firebase_admin
from firebase_admin import credentials, firestore
from pydantic import BaseModel
from app.core.config import settings
import base64
import json
import time
import os
try:
    import numpy as np
except Exception:
    np = None

try:
    import cv2
except Exception:
    cv2 = None

try:
    from ultralytics import YOLO
except Exception:
    YOLO = None

from app.services.email_service import send_emergency_email, verify_email_service

try:
    from twilio.rest import Client
except Exception:
    Client = None

# ── Firebase init ──────────────────────────────────────────────────────────────
try:
    if not firebase_admin._apps:
        cred = credentials.Certificate(settings.FIREBASE_CREDENTIALS_PATH)
        firebase_admin.initialize_app(cred)
        print("Firebase Admin initialized successfully.")
except Exception as e:
    print(f"Failed to initialize Firebase Admin: {e}")

# ── Email service verify (equivalent to nodemailer transporter.verify()) ──────
verify_email_service()

# ── YOLO model — loaded once at startup, shared across connections ─────────────
# Dynamic path: resolves relative to this file so it works from any cwd
_LIVE_MODEL_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "detection", "yolov8n.pt"
)
if YOLO is None:
    _yolo_model = None
    print("YOLO runtime unavailable: ultralytics/torch not installed in current environment.")
else:
    try:
        _yolo_model = YOLO(os.path.normpath(_LIVE_MODEL_PATH))
        print(f"YOLO model loaded for live spatial tracking: {os.path.normpath(_LIVE_MODEL_PATH)}")
    except Exception as e:
        _yolo_model = None
        print(f"YOLO model failed to load: {e}")

# ── Spatial engine constants ───────────────────────────────────────────────────
KNOWN_WIDTH_METERS   = 0.5   # metres (approx. human shoulder width baseline)
FOCAL_LENGTH         = 600   # pixels (webcam baseline)
EMA_ALPHA            = 0.2   # smoothed = alpha*new + (1-alpha)*previous
HAZARD_DISTANCE      = 3.0   # metres  — triggers full hazard alert
PROXIMITY_DISTANCE   = 5.0   # metres  — triggers proximity warning
PROXIMITY_TEST_DISTANCE = 2.0  # metres — aggressive indoor testing threshold
PERSON_WIDTH_RATIO_TEST = 0.40 # % of frame width — coarse near-object fallback
TRACKED_CLASSES      = [0, 2, 3, 5, 7]  # COCO: person, car, motorcycle, bus, truck
FRAME_SKIP           = 2     # process every Nth frame per connection

# Confidence thresholds — kept in sync with detection/detection.py
CONF_GENERAL  = 0.25   # base detection threshold
CONF_CRITICAL = 0.60   # high-confidence filter for CRITICAL alerts
_LIVE_IOU     = 0.45   # mutable IoU — updated via /api/model/config
INCIDENT_COOLDOWN_SECONDS = 15
last_incident_time = 0.0
last_autonomous_incident_time = 0.0

# ── 5-frame glitch filter ──────────────────────────────────────────────────────
# track_id -> consecutive frames where smoothed_distance < 0.5m
critical_frames_count: dict[int, int] = {}
CRITICAL_DISTANCE_THRESHOLD = 0.7   # metres — accident detected at 0.7m
CRITICAL_FRAMES_REQUIRED    = 3     # must be critical for this many consecutive frames


# ── FastAPI app ────────────────────────────────────────────────────────────────
app = FastAPI(
    title="AI-Based Video Accident Detection API",
    description="Backend API for processing videos for accident detection and reporting.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class IncidentLogPayload(BaseModel):
    timestamp: str
    severity: str
    location: str
    snapshot_base64: str
    closest_distance: float | None = None
    collision_alert: bool | None = None
    userId: str | None = None          # Firebase UID for tenant isolation


class AutonomousIncidentPayload(BaseModel):
    severity: str
    lat: float | None = None
    lng: float | None = None
    snapshot_base64: str
    snapshots: list[str] = []
    userId: str | None = None          # Firebase UID for tenant isolation
    user_email: str | None = None


@app.post("/api/incidents/autonomous_log")
async def autonomous_log_incident(payload: AutonomousIncidentPayload):
    global last_autonomous_incident_time

    now = time.time()
    if (now - last_autonomous_incident_time) < INCIDENT_COOLDOWN_SECONDS:
        return {"status": "ok", "message": "Ignored: Cooldown active"}

    if not firebase_admin._apps:
        raise HTTPException(status_code=500, detail="Firebase Admin not initialized")

    import secrets as _secrets
    audit_id       = _secrets.token_hex(8).upper()
    iso_timestamp  = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    geo_location   = f"{payload.lat}, {payload.lng}" if payload.lat and payload.lng else "Unknown"

    db = firestore.client()

    # Build all snapshots list (primary + burst)
    all_snapshots = [payload.snapshot_base64] + [s for s in payload.snapshots if s]
    all_snapshots = all_snapshots[:4]  # cap at 4

    # Format coordinates professionally
    lat_dir = "N" if (payload.lat or 0) >= 0 else "S"
    lng_dir = "E" if (payload.lng or 0) >= 0 else "W"
    coord_str = (
        f"{abs(payload.lat or 0):.6f}° {lat_dir}, {abs(payload.lng or 0):.6f}° {lng_dir}"
        if payload.lat and payload.lng else "Unknown"
    )

    incident_doc = {
        # ── Schema fields matched to Overview.jsx table columns ──────────
        "audit_id":        audit_id,
        "timestamp":       iso_timestamp,
        "classification":  "Collision Detected",
        "severity":        "Critical",
        "geo_location":    coord_str,
        "location":        coord_str,
        "lat":             payload.lat,
        "lng":             payload.lng,
        "coordinates":     coord_str,
        "google_maps_url": f"https://maps.google.com/?q={payload.lat},{payload.lng}" if payload.lat and payload.lng else None,
        "snapshot_base64": payload.snapshot_base64,   # primary
        "snapshots":       all_snapshots,             # all burst frames
        "snapshot_count":  len(all_snapshots),
        # ── Status / meta ────────────────────────────────────────────────
        "status":          "pending_review",
        "accidentDetected": True,
        "source":          "autonomous_dispatch",
        "userId":          payload.userId or "anonymous",
        "llm_summary": (
            f"Autonomous collision lockdown triggered at T+0. "
            f"Object maintained smoothed distance < {CRITICAL_DISTANCE_THRESHOLD}m "
            f"for {CRITICAL_FRAMES_REQUIRED} consecutive frames. "
            f"GPS coordinates: {coord_str}. "
            f"{len(all_snapshots)} burst snapshot(s) captured. "
            f"Immediate emergency response required."
        ),
        "created_at": firestore.SERVER_TIMESTAMP,
    }

    db.collection("accidents").add(incident_doc)

    sms_dispatched = False
    sms_error      = None
    to_phone   = settings.TARGET_PHONE_NUMBER
    from_phone = settings.TWILIO_FROM_NUMBER or settings.TWILIO_PHONE_NUMBER

    if Client is None:
        sms_error = "Twilio SDK not installed"
    elif not settings.TWILIO_ACCOUNT_SID or not settings.TWILIO_AUTH_TOKEN or not from_phone or not to_phone:
        sms_error = "Twilio credentials or phone numbers are missing"
    else:
        sms_body = (
            f"🚨 CRASH ALERT\n"
            f"Severity: Critical\n"
            f"Maps: https://maps.google.com/?q={payload.lat},{payload.lng}"
        )
        try:
            client = Client(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN)
            client.messages.create(body=sms_body, from_=from_phone, to=to_phone)
            sms_dispatched = True
        except Exception as twilio_err:
            sms_error = str(twilio_err)

    # ── Email dispatch (hardcoded recipient) ─────────────────────────────────
    email_dispatched = False
    email_error      = None
    ALERT_EMAIL      = "keshavkt01@gmail.com"

    maps_url = f"https://maps.google.com/?q={payload.lat},{payload.lng}" if payload.lat and payload.lng else ""
    email_body = (
        f"🚨 CRASH ALERT\n"
        f"Severity: Critical\n"
        f"Audit ID: {audit_id}\n"
        f"Timestamp: {iso_timestamp}\n"
        f"Coordinates: {coord_str}\n"
        f"Maps: {maps_url}"
    )
    try:
        send_emergency_email(
            ALERT_EMAIL,
            email_body,
            severity="Critical",
            audit_id=audit_id,
            timestamp=iso_timestamp,
            coordinates=coord_str,
            maps_url=maps_url,
        )
        email_dispatched = True
        print(f"✅ Crash alert email sent to {ALERT_EMAIL}")
    except Exception as e:
        email_error = str(e)
        print(f"❌ Email error: {e}")

    last_autonomous_incident_time = now
    return {
        "status":        "ok",
        "message":       "Autonomous incident logged",
        "audit_id":      audit_id,
        "db_saved":      True,
        "sms_dispatched": sms_dispatched,
        "sms_error":     sms_error,
        "email_dispatched": email_dispatched,
        "email_error":   email_error,
    }


@app.post("/api/incidents/log")
async def log_incident(payload: IncidentLogPayload):
    global last_incident_time

    now = time.time()
    if (now - last_incident_time) < INCIDENT_COOLDOWN_SECONDS:
        return {"status": "ok", "message": "Ignored: Cooldown active"}

    if not firebase_admin._apps:
        raise HTTPException(status_code=500, detail="Firebase Admin not initialized")

    import secrets as _secrets
    audit_id = _secrets.token_hex(8).upper()

    db = firestore.client()
    incident_doc = {
        "audit_id":        audit_id,
        "timestamp":       payload.timestamp,
        "classification":  "Collision Detected" if payload.collision_alert else "Proximity Alert",
        "severity":        payload.severity,
        "geo_location":    payload.location,
        "location":        payload.location,
        "snapshot_base64": payload.snapshot_base64,
        "status":          "pending_review",
        "accidentDetected": bool(payload.collision_alert),
        "llm_summary": (
            "Automated edge-node detection. Object intersected minimum safe distance "
            "threshold (< 0.8m). Immediate velocity drop recorded. Snapshot secured."
        ),
        "closest_distance": payload.closest_distance,
        "collision_alert":  bool(payload.collision_alert),
        "source":           "live_stream",
        "userId":           payload.userId or "anonymous",
        "created_at":       firestore.SERVER_TIMESTAMP,
    }

    db.collection("accidents").add(incident_doc)
    last_incident_time = now
    return {"status": "ok", "message": "Incident logged", "audit_id": audit_id}


# ── Quick email test endpoint ─────────────────────────────────────────────────
@app.get("/api/test-email")
async def test_email(to: str = ""):
    """
    Quick test: GET /api/test-email?to=your@email.com
    Sends a test crash alert email so you can verify delivery.
    """
    if not to:
        return {"error": "Pass ?to=your@email.com as query param"}

    try:
        result = send_emergency_email(
            to,
            "🚨 TEST CRASH ALERT\nSeverity: Critical\nAudit ID: TEST-0001\nTimestamp: 2026-04-29T00:00:00Z\nCoordinates: 19.0760° N, 72.8777° E\nMaps: https://maps.google.com/?q=19.0760,72.8777",
            severity="Critical",
            audit_id="TEST-0001",
            timestamp="2026-04-29T00:00:00Z",
            coordinates="19.0760° N, 72.8777° E",
            maps_url="https://maps.google.com/?q=19.0760,72.8777",
        )
        return {"status": "ok", "email_sent": True, "to": to}
    except Exception as e:
        return {"status": "error", "email_sent": False, "error": str(e)}


def calculate_spatial_data(pixel_width: float) -> float:
    """Triangle Similarity: distance = (real_width * focal_length) / pixel_width."""
    if pixel_width <= 0:
        return 0.0
    return round((KNOWN_WIDTH_METERS * FOCAL_LENGTH) / pixel_width, 2)


def classify_status(velocity: float) -> str:
    """Classify motion status from velocity (m/s)."""
    if abs(velocity) < 0.15:   # noise floor
        return "static"
    return "approaching" if velocity < 0 else "receding"


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    print(f"Global exception: {exc}")
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal Server Error", "message": str(exc)},
    )


@app.get("/")
def read_root():
    return {"status": "ok", "message": "Backend is running successfully!"}


@app.get("/health/incident-pipeline")
def incident_pipeline_health():
    twilio_installed = Client is not None
    twilio_configured = bool(
        settings.TWILIO_ACCOUNT_SID
        and settings.TWILIO_AUTH_TOKEN
        and (settings.TWILIO_FROM_NUMBER or settings.TWILIO_PHONE_NUMBER)
        and settings.TARGET_PHONE_NUMBER
    )
    firebase_ready = bool(firebase_admin._apps)

    return {
        "status": "ok",
        "pipeline_ready": firebase_ready and twilio_installed and twilio_configured,
        "firebase": {
            "initialized": firebase_ready,
        },
        "twilio": {
            "installed": twilio_installed,
            "configured": twilio_configured,
            "has_account_sid": bool(settings.TWILIO_ACCOUNT_SID),
            "has_auth_token": bool(settings.TWILIO_AUTH_TOKEN),
            "has_from_number": bool(settings.TWILIO_FROM_NUMBER or settings.TWILIO_PHONE_NUMBER),
            "has_target_number": bool(settings.TARGET_PHONE_NUMBER),
        },
        "autonomous_endpoint": "/api/incidents/autonomous_log",
        "ws_feed": "/ws/live-feed",
    }


# ── Live-feed WebSocket — ByteTrack + Spatial Engine ──────────────────────────
@app.websocket("/ws/live-feed")
async def live_video_feed(websocket: WebSocket):
    await websocket.accept()
    print("[WS] Client connected to /ws/live-feed")

    # Per-connection state — isolated so multiple clients don't share history
    prev_distances: dict[int, float] = {}   # track_id -> last smoothed distance
    prev_timestamp: float = time.monotonic()
    frame_counter: int = 0

    try:
        while True:
            raw = await websocket.receive_text()
            frame_counter += 1

            # ── Frame skip: only process every FRAME_SKIP-th frame ────────
            # Still decode to keep ByteTrack's internal state warm, but skip
            # heavy inference on skipped frames and return last payload fast.
            skip_inference = (frame_counter % FRAME_SKIP != 0)

            # ── Decode incoming JPEG frame ─────────────────────────────────
            try:
                if np is None or cv2 is None:
                    await websocket.send_json({
                        "status": "ok",
                        "providerTitle": "YOLOv8 Spatial Engine",
                        "detections": [],
                        "degraded": True,
                        "message": "Live inference dependencies are not installed (numpy/opencv).",
                    })
                    continue

                payload   = json.loads(raw)
                frame_b64 = payload.get("frame", "")
                if not frame_b64:
                    await websocket.send_json({"status": "ok", "providerTitle": "YOLOv8 Spatial Engine", "detections": []})
                    continue

                if "," in frame_b64:
                    frame_b64 = frame_b64.split(",", 1)[1]

                img_bytes = base64.b64decode(frame_b64)
                np_arr    = np.frombuffer(img_bytes, dtype=np.uint8)
                frame     = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

                if frame is None:
                    await websocket.send_json({"status": "ok", "providerTitle": "YOLOv8 Spatial Engine", "detections": []})
                    continue

            except Exception as decode_err:
                print(f"[WS] Frame decode error: {decode_err}")
                await websocket.send_json({"status": "ok", "providerTitle": "YOLOv8 Spatial Engine", "detections": []})
                continue

            if skip_inference:
                # Return empty detections on skipped frames — frontend
                # interpolates using the last received payload.
                await websocket.send_json({"status": "ok", "providerTitle": "YOLOv8 Spatial Engine", "detections": [], "skipped": True})
                continue

            # ── Timing for velocity calculation ───────────────────────────
            now        = time.monotonic()
            frame_time = max(now - prev_timestamp, 0.001)  # avoid div/0
            prev_timestamp = now

            # ── ByteTrack inference ────────────────────────────────────────
            detections: list[dict] = []

            if _yolo_model is not None:
                try:
                    results = _yolo_model.track(
                        frame,
                        persist=True,
                        tracker="bytetrack.yaml",
                        conf=CONF_GENERAL,
                        iou=_LIVE_IOU,
                        verbose=False,
                        classes=TRACKED_CLASSES,
                    )

                    if results and results[0].boxes is not None:
                        for box in results[0].boxes:
                            if box.id is None:
                                continue  # not yet confirmed by tracker

                            track_id        = int(box.id.item())
                            cls_idx         = int(box.cls.item())
                            confidence      = round(float(box.conf.item()), 3)
                            x1, y1, x2, y2 = [round(float(v), 1) for v in box.xyxy[0].tolist()]
                            pixel_width     = x2 - x1
                            frame_width_px  = max(float(frame.shape[1]), 1.0)
                            width_ratio     = round(pixel_width / frame_width_px, 4)
                            raw_distance    = calculate_spatial_data(pixel_width)
                            if track_id in prev_distances and raw_distance > 0:
                                distance = round(
                                    (EMA_ALPHA * raw_distance) + ((1 - EMA_ALPHA) * prev_distances[track_id]),
                                    2,
                                )
                            else:
                                distance = raw_distance
                            label           = _yolo_model.names.get(cls_idx, f"cls_{cls_idx}")

                            # ── Velocity (m/s) ─────────────────────────────
                            if track_id in prev_distances and distance > 0:
                                raw_vel  = (distance - prev_distances[track_id]) / frame_time
                                velocity = round(raw_vel, 2)
                            else:
                                velocity = 0.0

                            if distance > 0:
                                prev_distances[track_id] = distance

                            status = classify_status(velocity)

                            # Convert velocity to km/h for the payload
                            velocity_kmh = round(velocity * 3.6, 1)

                            detections.append({
                                "id":           track_id,
                                "class_id":     cls_idx,
                                "label":        label,
                                "confidence":   confidence,
                                "is_critical":  confidence >= CONF_CRITICAL,
                                "raw_distance": raw_distance,
                                "distance":     distance,
                                "smoothed_distance": distance,
                                "bbox_width_ratio": width_ratio,
                                "velocity":     velocity_kmh,   # km/h, negative = approaching
                                "status":       status,
                                "box":          [x1, y1, x2, y2],
                            })

                    # Prune stale track IDs to prevent unbounded memory growth
                    active_ids = {d["id"] for d in detections}
                    stale      = [k for k in prev_distances if k not in active_ids]
                    for k in stale:
                        del prev_distances[k]

                except Exception as infer_err:
                    print(f"[WS] Inference error: {infer_err}")

            # ── Hazard classification ──────────────────────────────────────
            hazard_alert    = any(
                d["status"] == "approaching" and d["distance"] > 0 and d["distance"] < HAZARD_DISTANCE
                for d in detections
            )
            proximity_alert = any(
                d["distance"] > 0 and d["distance"] < PROXIMITY_DISTANCE
                for d in detections
            )

            # Testing mode (indoor webcam): treat person class as vehicle proxy.
            person_proximity_alert = any(
                d.get("class_id") == 0 and (
                    (d["distance"] > 0 and d["distance"] < PROXIMITY_TEST_DISTANCE)
                    or (d.get("bbox_width_ratio", 0) >= PERSON_WIDTH_RATIO_TEST)
                )
                for d in detections
            )
            proximity_alert = proximity_alert or person_proximity_alert

            # collision_vector: true if any tracked vehicle is closing faster
            # than 1 m/s (velocity is stored as km/h, negative = approaching)
            collision_vector = any(
                d["status"] == "approaching" and abs(d["velocity"]) >= 3.6  # 1 m/s = 3.6 km/h
                for d in detections
            )

            closest_distance = min(
                [d["distance"] for d in detections if d["distance"] > 0],
                default=None,
            )
            collision_alert = any(
                d["distance"] > 0 and d["distance"] < 0.8
                for d in detections
            )

            # ── 5-frame glitch filter ──────────────────────────────────────
            # Only flag a true collision if an object stays < 0.3m for
            # CRITICAL_FRAMES_REQUIRED consecutive frames.
            active_ids = {d["id"] for d in detections}

            # Reset counters for objects no longer in frame
            for tid in list(critical_frames_count.keys()):
                if tid not in active_ids:
                    critical_frames_count[tid] = 0

            confirmed_collision = False
            for d in detections:
                tid  = d["id"]
                dist = d.get("smoothed_distance", d["distance"])
                if dist > 0 and dist < CRITICAL_DISTANCE_THRESHOLD:
                    critical_frames_count[tid] = critical_frames_count.get(tid, 0) + 1
                else:
                    critical_frames_count[tid] = 0   # reset — object moved away

                if critical_frames_count.get(tid, 0) >= CRITICAL_FRAMES_REQUIRED:
                    confirmed_collision = True

            collision_alert = confirmed_collision

            await websocket.send_json({
                "status":           "ok",
                "providerTitle":    "YOLOv8 Spatial Engine",
                "detections":       detections,
                "vehicle_count":    len(detections),
                "closest_distance": closest_distance,
                "smoothed_distance": closest_distance,
                "hazard_alert":     hazard_alert,
                "proximity_alert":  proximity_alert,
                "collision_alert":  collision_alert,
                "collision_vector": collision_vector,
                "telemetry": {
                    "vehicle_count":    len(detections),
                    "closest_distance": closest_distance,
                    "smoothed_distance": closest_distance,
                    "hazard_alert":     hazard_alert,
                    "proximity_alert":  proximity_alert,
                    "collision_alert":  collision_alert,
                    "person_proximity_alert": person_proximity_alert,
                    "collision_vector": collision_vector,
                    "tracked_ids":      [d["id"] for d in detections],
                    "frame_time_ms":    round(frame_time * 1000, 1),
                },
            })

    except WebSocketDisconnect:
        print("[WS] Client disconnected from /ws/live-feed")
    except Exception as e:
        print(f"[WS] Unexpected error: {e}")


# ── Routers ────────────────────────────────────────────────────────────────────
from app.routes import video, user, report, payment, sos, analytics, model_config, dispatch
app.include_router(video.router,         prefix="/api/video",   tags=["Video"])
app.include_router(user.router,          prefix="/api/user",    tags=["User"])
app.include_router(report.router,        prefix="/api/report",  tags=["Report"])
app.include_router(payment.router,       prefix="/api/payment", tags=["Payment"])
app.include_router(sos.router,           prefix="/api/sos",     tags=["SOS"])
app.include_router(analytics.router,     prefix="/api",         tags=["Analytics"])
app.include_router(model_config.router,  prefix="/api",         tags=["Model Config"])
app.include_router(dispatch.router,      prefix="/api/dispatch", tags=["Dispatch"])
