import React, { useState, useEffect, useRef, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, Zap, Radio, Scan, Eye, EyeOff, AlertTriangle } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/services/firebase";

// ─── Constants ────────────────────────────────────────────────────────────────
const FRAME_W = 640;
const FRAME_H = 360;

// Distance thresholds (metres)
const DIST_SAFE     = 10.0;
const DIST_MID      = 5.0;
const DIST_HAZARD   = 3.0;
const DIST_CRITICAL = 1.0;

// Colour palette — matches Tailwind blue-400 / orange-400 / red-500
const C_SAFE   = "#60a5fa";
const C_MID    = "#fb923c";
const C_HAZARD = "#ef4444";

// Corner bracket geometry
const BRACKET_ARM = 16;   // px length of each L-arm
const BRACKET_W_SAFE   = 1.8;
const BRACKET_W_MID    = 2.2;
const BRACKET_W_HAZARD = 3.0;

function getColor(dist) {
  if (dist > 0 && dist < DIST_MID)  return C_HAZARD;
  if (dist > 0 && dist < DIST_SAFE) return C_MID;
  return C_SAFE;
}

function getLineWidth(dist) {
  if (dist > 0 && dist < DIST_MID)  return BRACKET_W_HAZARD;
  if (dist > 0 && dist < DIST_SAFE) return BRACKET_W_MID;
  return BRACKET_W_SAFE;
}

// ─── Canvas helpers ───────────────────────────────────────────────────────────

/** Four L-shaped corner brackets — no full rectangle */
function drawBrackets(ctx, x, y, w, h, color, lw) {
  const L = Math.min(BRACKET_ARM, w * 0.28, h * 0.28);
  ctx.strokeStyle = color;
  ctx.lineWidth   = lw;
  ctx.lineCap     = "round";
  ctx.shadowColor = color;
  ctx.shadowBlur  = lw > 2 ? 14 : 7;

  const pts = [
    // top-left
    [[x + L, y], [x, y], [x, y + L]],
    // top-right
    [[x + w - L, y], [x + w, y], [x + w, y + L]],
    // bottom-left
    [[x + L, y + h], [x, y + h], [x, y + h - L]],
    // bottom-right
    [[x + w - L, y + h], [x + w, y + h], [x + w, y + h - L]],
  ];

  for (const [a, b, c] of pts) {
    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.lineTo(...c);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

/** Proximity fill tint inside the bracket area */
function drawTint(ctx, x, y, w, h, color) {
  const hex = color.replace(
    /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i,
    (_, r, g, b) => `rgba(${parseInt(r,16)},${parseInt(g,16)},${parseInt(b,16)},0.15)`
  );
  ctx.fillStyle = hex;
  ctx.fillRect(x, y, w, h);
}

/** Dotted spatial-connection line from screen bottom-centre to vehicle bottom-centre */
function drawSpatialLine(ctx, vehBotX, vehBotY, canvasH, color, lw) {
  ctx.save();
  ctx.setLineDash([4, 6]);
  ctx.strokeStyle = color;
  ctx.lineWidth   = Math.max(lw - 0.8, 0.8);
  ctx.globalAlpha = 0.45;
  ctx.shadowColor = color;
  ctx.shadowBlur  = 6;
  ctx.beginPath();
  ctx.moveTo(vehBotX, vehBotY);
  ctx.lineTo(vehBotX, canvasH);
  ctx.stroke();
  ctx.restore();
}

/** Glassmorphism telemetry badge above the bracket */
function drawGlassBadge(ctx, x, y, det, color) {
  const statusStr =
    det.status === "approaching" ? "APPROACHING" :
    det.status === "receding"    ? "RECEDING"    : "STATIC";
  const velAbs = det.velocity !== undefined ? Math.abs(det.velocity) : 0;
  const label  = `ID: ${det.id} | ${det.distance > 0 ? det.distance + "m" : "—"} | ${velAbs}km/h`;
  const sub    = statusStr;

  const fontSize    = 10.5;
  const subFontSize = 9;
  ctx.font = `bold ${fontSize}px "JetBrains Mono","Fira Mono",monospace`;
  const mainW = ctx.measureText(label).width;
  ctx.font = `bold ${subFontSize}px "JetBrains Mono","Fira Mono",monospace`;
  const subW  = ctx.measureText(sub).width;
  const bw    = Math.max(mainW, subW) + 18;
  const bh    = fontSize + subFontSize + 14;
  const bx    = Math.max(x, 2);
  const by    = Math.max(y - bh - 6, 2);

  // Glass background
  ctx.save();
  ctx.globalAlpha = 0.82;
  ctx.fillStyle   = "rgba(15,23,42,0.72)";
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 5);
  else ctx.rect(bx, by, bw, bh);
  ctx.fill();
  ctx.restore();

  // Glass border
  ctx.strokeStyle = color;
  ctx.lineWidth   = 0.8;
  ctx.globalAlpha = 0.7;
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 5);
  else ctx.rect(bx, by, bw, bh);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Main label
  ctx.font      = `bold ${fontSize}px "JetBrains Mono","Fira Mono",monospace`;
  ctx.fillStyle = "#e2e8f0";
  ctx.fillText(label, bx + 9, by + fontSize + 4);

  // Status sub-label
  ctx.font      = `bold ${subFontSize}px "JetBrains Mono","Fira Mono",monospace`;
  ctx.fillStyle = color;
  ctx.fillText(sub, bx + 9, by + fontSize + subFontSize + 8);
}

