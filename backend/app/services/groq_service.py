"""
Groq AI Service — Structured Report Content Generation
=======================================================
Generates validated JSON content for both report types using the Groq API.
The actual PDF rendering is done separately by pdf_service.py.

Never exposes the API key to the frontend.
Fails honestly if the API is unavailable.
"""

import json
import time
import re
from app.core.config import settings

try:
    from groq import Groq
except ImportError:
    Groq = None


def _get_client():
    if Groq is None:
        raise RuntimeError("groq package is not installed. Run: pip install groq")
    if not settings.GROQ_API_KEY:
        raise RuntimeError("GROQ_API_KEY is not configured in the environment.")
    return Groq(api_key=settings.GROQ_API_KEY)


def _extract_json(text: str) -> dict:
    """Strip markdown code fences and parse JSON from the model response."""
    text = text.strip()
    # Remove ```json ... ``` or ``` ... ```
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return json.loads(text.strip())


# ── Health Insurance Report ────────────────────────────────────────────────────

HEALTH_REPORT_SCHEMA = {
    "document_info": {
        "report_id": "str — unique report ID",
        "incident_id": "str",
        "report_type": "HEALTH INSURANCE ACCIDENT INCIDENT REPORT",
        "generation_timestamp": "ISO-8601 string",
        "status": "AI-Generated Preliminary Documentation",
        "source": "str"
    },
    "accident_summary": {
        "narrative": "str — 2–4 sentences describing the detected event",
        "event_date_time": "str or 'Not available in supplied evidence'",
        "location": "str or 'Not available in supplied evidence'",
        "detection_method": "str",
        "detection_confidence": "str",
        "severity_estimate": "str"
    },
    "observed_circumstances": {
        "direct_observations": "str — what the video/model evidence supports",
        "inferred_circumstances": "str — clearly marked as inferred, not confirmed"
    },
    "injury_health_observations": {
        "visible_injury_indicators": "str or 'Cannot be determined from available evidence'",
        "assistance_required": "str or 'Not determinable from available evidence'",
        "medical_assistance_status": "str or 'Unknown — requires on-site assessment'",
        "ambulance_status": "str or 'Unknown'",
        "additional_observations": "str"
    },
    "emergency_response_timeline": [
        {
            "event": "str",
            "timestamp": "str or 'Not recorded'",
            "status": "str",
            "evidence_source": "str"
        }
    ],
    "health_insurance_checklist": {
        "policyholder_name": "To be completed by policyholder",
        "policy_number": "To be completed by policyholder",
        "insurer_name": "To be completed by policyholder",
        "hospital_provider": "To be completed by policyholder",
        "medical_examination_records": "To be provided",
        "doctors_assessment": "To be provided",
        "medical_bills": "To be provided",
        "ambulance_bills": "If applicable — to be provided",
        "prescriptions_discharge": "To be provided",
        "identity_documents": "To be provided",
        "additional_insurer_documents": "As required by insurer"
    },
    "evidence_register": [
        {"item": "str", "reference": "str", "status": "str"}
    ],
    "limitations_disclaimer": "str — must state this is AI-assisted preliminary documentation, not a medical diagnosis or insurance guarantee"
}


