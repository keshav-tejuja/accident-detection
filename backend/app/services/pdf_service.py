"""
PDF Service — Professional Report Generation with ReportLab
============================================================
Generates real, downloadable, multi-page PDF documents from structured
report data produced by groq_service.py.

Both templates produce at least 2 A4 pages with professional formatting,
consistent headers/footers, page numbers, and clear section separation.

Usage:
    from app.services.pdf_service import generate_health_insurance_pdf
    from app.services.pdf_service import generate_motor_insurance_pdf
    pdf_bytes = generate_health_insurance_pdf(report_data, report_id)
"""

import io
import time
from datetime import datetime

try:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm, cm
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT, TA_JUSTIFY
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
        PageBreak, HRFlowable, KeepTogether
    )
    from reportlab.platypus.flowables import Flowable
    REPORTLAB_AVAILABLE = True
except ImportError:
    REPORTLAB_AVAILABLE = False

# ── Brand palette ──────────────────────────────────────────────────────────────
_DARK_NAVY    = colors.HexColor("#0f172a")
_BRAND_BLUE   = colors.HexColor("#1d4ed8")
_ACCENT_BLUE  = colors.HexColor("#3b82f6")
_TEAL         = colors.HexColor("#0891b2")
_HEALTH_GREEN = colors.HexColor("#059669")
_MOTOR_RED    = colors.HexColor("#dc2626")
_WARN_AMBER   = colors.HexColor("#d97706")
_LIGHT_BG     = colors.HexColor("#f8fafc")
_BORDER_GRAY  = colors.HexColor("#e2e8f0")
_HEADER_GRAY  = colors.HexColor("#f1f5f9")
_TEXT_DARK    = colors.HexColor("#1e293b")
_TEXT_MUTED   = colors.HexColor("#64748b")
_WHITE        = colors.white


# ── Helper: ensure text is a string ───────────────────────────────────────────
def _s(val, fallback="Not available in supplied evidence") -> str:
    if val is None:
        return fallback
    s = str(val).strip()
    return s if s else fallback


# ── Page template callbacks ────────────────────────────────────────────────────
class _HeaderFooter:
    """Mixin for page header and footer — instantiated once per doc."""

    def __init__(self, title: str, subtitle: str, report_id: str, accent_color, total_pages: int = 0):
        self.title = title
        self.subtitle = subtitle
        self.report_id = report_id
        self.accent = accent_color
        # total_pages updated after build via two-pass trick
        self._total_pages = total_pages

    def on_page(self, canvas, doc):
        canvas.saveState()
        w, h = A4

        # ── Top banner ────────────────────────────────────────────────────────
        canvas.setFillColor(self.accent)
        canvas.rect(0, h - 25 * mm, w, 25 * mm, fill=True, stroke=False)

        canvas.setFillColor(_WHITE)
        canvas.setFont("Helvetica-Bold", 13)
        canvas.drawString(15 * mm, h - 13 * mm, self.title)

        canvas.setFont("Helvetica", 9)
        canvas.drawString(15 * mm, h - 20 * mm, self.subtitle)

        # Report ID top-right
        canvas.setFont("Helvetica-Bold", 9)
        id_text = f"Report ID: {self.report_id}"
        canvas.drawRightString(w - 15 * mm, h - 13 * mm, id_text)

        gen_text = f"Generated: {time.strftime('%d %b %Y %H:%M UTC', time.gmtime())}"
        canvas.drawRightString(w - 15 * mm, h - 20 * mm, gen_text)

        # ── Bottom footer ─────────────────────────────────────────────────────
        canvas.setFillColor(self.accent)
        canvas.rect(0, 0, w, 12 * mm, fill=True, stroke=False)

        canvas.setFillColor(_WHITE)
        canvas.setFont("Helvetica", 8)
        canvas.drawString(15 * mm, 4 * mm, "SafeTrack AI — Accident Detection & Emergency Response System")

        # Page number
        page_num = doc.page
        canvas.setFont("Helvetica-Bold", 8)
        canvas.drawRightString(w - 15 * mm, 4 * mm, f"Page {page_num}")

        canvas.restoreState()