// ─── ADAS drivable-area trapezoid ────────────────────────────────────────────
function drawADASPath(ctx, cw, ch, proximityAlert, flashOn) {
  // Vanishing point: centre-top of bottom half
  const vpX  = cw * 0.5;
  const vpY  = ch * 0.42;          // horizon line
  const inset = cw * 0.08;         // how far in from corners at the bottom

  // Four trapezoid corners
  const bl = { x: inset,        y: ch };       // bottom-left
  const br = { x: cw - inset,   y: ch };       // bottom-right
  const tl = { x: vpX - cw * 0.07, y: vpY };  // top-left  (narrow)
  const tr = { x: vpX + cw * 0.07, y: vpY };  // top-right (narrow)

  // 1. Transparent blue fill
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(bl.x, bl.y);
  ctx.lineTo(tl.x, tl.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y);
  ctx.closePath();
  if (proximityAlert) {
    ctx.fillStyle = flashOn ? "rgba(239,68,68,0.26)" : "rgba(239,68,68,0.16)";
  } else {
    ctx.fillStyle = "rgba(59,130,246,0.15)";
  }
  ctx.fill();

  // 2. Dashed orange lane borders (left + right angled lines)
  ctx.setLineDash([15, 15]);
  ctx.lineWidth   = 4;
  ctx.strokeStyle = proximityAlert ? (flashOn ? "#ef4444" : "#f87171") : "#f97316";
  ctx.lineCap     = "round";
  ctx.shadowColor = proximityAlert ? "#ef4444" : "#f97316";
  ctx.shadowBlur  = 8;

  ctx.beginPath();
  ctx.moveTo(bl.x, bl.y);
  ctx.lineTo(tl.x, tl.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(br.x, br.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.stroke();

  // 3. Solid red bumper line at the very bottom
  ctx.setLineDash([]);
  ctx.lineWidth   = 3;
  ctx.strokeStyle = "#ef4444";
  ctx.shadowColor = "#ef4444";
  ctx.shadowBlur  = 10;
  ctx.beginPath();
  ctx.moveTo(bl.x, ch - 1);
  ctx.lineTo(br.x, ch - 1);
  ctx.stroke();

  ctx.restore();
}

// ─── Distance threshold boundary lines ───────────────────────────────────────
const WARN_DIST    = 1.5;   // metres — Warning Zone
const CRIT_DIST    = 0.5;   // metres — Critical Impact Zone
const DEPTH_BASE   = 0.30;  // perspective baseline for inverse-distance mapping

function distToY(dist, vpY, ch) {
  // Inverse-distance perspective: closer objects → lower on screen (larger Y)
  const t = Math.min(DEPTH_BASE / Math.max(dist, 0.05), 1.0);
  return vpY + (ch - vpY) * t;
}

function drawDistanceThresholds(ctx, cw, ch) {
  const vpY = ch * 0.42;   // same vanishing-point horizon as drawADASPath
  const pad = cw * 0.06;   // horizontal padding so lines don't touch edges

  // ── Warning Zone (1.5 m) — dashed amber ──────────────────────────────────
  const warnY = distToY(WARN_DIST, vpY, ch);
  ctx.save();
  ctx.setLineDash([12, 8]);
  ctx.lineWidth   = 2;
  ctx.strokeStyle = "#f59e0b";
  ctx.shadowColor = "#f59e0b";
  ctx.shadowBlur  = 12;
  ctx.lineCap     = "round";
  ctx.beginPath();
  ctx.moveTo(pad, warnY);
  ctx.lineTo(cw - pad, warnY);
  ctx.stroke();

  // Label badge — Warning
  const wLbl    = "⚠ WARNING  1.5m";
  const wFont   = 9.5;
  ctx.font      = `bold ${wFont}px "JetBrains Mono","Fira Mono",monospace`;
  const wTxtW   = ctx.measureText(wLbl).width;
  const wBadgeW = wTxtW + 14;
  const wBadgeH = wFont + 10;
  const wBadgeX = cw - pad - wBadgeW - 4;
  const wBadgeY = warnY - wBadgeH / 2;
  ctx.setLineDash([]);
  ctx.shadowBlur  = 0;
  ctx.globalAlpha = 0.80;
  ctx.fillStyle   = "rgba(15,23,42,0.75)";
  if (ctx.roundRect) ctx.roundRect(wBadgeX, wBadgeY, wBadgeW, wBadgeH, 4);
  else ctx.rect(wBadgeX, wBadgeY, wBadgeW, wBadgeH);
  ctx.fill();
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth   = 0.8;
  if (ctx.roundRect) ctx.roundRect(wBadgeX, wBadgeY, wBadgeW, wBadgeH, 4);
  else ctx.rect(wBadgeX, wBadgeY, wBadgeW, wBadgeH);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle   = "#fbbf24";
  ctx.fillText(wLbl, wBadgeX + 7, wBadgeY + wFont + 3);
  ctx.restore();

  // ── Critical Impact Zone (0.5 m) — solid red ─────────────────────────────
  const critY = distToY(CRIT_DIST, vpY, ch);
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth   = 2.5;
  ctx.strokeStyle = "#ef4444";
  ctx.shadowColor = "#ef4444";
  ctx.shadowBlur  = 18;
  ctx.lineCap     = "round";
  ctx.beginPath();
  ctx.moveTo(pad, critY);
  ctx.lineTo(cw - pad, critY);
  ctx.stroke();

  // Label badge — Critical
  const cLbl    = "🔴 CRITICAL  0.5m";
  const cFont   = 9.5;
  ctx.font      = `bold ${cFont}px "JetBrains Mono","Fira Mono",monospace`;
  const cTxtW   = ctx.measureText(cLbl).width;
  const cBadgeW = cTxtW + 14;
  const cBadgeH = cFont + 10;
  const cBadgeX = cw - pad - cBadgeW - 4;
  const cBadgeY = critY - cBadgeH / 2;
  ctx.shadowBlur  = 0;
  ctx.globalAlpha = 0.80;
  ctx.fillStyle   = "rgba(15,23,42,0.75)";
  if (ctx.roundRect) ctx.roundRect(cBadgeX, cBadgeY, cBadgeW, cBadgeH, 4);
  else ctx.rect(cBadgeX, cBadgeY, cBadgeW, cBadgeH);
  ctx.fill();
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth   = 0.8;
  if (ctx.roundRect) ctx.roundRect(cBadgeX, cBadgeY, cBadgeW, cBadgeH, 4);
  else ctx.rect(cBadgeX, cBadgeY, cBadgeW, cBadgeH);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle   = "#f87171";
  ctx.fillText(cLbl, cBadgeX + 7, cBadgeY + cFont + 3);
  ctx.restore();
}

// ─── YOLO-style bounding box + label chip ────────────────────────────────────
function drawDetection(ctx, det, sx, sy) {
  const [x1, y1, x2, y2] = det.box ?? det.bbox ?? [0, 0, 0, 0];
  const rx = x1 * sx;
  const ry = y1 * sy;
  const rw = (x2 - x1) * sx;
  const rh = (y2 - y1) * sy;

  const dist      = det.distance ?? 0;
  const isHazard  = dist > 0 && dist < DIST_HAZARD;
  const boxColor  = isHazard ? "#ef4444" : "#4ade80";   // red if hazard, neon-green otherwise

  // Bounding box
  ctx.save();
  ctx.strokeStyle = boxColor;
  ctx.lineWidth   = 2;
  ctx.shadowColor = boxColor;
  ctx.shadowBlur  = 6;
  ctx.strokeRect(rx, ry, rw, rh);

  // Label chip
  const label     = `${det.label ?? "vehicle"} #${det.id ?? "?"} ${dist > 0 ? dist + "m" : ""}`.trim();
  const fontSize  = 11;
  ctx.font        = `bold ${fontSize}px "JetBrains Mono","Fira Mono",monospace`;
  const textW     = ctx.measureText(label).width;
  const chipH     = fontSize + 8;
  const chipY     = ry - chipH;
  const chipX     = rx;

  ctx.fillStyle   = boxColor;
  ctx.shadowBlur  = 0;
  if (ctx.roundRect) ctx.roundRect(chipX, Math.max(chipY, 0), textW + 10, chipH, [3, 3, 0, 0]);
  else ctx.rect(chipX, Math.max(chipY, 0), textW + 10, chipH);
  ctx.fill();

  ctx.fillStyle = chipY < 0 ? boxColor : "#000";
  ctx.fillStyle = "#000";
  ctx.shadowBlur = 0;
  ctx.fillText(label, chipX + 5, Math.max(chipY, 0) + fontSize + 1);

  ctx.restore();
}

// ─── Master HUD draw — called every rAF tick ─────────────────────────────────
function drawHUD(ctx, detections, cw, ch, flashOn, showOverlay, proximityAlert) {
  ctx.clearRect(0, 0, cw, ch);
  if (!showOverlay) return;

  // 1. ADAS path — always visible when overlay is on
  drawADASPath(ctx, cw, ch, proximityAlert, flashOn);

  // 2. Distance threshold boundary lines — Warning (1.5m) + Critical (0.5m)
  drawDistanceThresholds(ctx, cw, ch);

  if (!detections.length) return;

  const sx = cw / FRAME_W;
  const sy = ch / FRAME_H;

  // 2. Per-detection: spatial line + YOLO box
  for (const det of detections) {
    const [x1, y1, x2, y2] = det.box ?? det.bbox ?? [0, 0, 0, 0];
    const rx   = x1 * sx;
    const ry   = y1 * sy;
    const rw   = (x2 - x1) * sx;
    const rh   = (y2 - y1) * sy;
    const dist = det.distance ?? 0;
    const color = getColor(dist);
    const lw    = getLineWidth(dist);

    // Proximity tint
    if (dist > 0 && dist < DIST_SAFE) drawTint(ctx, rx, ry, rw, rh, color);

    // Spatial drop-line
    drawSpatialLine(ctx, rx + rw / 2, ry + rh, ch, color, lw);

    // YOLO-style box + label
    drawDetection(ctx, det, sx, sy);
  }
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function LiveStream() {
  const [logs, setLogs]                 = useState([]);
  const [telemetryData, setTelemetryData] = useState({});
  const [wsStatus, setWsStatus]         = useState("connecting");
  const [streamError, setStreamError]   = useState("");
  const [detections, setDetections]     = useState([]);
  const [closestDistance, setClosestDistance] = useState(null);
  const [hazardAlert, setHazardAlert]   = useState(false);
  const [proximityAlert, setProximityAlert] = useState(false);
  const [collisionVec, setCollisionVec] = useState(false);
  const [showOverlay, setShowOverlay]   = useState(true);
  const [isLockedDown, setIsLockedDown] = useState(false);
  const [criticalImpactLogged, setCriticalImpactLogged] = useState(false);
  const [locationData, setLocationData] = useState({ latitude: null, longitude: null });
  const [notificationEmail, setNotificationEmail] = useState("");
  const { currentUser } = useAuth();

  // Refs — hot-path reads never trigger re-renders
  const ws              = useRef(null);
  const videoRef        = useRef(null);
  const sendCanvasRef   = useRef(null);
  const snapshotCanvasRef = useRef(null);
  const overlayRef      = useRef(null);
  const intervalRef     = useRef(null);
  const rafRef          = useRef(null);
  const mediaStreamRef  = useRef(null);
  const detectionsRef   = useRef([]);
  const showOverlayRef  = useRef(true);
  const flashRef        = useRef(false);
  const flashTimerRef   = useRef(null);
  const hazardLoggedRef = useRef(false);
  const proximityRef    = useRef(false);
  const telemetryPreRef = useRef(null);
  const lastAlertTimeRef = useRef(0);
  const isLockedDownRef = useRef(false);

  useEffect(() => { detectionsRef.current  = detections;  }, [detections]);
  useEffect(() => { showOverlayRef.current = showOverlay; }, [showOverlay]);
  useEffect(() => { proximityRef.current   = proximityAlert; }, [proximityAlert]);
  useEffect(() => { isLockedDownRef.current = isLockedDown; }, [isLockedDown]);

  // ── Fetch the user's notification email from Settings (Firestore config) ──
  useEffect(() => {
    if (!currentUser?.uid) return;
    const fetchNotificationEmail = async () => {
      try {
        const configSnap = await getDoc(doc(db, "users", currentUser.uid, "config", "system"));
        if (configSnap.exists()) {
          const data = configSnap.data();
          if (data.notificationEmail) {
            setNotificationEmail(data.notificationEmail);
          }
        }
      } catch (e) {
        console.warn("Failed to fetch notification email from config:", e);
      }
    };
    fetchNotificationEmail();
  }, [currentUser?.uid]);

  useEffect(() => {
    if (!telemetryPreRef.current) return;
    telemetryPreRef.current.scrollTop = telemetryPreRef.current.scrollHeight;
  }, [telemetryData]);

  const triggerVoiceAlert = useCallback((message) => {
    const now = Date.now();
    if (now - lastAlertTimeRef.current < 3000) return;
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    const utterance = new SpeechSynthesisUtterance(message);
    utterance.pitch = 0.82;
    utterance.rate = 1.12;
    utterance.volume = 1;

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    lastAlertTimeRef.current = now;
  }, []);

  useEffect(() => {
    if (!proximityAlert) return;
    triggerVoiceAlert("Warning. Proximity Alert. Collision imminent.");
  }, [proximityAlert, triggerVoiceAlert]);

  const addLog = useCallback((msg, type = "info") => {
    setLogs((prev) => [...prev, {
      time: new Date().toLocaleTimeString("en-US", { hour12: false }),
      msg, type,
    }].slice(-40));
  }, []);

  useEffect(() => {
    if (!navigator?.geolocation) {
      addLog("Geolocation is not supported in this browser.", "warning");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocationData({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
        addLog("Live GPS lock acquired.", "success");
      },
      (error) => {
        addLog(`GPS lock failed: ${error.message}`, "warning");
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      },
    );
  }, [addLog]);

  const handleAutonomousCollision = useCallback(async () => {
    if (isLockedDownRef.current) return;

    setIsLockedDown(true);
    setCriticalImpactLogged(true);
    addLog("🚨 CRITICAL IMPACT: AUTONOMOUS DISPATCH ENGAGED.", "danger");
    triggerVoiceAlert("Critical impact. Autonomous dispatch engaged.");

    const videoEl = videoRef.current;
    if (videoEl && !videoEl.paused) {
      videoEl.pause();
    }

    try {
      if (!videoEl || videoEl.readyState < 2) {
        throw new Error("Video frame unavailable for snapshot capture.");
      }

      // ── Capture 4 burst snapshots at T=0, 300ms, 600ms, 900ms ──────────
      const captureSnapshot = () => {
        const canvas = document.createElement("canvas");
        canvas.width  = videoEl.videoWidth  || FRAME_W;
        canvas.height = videoEl.videoHeight || FRAME_H;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.82);
      };

      const snapshots = [];
      snapshots.push(captureSnapshot()); // T=0 — primary impact frame

      // Resume video briefly to capture post-impact frames
      try { await videoEl.play(); } catch { /* ignore */ }

      await new Promise((r) => setTimeout(r, 300));
      snapshots.push(captureSnapshot()); // T+300ms

      await new Promise((r) => setTimeout(r, 300));
      snapshots.push(captureSnapshot()); // T+600ms

      await new Promise((r) => setTimeout(r, 300));
      snapshots.push(captureSnapshot()); // T+900ms

      // Pause again after burst capture
      try { videoEl.pause(); } catch { /* ignore */ }

      addLog(`📸 ${snapshots.length} burst snapshots captured.`, "danger");

      const apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
      const response = await fetch(`${apiBase}/api/incidents/autonomous_log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          severity:        "Critical",
          lat:             locationData.latitude,
          lng:             locationData.longitude,
          snapshot_base64: snapshots[0],
          snapshots:       snapshots.slice(1),
          userId:          currentUser?.uid || null,
          user_email:      notificationEmail || currentUser?.email || null,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.detail || "Incident logging failed.");
      }

      addLog(`🚨 Incident logged — Audit ID: ${payload?.audit_id || "N/A"}`, "danger");
      if (payload?.sms_dispatched) {
        addLog("📱 Twilio SMS dispatched to emergency contact.", "danger");
      } else if (payload?.sms_error) {
        addLog(`⚠️ SMS failed: ${payload.sms_error}`, "warning");
      }
      if (payload?.email_dispatched) {
        addLog(`📧 Email dispatched to ${notificationEmail || currentUser?.email}.`, "danger");
      }
    } catch (err) {
      addLog(`Autonomous dispatch failed: ${err?.message || "unknown error"}`, "danger");
    }
  }, [addLog, locationData.latitude, locationData.longitude, triggerVoiceAlert, notificationEmail, currentUser]);

  const handleManualReset = useCallback(async () => {
    setIsLockedDown(false);
    setCriticalImpactLogged(false);
    addLog("Manual reset complete. Live pipeline resumed.", "system");

    try {
      const videoEl = videoRef.current;
      if (videoEl && videoEl.paused) {
        await videoEl.play();
      }
    } catch {
      addLog("Video resume requires user interaction.", "warning");
    }
  }, [addLog]);

  const buildWsUrl = () => {
    const base   = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
    const parsed = new URL(base);
    return `${parsed.protocol === "https:" ? "wss:" : "ws:"}//${parsed.host}/ws/live-feed`;
  };

  // ── Sync canvas resolution to video element size ─────────────────────────
  // Called on every rAF tick — ensures pixel-perfect overlay alignment
  const syncCanvasSize = () => {
    const canvas  = overlayRef.current;
    const videoEl = videoRef.current;
    if (!canvas || !videoEl) return;
    const { clientWidth: cw, clientHeight: ch } = videoEl;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width  = cw;
      canvas.height = ch;
      // Position canvas exactly over video
      canvas.style.width  = `${cw}px`;
      canvas.style.height = `${ch}px`;
    }
  };

  // ── Encode + send frame ──────────────────────────────────────────────────
  const sendFrame = useCallback(() => {
    if (isLockedDownRef.current) return;
    const socket  = ws.current;
    const videoEl = videoRef.current;
    const canvas  = sendCanvasRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (!videoEl || !canvas || videoEl.readyState < 2) return;
    canvas.width  = FRAME_W;
    canvas.height = FRAME_H;
    canvas.getContext("2d").drawImage(videoEl, 0, 0, FRAME_W, FRAME_H);
    socket.send(JSON.stringify({ type: "frame", frame: canvas.toDataURL("image/jpeg", 0.62) }));
  }, []);

  // ── rAF draw loop ────────────────────────────────────────────────────────
  const drawLoop = useCallback(() => {
    syncCanvasSize();
    const canvas = overlayRef.current;
    if (canvas) {
      drawHUD(
        canvas.getContext("2d"),
        detectionsRef.current,
        canvas.width, canvas.height,
        flashRef.current,
        showOverlayRef.current,
        proximityRef.current,
      );
    }
    rafRef.current = requestAnimationFrame(drawLoop);
  }, []);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(drawLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [drawLoop]);

  // ── Hazard flash ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (hazardAlert) {
      flashTimerRef.current = setInterval(() => { flashRef.current = !flashRef.current; }, 250);
    } else {
      flashRef.current = false;
      clearInterval(flashTimerRef.current);
      hazardLoggedRef.current = false;
    }
    return () => clearInterval(flashTimerRef.current);
  }, [hazardAlert]);

  // ── Collision-vector beep ────────────────────────────────────────────────
  useEffect(() => {
    if (!collisionVec) return;
    try {
      const ac   = new (window.AudioContext || window.webkitAudioContext)();
      const osc  = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      osc.type = "square";
      osc.frequency.setValueAtTime(960, ac.currentTime);
      gain.gain.setValueAtTime(0.07, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.25);
      osc.start(); osc.stop(ac.currentTime + 0.25);
    } catch { /* AudioContext may require user gesture */ }
  }, [collisionVec]);

  // ── Camera + WebSocket init ──────────────────────────────────────────────
  useEffect(() => {
    let unmounted = false;

    const init = async () => {
      try {
        setWsStatus("connecting");
        addLog("Initialising spatial engine...", "system");

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "environment" },
          audio: false,
        });
        if (unmounted) return;

        mediaStreamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        addLog("Camera stream active. HUD armed.", "success");

        const socket = new WebSocket(buildWsUrl());
        ws.current   = socket;

        socket.onopen = () => {
          setWsStatus("connected");
          addLog("ByteTrack spatial engine online — 10 FPS.", "success");
          intervalRef.current = setInterval(sendFrame, 100); // 10 FPS
        };

        socket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.skipped) return;

            const dets = Array.isArray(data?.detections) ? data.detections : [];
            setDetections(dets);
            detectionsRef.current = dets;

            const nearest = dets
              .map((d) => Number(d?.distance || 0))
              .filter((d) => Number.isFinite(d) && d > 0)
              .reduce((min, d) => (d < min ? d : min), Infinity);
            const nearestDistance = nearest === Infinity ? null : Number(nearest.toFixed(2));
            setClosestDistance(nearestDistance);

            const hazard = Boolean(data?.hazard_alert);
            const proximity = Boolean(data?.proximity_alert);
            const cvec   = Boolean(data?.collision_vector);
            const collisionAlert = Boolean(data?.collision_alert);
            const smoothedDistance = Number(data?.smoothed_distance);
            setHazardAlert(hazard);
            setProximityAlert(proximity);
            setCollisionVec(cvec);

            // Use backend's confirmed collision_alert (5-frame glitch-filtered)
            if (collisionAlert && !isLockedDownRef.current) {
              handleAutonomousCollision();
            }

            if (hazard && !hazardLoggedRef.current) {
              addLog("🚨 HAZARD — approaching vehicle < 3m!", "danger");
              hazardLoggedRef.current = true;
            }
            if (cvec) addLog("⚡ COLLISION VECTOR — closing > 1 m/s", "danger");

            setTelemetryData(data);
          } catch {
            addLog("Non-JSON WebSocket payload.", "warning");
          }
        };

        socket.onerror = () => {
          setWsStatus("error");
          setStreamError("WebSocket connection failed.");
          addLog("WebSocket error — spatial engine offline.", "danger");
        };

        socket.onclose = () => {
          setWsStatus((p) => (p === "error" ? p : "disconnected"));
          addLog("WebSocket disconnected.", "warning");
        };

      } catch (err) {
        const msg = err?.name === "NotAllowedError"
          ? "Camera access denied. Please allow camera permissions."
          : err?.message || "Failed to initialise live stream.";
        setStreamError(msg);
        setWsStatus("error");
        addLog(msg, "danger");
      }
    };

    init();
    return () => {
      unmounted = true;
      clearInterval(intervalRef.current);
      ws.current?.close();
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, [addLog, sendFrame, handleAutonomousCollision]);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 flex flex-col h-full animate-in fade-in slide-in-from-bottom-4 duration-700 ease-out">

      {/* Page header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-4xl font-extrabold tracking-tight text-white drop-shadow-[0_0_15px_rgba(255,255,255,0.1)]">
            Live Spatial HUD
          </h2>
          <p className="text-zinc-500 font-medium text-lg">
            YOLOv8 · ByteTrack · Monocular Depth · Collision Vector
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => setShowOverlay((v) => !v)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-xs font-black uppercase tracking-widest transition-all duration-200 ${
              showOverlay
                ? "bg-sky-500/10 border-sky-500/40 text-sky-400 hover:bg-sky-500/20"
                : "bg-white/5 border-white/10 text-zinc-500 hover:bg-white/10 hover:text-white"
            }`}
          >
            {showOverlay ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            {showOverlay ? "HUD ON" : "HUD OFF"}
          </button>

          {isLockedDown && (
            <button
              onClick={handleManualReset}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-red-300 bg-red-700 text-white text-xs font-black uppercase tracking-widest transition-all duration-200 hover:bg-red-600"
            >
              Manual Reset
            </button>
          )}

          <div className="hidden md:flex items-center gap-4 bg-black/40 backdrop-blur-md px-5 py-3 border border-white/10 rounded-2xl shadow-xl">
            <div className="flex flex-col items-end">
              <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest">Tracker</span>
              <span className="text-sm font-bold text-white font-mono">ByteTrack</span>
            </div>
            <div className="h-8 w-px bg-white/10" />
            <div className="flex flex-col items-end">
              <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest">Tracked</span>
              <span className="text-sm font-bold text-green-400 font-mono drop-shadow-[0_0_8px_rgba(34,197,94,0.5)]">
                {detections.length}
              </span>
            </div>
            <div className="h-8 w-px bg-white/10" />
            <div className="flex flex-col items-end">
              <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest">FPS</span>
              <span className="text-sm font-bold text-sky-400 font-mono">
                {wsStatus === "connected" ? "~10" : "--"}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 flex-1 min-h-125">

        {/* ── Video + HUD ──────────────────────────────────────────────────── */}
        <div className="lg:col-span-3 flex flex-col h-full">
          <Card className="flex-1 overflow-hidden glass-card border-none shadow-2xl flex flex-col relative group">
            <div className="bg-[#050505] relative flex items-center justify-center overflow-hidden m-1.5 rounded-[0.8rem] border border-white/5 min-h-130 h-[72vh] max-h-[72vh]">

              {/* Subtle grid */}
              <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-size-[40px_40px] pointer-events-none mix-blend-overlay" />

              {/* Status badges */}
              <div className="absolute top-4 left-4 flex gap-2 z-20 flex-wrap">
                <Badge className="bg-red-500 text-white border border-red-400 animate-pulse flex items-center gap-1.5 px-3 py-1.5 shadow-[0_0_20px_rgba(239,68,68,0.6)] font-black tracking-widest text-[10px]">
                  <Radio className="w-3.5 h-3.5" /> LIVE RECON
                </Badge>
                <Badge variant="secondary" className="bg-black/60 text-zinc-300 border border-white/10 backdrop-blur-xl px-4 py-1.5 font-bold tracking-widest uppercase text-[10px]">
                  Cam 01 · Node Alpha
                </Badge>
                {collisionVec && (
                  <Badge className="bg-red-600/90 text-white border border-red-400 animate-pulse flex items-center gap-1.5 px-3 py-1.5 font-black tracking-widest text-[10px]">
                    ⚡ COLLISION VECTOR
                  </Badge>
                )}
              </div>

              <div className="absolute top-4 right-4 z-20">
                <Badge variant="secondary" className="bg-black/60 text-green-400 border border-green-500/30 backdrop-blur-xl font-mono flex gap-1.5 px-3 py-1.5 shadow-[0_0_20px_rgba(34,197,94,0.2)] font-bold text-xs">
                  <Zap className="w-3.5 h-3.5" />
                  {wsStatus === "connected" ? "~10 FPS" : "-- FPS"}
                </Badge>
              </div>

              {/* Full-screen hazard overlay */}
              {hazardAlert && showOverlay && (
                <div className="absolute inset-0 z-30 pointer-events-none">
                  <div
                    className="absolute inset-0 animate-pulse"
                    style={{ background: "radial-gradient(ellipse at center, transparent 35%, rgba(239,68,68,0.4) 100%)" }}
                  />
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-2">
                    <div className="flex items-center gap-3 px-6 py-3 rounded-2xl bg-red-600/95 border-2 border-red-400 shadow-[0_0_40px_rgba(239,68,68,0.9)] backdrop-blur-sm animate-pulse">
                      <AlertTriangle className="w-6 h-6 text-white" />
                      <span className="text-white font-black text-base tracking-[0.15em] uppercase">
                        HAZARD — COLLISION IMMINENT
                      </span>
                      <AlertTriangle className="w-6 h-6 text-white" />
                    </div>
                    <span className="text-red-300 font-mono text-xs font-bold tracking-widest uppercase">
                      Approaching vehicle &lt; 3m
                    </span>
                  </div>
                </div>
              )}

              {/* Proximity warning state */}
              {criticalImpactLogged && showOverlay && (
                <>
                  <div className="absolute inset-0 z-40 pointer-events-none bg-black/90" />
                  <div className="absolute inset-0 z-50 pointer-events-none flex items-center justify-center">
                    <div className="rounded-2xl border-2 border-red-300 bg-red-800 px-10 py-6 shadow-[0_0_80px_rgba(239,68,68,0.95)] animate-pulse">
                      <p className="text-center text-red-50 font-black text-2xl tracking-widest uppercase">
                        🚨 CRITICAL IMPACT: AUTONOMOUS DISPATCH ENGAGED.
                      </p>
                    </div>
                  </div>
                </>
              )}

              {proximityAlert && showOverlay && !criticalImpactLogged && (
                <>
                  <div className="absolute inset-0 z-20 pointer-events-none bg-red-500/20 animate-pulse" />
                  <div className="absolute top-6 left-1/2 -translate-x-1/2 z-9999 pointer-events-none">
                    <div className="rounded-2xl border-2 border-red-300 bg-red-600 px-8 py-4 shadow-[0_0_40px_rgba(239,68,68,0.85)]">
                      <p className="text-center text-white font-black text-lg tracking-[0.08em] uppercase">
                        ⚠️ PROXIMITY WARNING - IMMINENT COLLISION
                      </p>
                    </div>
                  </div>
                </>
              )}

              {/* Tactical Distance Gauge */}
              {showOverlay && (
                <div className="absolute right-4 top-1/2 -translate-y-1/2 z-30 pointer-events-none">
                  <div className="w-24 rounded-2xl border border-white/10 bg-black/60 px-3 py-3 backdrop-blur-md shadow-2xl">
                    <p className="mb-1 text-center text-[9px] font-black uppercase tracking-widest text-zinc-500">TGT DIST</p>
                    <p className="mb-3 text-center text-xs font-black tabular-nums text-white">
                      {closestDistance !== null ? `${closestDistance}m` : "--"}
                    </p>
                    <div className="mx-auto flex h-44 w-4 items-end overflow-hidden rounded-full border border-white/10 bg-zinc-900/90">
                      <div
                        className={`w-full transition-all duration-300 ${
                          closestDistance !== null && closestDistance < 2
                            ? "bg-red-500"
                            : closestDistance !== null && closestDistance <= 5
                            ? "bg-yellow-400"
                            : "bg-green-500"
                        }`}
                        style={{
                          height:
                            closestDistance === null
                              ? "0%"
                              : `${Math.max(0, Math.min(100, ((10 - closestDistance) / 10) * 100))}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* ── Video element — base layer ─────────────────────────── */}
              <video
                ref={videoRef}
                muted
                playsInline
                className="h-full w-full object-cover"
              />

              {/* Hidden encode canvas */}
              <canvas ref={sendCanvasRef} className="hidden" />
              <canvas ref={snapshotCanvasRef} className="hidden" />

              {/* HUD overlay canvas — absolute, pixel-synced to video */}
              <canvas
                ref={overlayRef}
                className="absolute top-0 left-0 pointer-events-none z-10"
                style={{ imageRendering: "pixelated" }}
              />

              {/* Connecting overlay only (non-blocking for disconnected/error states) */}
              {wsStatus === "connecting" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm z-20">
                  <Scan className="w-16 h-16 text-zinc-500 mb-4 animate-[spin_12s_linear_infinite]" />
                  <p className="text-sm font-bold tracking-widest uppercase text-zinc-300">
                    Initialising Spatial Engine...
                  </p>
                  {streamError && <p className="mt-2 text-xs text-red-300">{streamError}</p>}
                </div>
              )}

              {/* Compact WS status message (does not block video visibility) */}
              {wsStatus !== "connected" && wsStatus !== "connecting" && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
                  <div className="rounded-xl border border-red-500/35 bg-red-950/80 px-4 py-2 shadow-[0_0_20px_rgba(127,29,29,0.55)]">
                    <p className="text-[10px] font-black uppercase tracking-widest text-red-200">
                      Spatial engine offline. Showing raw camera feed.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* ── Telemetry panel ──────────────────────────────────────────────── */}
        <div className="lg:col-span-1 h-full min-h-100">
          <Card className="h-full flex flex-col glass-card border-none shadow-2xl overflow-hidden relative">
            <div className="absolute top-0 left-0 w-full h-px bg-linear-to-r from-transparent via-zinc-500 to-transparent" />

            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between bg-black/40 backdrop-blur-md z-10">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-white/5 rounded-lg border border-white/10 shadow-inner">
                  <ShieldAlert className="w-4 h-4 text-zinc-300" />
                </div>
                <span className="font-black text-[13px] text-white tracking-widest uppercase">
                  Spatial Telemetry
                </span>
              </div>
              {detections.length > 0 && (
                <span className="text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20">
                  {detections.length} tracked
                </span>
              )}
            </div>

            <ScrollArea className="flex-1 p-4 bg-[#050505]/95 backdrop-blur-3xl">
              <div className="space-y-3 font-mono text-[11px] leading-relaxed">

                {/* Per-vehicle table */}
                {Array.isArray(detections) && detections.length > 0 && (
                  <div className="rounded-lg border border-white/10 bg-black/40 overflow-hidden">
                    <div className="grid grid-cols-[24px_1fr_48px_52px] border-b border-white/5 px-3 py-2">
                      {["ID", "Status", "Dist", "Vel"].map((h) => (
                        <span key={h} className="text-[9px] font-black uppercase tracking-widest text-zinc-600">{h}</span>
                      ))}
                    </div>
                    {detections.map((d) => {
                      const tc =
                        d.distance > 0 && d.distance < DIST_HAZARD ? "text-red-400" :
                        d.distance > 0 && d.distance < DIST_SAFE   ? "text-orange-400" :
                        "text-sky-400";
                      const icon =
                        d.status === "approaching" ? "▼" :
                        d.status === "receding"    ? "▲" : "●";
                      return (
                        <div
                          key={d.id}
                          className={`grid grid-cols-[24px_1fr_48px_52px] px-3 py-1.5 border-b border-white/5 last:border-0 ${
                            d.distance > 0 && d.distance < DIST_HAZARD ? "bg-red-500/[0.07]" : ""
                          }`}
                        >
                          <span className={`font-black ${tc}`}>{d.id}</span>
                          <span className={`${tc} flex items-center gap-1`}>
                            <span className="text-[9px]">{icon}</span>{d.status}
                          </span>
                          <span className={`font-black tabular-nums ${tc}`}>
                            {d.distance > 0 ? `${d.distance}m` : "—"}
                          </span>
                          <span className={`font-black tabular-nums ${tc}`}>
                            {d.velocity !== undefined ? `${Math.abs(d.velocity)}` : "—"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Raw telemetry */}
                <div className="rounded-lg border border-white/10 bg-black/40 p-3 text-zinc-400">
                  <p className="text-[9px] uppercase tracking-widest text-zinc-600 mb-2">
                    {telemetryData?.providerTitle || "System Loading..."}
                  </p>
                  {Object.keys(telemetryData).length === 0 ? (
                    <p className="text-gray-500 italic text-[10px]">Initializing Neural Engine...</p>
                  ) : (
                    <pre ref={telemetryPreRef} className="max-h-40 overflow-auto text-[10px] whitespace-pre-wrap wrap-break-word">
                      {JSON.stringify(telemetryData, null, 2)}
                    </pre>
                  )}
                </div>

                {/* Event log */}
                {logs.map((log, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-zinc-700 shrink-0">[{log.time}]</span>
                    <span className={
                      log.type === "system"  ? "text-blue-400" :
                      log.type === "success" ? "text-green-400" :
                      log.type === "warning" ? "text-yellow-400 font-bold" :
                      log.type === "danger"  ? "text-red-400 font-black drop-shadow-[0_0_6px_rgba(248,113,113,0.7)]" :
                      "text-zinc-400"
                    }>{log.msg}</span>
                  </div>
                ))}

                <div className="flex gap-2 pt-3 border-t border-white/5">
                  <span className="text-zinc-700 shrink-0">
                    [{new Date().toLocaleTimeString("en-US", { hour12: false })}]
                  </span>
                  <span className="text-zinc-600 flex items-center gap-1.5 font-bold tracking-widest uppercase text-[9px]">
                    Awaiting tensor data
                    {[0, 150, 300].map((d) => (
                      <span key={d} className="w-1 h-1 bg-zinc-700 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
                    ))}
                  </span>
                </div>
              </div>
            </ScrollArea>
          </Card>
        </div>
      </div>
    </div>
  );
}