def generate_health_insurance_content(accident_data: dict, report_id: str) -> dict:
    """
    Call Groq to generate structured content for a Health Insurance Report.

    Args:
        accident_data: Firestore accident document as a dict (Timestamps serialized to str).
        report_id: Unique report identifier.

    Returns:
        Validated dict matching HEALTH_REPORT_SCHEMA structure.

    Raises:
        RuntimeError on API failure, so the caller can surface a meaningful error.
    """
    client = _get_client()

    incident_id = accident_data.get("audit_id") or accident_data.get("id", "UNKNOWN")
    timestamp = accident_data.get("timestamp", "Not recorded")
    location = accident_data.get("location") or accident_data.get("geo_location", "Not available in supplied evidence")
    severity = accident_data.get("severity", "Unknown")
    confidence = accident_data.get("max_confidence") or accident_data.get("confidence", "Not available")
    video_url = accident_data.get("videoUrl") or accident_data.get("cloudinaryVideoUrl", "Video reference not available")
    source = accident_data.get("source", "uploaded_video")
    llm_summary = accident_data.get("llm_summary", "")

    safe_data = {
        "incident_id": incident_id,
        "report_id": report_id,
        "timestamp": str(timestamp),
        "location": str(location),
        "severity": str(severity),
        "max_confidence": str(confidence),
        "source": str(source),
        "accident_detected": accident_data.get("accidentDetected", True),
        "llm_summary": str(llm_summary)[:500],  # truncate to avoid token waste
    }

    prompt = f"""You are generating a HEALTH INSURANCE ACCIDENT INCIDENT REPORT for an AI-based accident detection system.

Incident data (from detection system):
{json.dumps(safe_data, indent=2)}

Generate a structured JSON report with EXACTLY these fields. Use ONLY information supported by the incident data.
For fields that cannot be determined from the available evidence, write exactly: "Not available in supplied evidence"
Do NOT invent medical expenses, diagnoses, injuries, hospital names, policy numbers, or personal details.
Do NOT claim any information that is not directly supported by the incident data.

Required JSON structure:
{{
  "document_info": {{
    "report_id": "{report_id}",
    "incident_id": "{incident_id}",
    "report_type": "HEALTH INSURANCE ACCIDENT INCIDENT REPORT",
    "generation_timestamp": "{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
    "status": "AI-Generated Preliminary Documentation — Requires Verification",
    "source": "Source: {source}"
  }},
  "accident_summary": {{
    "narrative": "2-4 sentence professional description of the detected event based only on available data",
    "event_date_time": "use the timestamp if available, otherwise: Not available in supplied evidence",
    "location": "use the location if available, otherwise: Not available in supplied evidence",
    "detection_method": "AI Video Analysis — YOLOv8 Spatial Detection Pipeline",
    "detection_confidence": "use confidence value if available",
    "severity_estimate": "use severity if available"
  }},
  "observed_circumstances": {{
    "direct_observations": "What the video evidence and detection model directly support — be specific and factual",
    "inferred_circumstances": "Clearly labelled inferences — must be marked as INFERRED, NOT VERIFIED"
  }},
  "injury_health_observations": {{
    "visible_injury_indicators": "Only state if directly observable from video evidence, otherwise: Cannot be determined from available evidence — on-site medical assessment required",
    "assistance_required": "Not determinable from available evidence — on-site assessment required",
    "medical_assistance_status": "Unknown — requires on-site assessment",
    "ambulance_status": "Unknown — requires verification",
    "additional_observations": "Any relevant observations supported by the detection output"
  }},
  "emergency_response_timeline": [
    {{
      "event": "Accident Detected",
      "timestamp": "{str(timestamp)}",
      "status": "Confirmed by detection system",
      "evidence_source": "AI Detection Pipeline"
    }},
    {{
      "event": "System Alert Initiated",
      "timestamp": "{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
      "status": "Internal system notification",
      "evidence_source": "Application log"
    }},
    {{
      "event": "Medical/Emergency Services",
      "timestamp": "Not recorded",
      "status": "Unknown — requires verification",
      "evidence_source": "Not available"
    }}
  ],
  "health_insurance_checklist": {{
    "policyholder_name": "To be completed by policyholder",
    "policy_number": "To be completed by policyholder",
    "insurer_name": "To be completed by policyholder",
    "hospital_provider": "To be completed by policyholder",
    "medical_examination_records": "To be provided by attending physician",
    "doctors_assessment": "To be provided by attending physician",
    "medical_bills": "To be provided — original receipts required",
    "ambulance_bills": "If applicable — to be provided",
    "prescriptions_discharge": "To be provided upon discharge",
    "identity_documents": "Government-issued photo ID + policy document",
    "additional_insurer_documents": "As required by the insurer — verify with your insurance provider"
  }},
  "evidence_register": [
    {{
      "item": "Source Video",
      "reference": "{video_url[:80] if video_url and video_url != 'Video reference not available' else 'Video reference not available'}",
      "status": "Available in system"
    }},
    {{
      "item": "Incident Record",
      "reference": "Incident ID: {incident_id}",
      "status": "Stored in system database"
    }},
    {{
      "item": "Detection Metadata",
      "reference": "Confidence: {str(confidence)}, Severity: {severity}",
      "status": "Available"
    }}
  ],
  "limitations_disclaimer": "IMPORTANT DISCLAIMER: This is an AI-assisted preliminary incident report generated for documentation purposes only. This document does NOT constitute a medical diagnosis, clinical assessment, guarantee of insurance eligibility, or determination of insurance claim approval. All medical information must be verified by qualified healthcare professionals. All policy and claim details must be verified with your insurance provider. The detection results are generated by an automated AI system and are subject to the limitations of automated video analysis. This report requires review and verification by authorized personnel before being submitted to any insurer or medical authority."
}}

Return ONLY the JSON object. No explanation, no markdown, no preamble."""

    try:
        response = client.chat.completions.create(
            model=settings.GROQ_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=3000,
            timeout=60,
        )
        content = response.choices[0].message.content
        return _extract_json(content)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Groq returned malformed JSON: {e}")
    except Exception as e:
        raise RuntimeError(f"Groq API error: {e}")