# ── Shared style factory ───────────────────────────────────────────────────────
def _build_styles(accent_color):
    base = getSampleStyleSheet()
    return {
        "h1": ParagraphStyle("h1",
            fontName="Helvetica-Bold", fontSize=14, textColor=accent_color,
            spaceAfter=6, spaceBefore=12, leading=18),
        "h2": ParagraphStyle("h2",
            fontName="Helvetica-Bold", fontSize=11, textColor=_TEXT_DARK,
            spaceAfter=4, spaceBefore=8, leading=14),
        "body": ParagraphStyle("body",
            fontName="Helvetica", fontSize=9, textColor=_TEXT_DARK,
            spaceAfter=4, leading=13, alignment=TA_JUSTIFY),
        "label": ParagraphStyle("label",
            fontName="Helvetica-Bold", fontSize=9, textColor=_TEXT_MUTED,
            spaceAfter=2, leading=12),
        "small": ParagraphStyle("small",
            fontName="Helvetica", fontSize=8, textColor=_TEXT_MUTED,
            spaceAfter=3, leading=11),
        "disclaimer": ParagraphStyle("disclaimer",
            fontName="Helvetica-Oblique", fontSize=8, textColor=_TEXT_MUTED,
            spaceAfter=4, leading=11, borderColor=_WARN_AMBER,
            borderWidth=1, borderPadding=6, backColor=colors.HexColor("#fffbeb")),
        "center": ParagraphStyle("center",
            fontName="Helvetica", fontSize=9, textColor=_TEXT_DARK,
            alignment=TA_CENTER, spaceAfter=4, leading=13),
    }