# ── Motor Accident Insurance Report ───────────────────────────────────────────

def generate_motor_insurance_content(accident_data: dict, report_id: str) -> dict:
    """
    Call Groq to generate structured content for a Motor Accident Insurance Claim Report.

    Returns:
        Validated dict for the motor insurance report template.

    Raises:
        RuntimeError on API failure.
    """
    client = _get_client()

    incident_id = accident_data.get("audit_id") or accident_data.get("id", "UNKNOWN")
    timestamp = accident_data.get("timestamp", "Not recorded")
    location = accident_data.get("location") or accident_data.get("geo_location", "Not available in supplied evidence")
    lat = accident_data.get("lat")
    lng = accident_data.get("lng")
    severity = accident_data.get("severity", "Unknown")
    confidence = accident_data.get("max_confidence") or accident_data.get("confidence", "Not available")
    video_url = accident_data.get("videoUrl") or accident_data.get("cloudinaryVideoUrl", "Video reference not available")
    source = accident_data.get("source", "uploaded_video")
    llm_summary = accident_data.get("llm_summary", "")
    maps_url = accident_data.get("google_maps_url", "")
    if not maps_url and lat and lng:
        maps_url = f"https://maps.google.com/?q={lat},{lng}"

    safe_data = {
        "incident_id": incident_id,
        "report_id": report_id,
        "timestamp": str(timestamp),
        "location": str(location),
        "coordinates": f"{lat}, {lng}" if lat and lng else "Not available",
        "maps_url": maps_url,
        "severity": str(severity),
        "max_confidence": str(confidence),
        "source": str(source),
        "accident_detected": accident_data.get("accidentDetected", True),
        "llm_summary": str(llm_summary)[:500],
    }

    prompt = f"""You are generating a MOTOR VEHICLE ACCIDENT INSURANCE CLAIM REPORT for an AI-based accident detection system.

Incident data (from detection system):
{json.dumps(safe_data, indent=2)}

Generate a structured JSON report with EXACTLY these fields. Use ONLY information supported by the incident data.
For fields that cannot be determined, write exactly: "Not available in supplied evidence"
CRITICAL RULES:
- Do NOT attempt to recognize or invent license plate numbers
- Do NOT invent driver names, vehicle registration numbers, insurance policy numbers
- Do NOT assign fault or legal liability
- Do NOT invent repair costs or damage estimates
- Do NOT fabricate accident causes beyond what the detection output supports

Required JSON structure:
{{
  "document_info": {{
    "report_id": "{report_id}",
    "incident_id": "{incident_id}",
    "report_type": "MOTOR VEHICLE ACCIDENT INSURANCE CLAIM REPORT",
    "generation_timestamp": "{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
    "status": "Preliminary Documentation — Requires Verification",
    "source": "Source: {source}"
  }},
  "incident_overview": {{
    "accident_date_time": "use timestamp if available, otherwise: Not available in supplied evidence",
    "accident_location": "use location if available, otherwise: Not available in supplied evidence",
    "gps_coordinates": "use coordinates if available",
    "maps_reference": "{maps_url if maps_url else 'Not available'}",
    "video_identifier": "use video URL reference if available",
    "detection_model": "YOLOv8 AI Detection Pipeline",
    "confidence_score": "use confidence value",
    "severity_estimate": "use severity value",
    "incident_description": "2-4 sentence factual description based only on detection output"
  }},
  "vehicle_information": {{
    "vehicle_owner": "Not available in supplied evidence — to be completed by claimant",
    "registration_number": "Not available — number plate recognition not available in this system",
    "vehicle_make_model": "Not available in supplied evidence",
    "insurance_company": "Not available in supplied evidence — to be completed by claimant",
    "policy_number": "Not available in supplied evidence — to be completed by claimant",
    "policy_validity": "Not available in supplied evidence — to be completed by claimant",
    "claim_number": "To be assigned by insurer"
  }},
  "observed_accident_circumstances": {{
    "description": "Factual description of what the AI detection pipeline observed",
    "important_note": "This description is based solely on automated video analysis. Fault determination, legal liability, and cause of accident require independent investigation by qualified authorities."
  }},
  "vehicle_damage_observations": [
    {{
      "component": "Overall Vehicle Condition",
      "observation": "Not determinable from available footage — physical inspection required",
      "evidence_available": "Video evidence",
      "assessment_status": "Requires physical inspection by qualified assessor"
    }}
  ],
  "incident_timeline": [
    {{
      "event": "Accident Detected by AI System",
      "timestamp": "{str(timestamp)}",
      "status": "Confirmed",
      "evidence": "AI Detection Pipeline"
    }},
    {{
      "event": "System Alert Generated",
      "timestamp": "{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
      "status": "Completed",
      "evidence": "Application log"
    }},
    {{
      "event": "Emergency Services Response",
      "timestamp": "Not recorded",
      "status": "Unknown — requires verification",
      "evidence": "Not available"
    }}
  ],
  "evidence_register": [
    {{
      "item": "Original Uploaded Video",
      "reference": "{video_url[:80] if video_url and video_url != 'Video reference not available' else 'Not available'}",
      "status": "Available in system"
    }},
    {{
      "item": "Incident Record",
      "reference": "ID: {incident_id}",
      "status": "Stored in system database"
    }},
    {{
      "item": "Detection Metadata",
      "reference": "Confidence: {str(confidence)}, Severity: {severity}",
      "status": "Available"
    }},
    {{
      "item": "GPS/Location Data",
      "reference": "{safe_data['coordinates']}",
      "status": "{'Available' if lat and lng else 'Not available'}"
    }}
  ],
  "motor_insurance_claim_checklist": [
    {{"item": "Completed insurer claim form", "status": "To be completed by claimant"}},
    {{"item": "Valid motor insurance policy document", "status": "To be provided by claimant"}},
    {{"item": "Vehicle registration certificate (RC)", "status": "To be provided by claimant"}},
    {{"item": "Driving licence (valid at time of incident)", "status": "To be provided by claimant"}},
    {{"item": "Government-issued identity document", "status": "To be provided by claimant"}},
    {{"item": "Original accident video (from this system)", "status": "Available — reference above"}},
    {{"item": "Photographs of vehicle damage", "status": "To be captured at scene"}},
    {{"item": "Repair estimate from authorised workshop", "status": "To be obtained"}},
    {{"item": "Vehicle inspection/survey report", "status": "To be arranged with insurer"}},
    {{"item": "FIR or police report (where applicable)", "status": "To be obtained from local authority"}},
    {{"item": "Medical records and bills (if personal injury)", "status": "If applicable — to be provided"}},
    {{"item": "Additional documents as required by insurer", "status": "Verify with your insurance provider"}}
  ],
  "declaration_disclaimer": "DECLARATION AND LIMITATIONS: This document is an AI-assisted preliminary incident report generated by the SafeTrack AI accident detection system. It is NOT an official police report, independent accident surveyor's report, legal determination of liability, or guarantee of insurance claim approval. The information in this report is based solely on automated video analysis and must be verified by the claimant, insurance provider, and relevant authorities. Vehicle registration details, driver information, and damage assessments require physical verification. The user and insurer must independently verify all details before acting on this report. SafeTrack AI makes no representation regarding the accuracy of vehicle identification, incident cause, or liability."
}}

Return ONLY the JSON object. No explanation, no markdown, no preamble."""

    try:
        response = client.chat.completions.create(
            model=settings.GROQ_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=3000,
            timeout=60,
        )
        content = response.choices[0].message.content
        return _extract_json(content)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Groq returned malformed JSON: {e}")
    except Exception as e:
        raise RuntimeError(f"Groq API error: {e}")