def _kv_table(rows: list[tuple], col_widths=None) -> Table:
    """Render a two-column key-value table."""
    if col_widths is None:
        col_widths = [70 * mm, 100 * mm]
    data = [[_s(k), _s(v)] for k, v in rows]
    t = Table(data, colWidths=col_widths, repeatRows=0)
    t.setStyle(TableStyle([
        ("BACKGROUND",  (0, 0), (0, -1), _HEADER_GRAY),
        ("FONTNAME",    (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTNAME",    (1, 0), (1, -1), "Helvetica"),
        ("FONTSIZE",    (0, 0), (-1, -1), 9),
        ("TEXTCOLOR",   (0, 0), (0, -1), _TEXT_DARK),
        ("TEXTCOLOR",   (1, 0), (1, -1), _TEXT_DARK),
        ("VALIGN",      (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [_WHITE, _LIGHT_BG]),
        ("GRID",        (0, 0), (-1, -1), 0.5, _BORDER_GRAY),
        ("LEFTPADDING",  (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING",   (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 5),
    ]))
    return t


def _timeline_table(rows: list[dict]) -> Table:
    """Render an incident timeline table."""
    header = [["Event", "Timestamp", "Status", "Evidence/Source"]]
    data = header + [
        [_s(r.get("event")), _s(r.get("timestamp")), _s(r.get("status")),
         _s(r.get("evidence_source") or r.get("evidence"))]
        for r in rows
    ]
    col_widths = [45 * mm, 40 * mm, 40 * mm, 45 * mm]
    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND",  (0, 0), (-1, 0), _DARK_NAVY),
        ("TEXTCOLOR",   (0, 0), (-1, 0), _WHITE),
        ("FONTNAME",    (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",    (0, 0), (-1, -1), 8),
        ("FONTNAME",    (0, 1), (-1, -1), "Helvetica"),
        ("TEXTCOLOR",   (0, 1), (-1, -1), _TEXT_DARK),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [_WHITE, _LIGHT_BG]),
        ("GRID",        (0, 0), (-1, -1), 0.5, _BORDER_GRAY),
        ("VALIGN",      (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",  (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING",   (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 4),
    ]))
    return t


def _checklist_table(items: list, key_col="item", val_col="status") -> Table:
    header = [["Document / Item", "Status"]]
    if isinstance(items, dict):
        data = header + [[_s(k.replace("_", " ").title()), _s(v)] for k, v in items.items()]
    else:
        data = header + [[_s(r.get(key_col) if isinstance(r, dict) else r),
                          _s(r.get(val_col, "To be provided") if isinstance(r, dict) else "To be provided")]
                         for r in items]
    col_widths = [100 * mm, 70 * mm]
    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND",  (0, 0), (-1, 0), _DARK_NAVY),
        ("TEXTCOLOR",   (0, 0), (-1, 0), _WHITE),
        ("FONTNAME",    (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",    (0, 0), (-1, -1), 8),
        ("FONTNAME",    (0, 1), (-1, -1), "Helvetica"),
        ("TEXTCOLOR",   (0, 1), (-1, -1), _TEXT_DARK),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [_WHITE, _LIGHT_BG]),
        ("GRID",        (0, 0), (-1, -1), 0.5, _BORDER_GRAY),
        ("VALIGN",      (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",  (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING",   (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 4),
    ]))
    return t


def _evidence_table(items: list) -> Table:
    header = [["Evidence Item", "Reference", "Status"]]
    data = header + [
        [_s(r.get("item")), _s(r.get("reference")), _s(r.get("status"))]
        for r in items
    ]
    col_widths = [50 * mm, 85 * mm, 35 * mm]
    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND",  (0, 0), (-1, 0), _DARK_NAVY),
        ("TEXTCOLOR",   (0, 0), (-1, 0), _WHITE),
        ("FONTNAME",    (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",    (0, 0), (-1, -1), 8),
        ("FONTNAME",    (0, 1), (-1, -1), "Helvetica"),
        ("TEXTCOLOR",   (0, 1), (-1, -1), _TEXT_DARK),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [_WHITE, _LIGHT_BG]),
        ("GRID",        (0, 0), (-1, -1), 0.5, _BORDER_GRAY),
        ("VALIGN",      (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",  (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING",   (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 4),
    ]))
    return t


def _section_header(title: str, style, accent_color, width=170 * mm) -> Table:
    """Section header bar with accent background."""
    t = Table([[title]], colWidths=[width])
    t.setStyle(TableStyle([
        ("BACKGROUND",  (0, 0), (-1, -1), accent_color),
        ("TEXTCOLOR",   (0, 0), (-1, -1), _WHITE),
        ("FONTNAME",    (0, 0), (-1, -1), "Helvetica-Bold"),
        ("FONTSIZE",    (0, 0), (-1, -1), 10),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING",  (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 6),
    ]))
    return t


# ── Health Insurance PDF ───────────────────────────────────────────────────────

def generate_health_insurance_pdf(report_data: dict, report_id: str) -> bytes:
    """
    Generate a professional Health Insurance Accident Incident Report PDF.

    Args:
        report_data: Structured dict from groq_service.generate_health_insurance_content()
        report_id: Unique report identifier for headers and filename.

    Returns:
        PDF bytes. Caller verifies page count.

    Raises:
        RuntimeError if ReportLab is not installed.
    """
    if not REPORTLAB_AVAILABLE:
        raise RuntimeError("reportlab package is not installed. Run: pip install reportlab")

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=15 * mm,
        rightMargin=15 * mm,
        topMargin=32 * mm,   # space for header banner
        bottomMargin=18 * mm,
    )

    accent = _HEALTH_GREEN
    hf = _HeaderFooter(
        title="HEALTH INSURANCE ACCIDENT INCIDENT REPORT",
        subtitle="SafeTrack AI — AI-Assisted Preliminary Documentation",
        report_id=report_id,
        accent_color=accent,
    )
    styles = _build_styles(accent)
    story = []

    # ── Extract sections ─────────────────────────────────────────────────────
    doc_info    = report_data.get("document_info", {})
    acc_sum     = report_data.get("accident_summary", {})
    obs         = report_data.get("observed_circumstances", {})
    injury      = report_data.get("injury_health_observations", {})
    timeline    = report_data.get("emergency_response_timeline", [])
    checklist   = report_data.get("health_insurance_checklist", {})
    evidence    = report_data.get("evidence_register", [])
    disclaimer  = _s(report_data.get("limitations_disclaimer", ""))

    # ══════════════ PAGE 1 ════════════════════════════════════════════════════

    # A. Document Information
    story.append(_section_header("A. DOCUMENT INFORMATION", styles["h1"], accent))
    story.append(Spacer(1, 4))
    story.append(_kv_table([
        ("Report ID",           _s(doc_info.get("report_id"))),
        ("Incident ID",         _s(doc_info.get("incident_id"))),
        ("Report Type",         _s(doc_info.get("report_type"))),
        ("Generation Date/Time",_s(doc_info.get("generation_timestamp"))),
        ("Status",              _s(doc_info.get("status"))),
        ("Source",              _s(doc_info.get("source"))),
    ]))
    story.append(Spacer(1, 8))

    # B. Accident Summary
    story.append(_section_header("B. ACCIDENT SUMMARY", styles["h1"], accent))
    story.append(Spacer(1, 4))
    story.append(_kv_table([
        ("Event Date/Time",     _s(acc_sum.get("event_date_time"))),
        ("Location",            _s(acc_sum.get("location"))),
        ("Detection Method",    _s(acc_sum.get("detection_method"))),
        ("Detection Confidence",_s(acc_sum.get("detection_confidence"))),
        ("Severity Estimate",   _s(acc_sum.get("severity_estimate"))),
    ]))
    story.append(Spacer(1, 4))
    story.append(Paragraph("<b>Incident Narrative:</b>", styles["label"]))
    story.append(Paragraph(_s(acc_sum.get("narrative")), styles["body"]))
    story.append(Spacer(1, 8))

    # C. Observed Circumstances
    story.append(_section_header("C. OBSERVED CIRCUMSTANCES", styles["h1"], accent))
    story.append(Spacer(1, 4))
    story.append(Paragraph("<b>Direct Observations</b> (supported by detection evidence):", styles["label"]))
    story.append(Paragraph(_s(obs.get("direct_observations")), styles["body"]))
    story.append(Spacer(1, 4))
    story.append(Paragraph("<b>Inferred Circumstances</b> (marked as unverified):", styles["label"]))
    story.append(Paragraph(_s(obs.get("inferred_circumstances")), styles["body"]))
    story.append(Spacer(1, 8))

    # D. Injury & Health Observations
    story.append(_section_header("D. INJURY AND HEALTH OBSERVATIONS", styles["h1"], accent))
    story.append(Spacer(1, 4))
    story.append(_kv_table([
        ("Visible Injury Indicators",  _s(injury.get("visible_injury_indicators"))),
        ("Assistance Required",        _s(injury.get("assistance_required"))),
        ("Medical Assistance Status",  _s(injury.get("medical_assistance_status"))),
        ("Ambulance Status",           _s(injury.get("ambulance_status"))),
        ("Additional Observations",    _s(injury.get("additional_observations"))),
    ]))

    # ══════════════ PAGE 2 ════════════════════════════════════════════════════
    story.append(PageBreak())

    # E. Emergency Response Timeline
    story.append(_section_header("E. EMERGENCY RESPONSE TIMELINE", styles["h1"], accent))
    story.append(Spacer(1, 4))
    if timeline:
        story.append(_timeline_table(timeline))
    else:
        story.append(Paragraph("No timeline data available.", styles["small"]))
    story.append(Spacer(1, 8))

    # F. Health Insurance Documentation Checklist
    story.append(_section_header("F. HEALTH INSURANCE DOCUMENTATION CHECKLIST", styles["h1"], accent))
    story.append(Spacer(1, 4))
    story.append(_checklist_table(checklist))
    story.append(Spacer(1, 8))

    # G. Supporting Evidence
    story.append(_section_header("G. SUPPORTING EVIDENCE REGISTER", styles["h1"], accent))
    story.append(Spacer(1, 4))
    if evidence:
        story.append(_evidence_table(evidence))
    else:
        story.append(Paragraph("No evidence records available.", styles["small"]))
    story.append(Spacer(1, 8))

    # H. Limitations and Disclaimer
    story.append(_section_header("H. LIMITATIONS AND VERIFICATION", styles["h1"], _WARN_AMBER))
    story.append(Spacer(1, 4))
    story.append(Paragraph(disclaimer, styles["disclaimer"]))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "Policyholder / Authorised Reviewer Signature: _______________________   Date: _______________",
        styles["body"]
    ))

    doc.build(story, onFirstPage=hf.on_page, onLaterPages=hf.on_page)
    return buf.getvalue()


# ── Motor Insurance PDF ────────────────────────────────────────────────────────

def generate_motor_insurance_pdf(report_data: dict, report_id: str) -> bytes:
    """
    Generate a professional Motor Vehicle Accident Insurance Claim Report PDF.

    Args:
        report_data: Structured dict from groq_service.generate_motor_insurance_content()
        report_id: Unique report identifier.

    Returns:
        PDF bytes.
    """
    if not REPORTLAB_AVAILABLE:
        raise RuntimeError("reportlab package is not installed. Run: pip install reportlab")

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=15 * mm,
        rightMargin=15 * mm,
        topMargin=32 * mm,
        bottomMargin=18 * mm,
    )

    accent = _MOTOR_RED
    hf = _HeaderFooter(
        title="MOTOR VEHICLE ACCIDENT INSURANCE CLAIM REPORT",
        subtitle="SafeTrack AI — AI-Assisted Preliminary Documentation",
        report_id=report_id,
        accent_color=accent,
    )
    styles = _build_styles(accent)
    story = []

    # ── Extract sections ─────────────────────────────────────────────────────
    doc_info  = report_data.get("document_info", {})
    overview  = report_data.get("incident_overview", {})
    vehicle   = report_data.get("vehicle_information", {})
    circ      = report_data.get("observed_accident_circumstances", {})
    damage    = report_data.get("vehicle_damage_observations", [])
    timeline  = report_data.get("incident_timeline", [])
    evidence  = report_data.get("evidence_register", [])
    checklist = report_data.get("motor_insurance_claim_checklist", [])
    disclaimer = _s(report_data.get("declaration_disclaimer", ""))

    # ══════════════ PAGE 1 ════════════════════════════════════════════════════

    # A. Document Information
    story.append(_section_header("A. DOCUMENT INFORMATION", styles["h1"], accent))
    story.append(Spacer(1, 4))
    story.append(_kv_table([
        ("Report ID",           _s(doc_info.get("report_id"))),
        ("Incident ID",         _s(doc_info.get("incident_id"))),
        ("Report Type",         _s(doc_info.get("report_type"))),
        ("Generation Date/Time",_s(doc_info.get("generation_timestamp"))),
        ("Status",              _s(doc_info.get("status"))),
        ("Source",              _s(doc_info.get("source"))),
    ]))
    story.append(Spacer(1, 8))

    # B. Incident Overview
    story.append(_section_header("B. INCIDENT OVERVIEW", styles["h1"], accent))
    story.append(Spacer(1, 4))
    story.append(_kv_table([
        ("Accident Date/Time",  _s(overview.get("accident_date_time"))),
        ("Accident Location",   _s(overview.get("accident_location"))),
        ("GPS Coordinates",     _s(overview.get("gps_coordinates"))),
        ("Maps Reference",      _s(overview.get("maps_reference"))),
        ("Video Identifier",    _s(overview.get("video_identifier"))),
        ("Detection Model",     _s(overview.get("detection_model"))),
        ("Confidence Score",    _s(overview.get("confidence_score"))),
        ("Severity Estimate",   _s(overview.get("severity_estimate"))),
    ]))
    story.append(Spacer(1, 4))
    story.append(Paragraph("<b>Incident Description:</b>", styles["label"]))
    story.append(Paragraph(_s(overview.get("incident_description")), styles["body"]))
    story.append(Spacer(1, 8))

    # C. Vehicle Information
    story.append(_section_header("C. VEHICLE INFORMATION", styles["h1"], accent))
    story.append(Spacer(1, 4))
    story.append(_kv_table([
        ("Vehicle Owner",           _s(vehicle.get("vehicle_owner"))),
        ("Registration Number",     _s(vehicle.get("registration_number"))),
        ("Vehicle Make / Model",    _s(vehicle.get("vehicle_make_model"))),
        ("Insurance Company",       _s(vehicle.get("insurance_company"))),
        ("Policy Number",           _s(vehicle.get("policy_number"))),
        ("Policy Validity",         _s(vehicle.get("policy_validity"))),
        ("Claim Number",            _s(vehicle.get("claim_number"))),
    ]))
    story.append(Spacer(1, 8))

    # D. Observed Circumstances
    story.append(_section_header("D. OBSERVED ACCIDENT CIRCUMSTANCES", styles["h1"], accent))
    story.append(Spacer(1, 4))
    story.append(Paragraph(_s(circ.get("description")), styles["body"]))
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        f"<b>Important Note:</b> {_s(circ.get('important_note'))}",
        styles["small"]
    ))

    # ══════════════ PAGE 2 ════════════════════════════════════════════════════
    story.append(PageBreak())

    # E. Vehicle Damage Observations
    story.append(_section_header("E. VEHICLE DAMAGE OBSERVATIONS", styles["h1"], accent))
    story.append(Spacer(1, 4))
    if damage:
        header = [["Vehicle / Component", "Visible Observation", "Evidence", "Assessment Status"]]
        data = header + [
            [_s(r.get("component")), _s(r.get("observation")),
             _s(r.get("evidence_available")), _s(r.get("assessment_status"))]
            for r in damage
        ]
        col_widths = [40 * mm, 55 * mm, 35 * mm, 40 * mm]
        t = Table(data, colWidths=col_widths, repeatRows=1)
        t.setStyle(TableStyle([
            ("BACKGROUND",  (0, 0), (-1, 0), _DARK_NAVY),
            ("TEXTCOLOR",   (0, 0), (-1, 0), _WHITE),
            ("FONTNAME",    (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE",    (0, 0), (-1, -1), 8),
            ("FONTNAME",    (0, 1), (-1, -1), "Helvetica"),
            ("TEXTCOLOR",   (0, 1), (-1, -1), _TEXT_DARK),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [_WHITE, _LIGHT_BG]),
            ("GRID",        (0, 0), (-1, -1), 0.5, _BORDER_GRAY),
            ("VALIGN",      (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING",  (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING",   (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING",(0, 0), (-1, -1), 4),
        ]))
        story.append(t)
    else:
        story.append(Paragraph(
            "Vehicle damage observations require physical inspection. No video-derived damage data available.",
            styles["small"]
        ))
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        "Note: A physical inspection by a qualified assessor is required for an authoritative damage assessment. "
        "No repair costs, replacement values, or hidden damage should be assumed from this report alone.",
        styles["small"]
    ))
    story.append(Spacer(1, 8))

    # F. Incident Timeline
    story.append(_section_header("F. INCIDENT TIMELINE", styles["h1"], accent))
    story.append(Spacer(1, 4))
    if timeline:
        story.append(_timeline_table(timeline))
    else:
        story.append(Paragraph("No timeline data available.", styles["small"]))
    story.append(Spacer(1, 8))

    # G. Evidence Register
    story.append(_section_header("G. EVIDENCE REGISTER", styles["h1"], accent))
    story.append(Spacer(1, 4))
    if evidence:
        story.append(_evidence_table(evidence))
    else:
        story.append(Paragraph("No evidence records available.", styles["small"]))
    story.append(Spacer(1, 8))

    # H. Motor Insurance Claim Checklist
    story.append(_section_header("H. MOTOR INSURANCE CLAIM CHECKLIST", styles["h1"], accent))
    story.append(Spacer(1, 4))
    story.append(_checklist_table(checklist))
    story.append(Spacer(1, 8))

    # I. Declaration & Disclaimer
    story.append(_section_header("I. DECLARATION AND LIMITATIONS", styles["h1"], _WARN_AMBER))
    story.append(Spacer(1, 4))
    story.append(Paragraph(disclaimer, styles["disclaimer"]))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "Claimant Signature: _______________________   Date: _______________   "
        "Insurer Reference: _______________",
        styles["body"]
    ))

    doc.build(story, onFirstPage=hf.on_page, onLaterPages=hf.on_page)
    return buf.getvalue()


# ── Page count verification ────────────────────────────────────────────────────

def count_pdf_pages(pdf_bytes: bytes) -> int:
    """Count pages in a PDF by counting /Page objects."""
    import re
    count = len(re.findall(rb"/Type\s*/Page[^s]", pdf_bytes))
    return count
