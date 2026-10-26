import { auth } from './services/firebase';

const BASE_URL = `${import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'}/api`;

async function parseApiError(response, fallbackMessage) {
    try {
        const data = await response.json();
        return data?.detail || fallbackMessage;
    } catch {
        return fallbackMessage;
    }
}

const NETWORK_ERROR = 'Cannot reach the backend. Make sure FastAPI is running on port 8000.';

// Helper to get auth headers
const getHeaders = (token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
};

export const api = {
    detectAccident: async (videoUrl, token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/video/detect`, {
                method: 'POST',
                headers: getHeaders(token),
                body: JSON.stringify({ video_url: videoUrl }),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }

        if (!response.ok) {
            const detail = await parseApiError(response, 'Detection failed');
            throw new Error(detail);
        }
        return response.json();
    },

    getIncidents: async (token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/report/incidents`, {
                headers: getHeaders(token),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) throw new Error('Failed to fetch incidents');
        return response.json();
    },

    dispatchSOS: async (payload, token = null) => {
        let response;

        if (!token) {
            const currentUser = auth.currentUser;
            if (!currentUser) {
                throw new Error('User must be logged in to dispatch SOS');
            }
            token = await currentUser.getIdToken(true);
        }

        try {
            response = await fetch(`${BASE_URL}/sos/dispatch`, {
                method: 'POST',
                headers: getHeaders(token),
                body: JSON.stringify(payload),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }

        if (!response.ok) {
            const detail = await parseApiError(response, 'Failed to dispatch SOS');
            throw new Error(detail);
        }
        return response.json();
    },

    getEmergencyContacts: async (token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/user/contacts`, {
                headers: getHeaders(token),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }

        if (!response.ok) {
            const detail = await parseApiError(response, 'Failed to fetch contacts');
            throw new Error(detail);
        }
        return response.json();
    },

    saveEmergencyContacts: async (contacts, token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/user/contacts`, {
                method: 'PUT',
                headers: getHeaders(token),
                body: JSON.stringify({ contacts }),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }

        if (!response.ok) {
            const detail = await parseApiError(response, 'Failed to save contacts');
            throw new Error(detail);
        }
        return response.json();
    },

    getFleetSegmentation: async () => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/fleet/segmentation`);
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) throw new Error("Fleet segmentation failed");
        return response.json();
    },

    generateNarrative: async (events, incidentId) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/generate-narrative`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ events, incident_id: incidentId }),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) throw new Error("Narrative generation failed");
        return response.json();
    },

    // ── PDF Report Generation ─────────────────────────────────────────────────

    generateHealthInsuranceReport: async (incidentId, token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/reports/health-insurance/${encodeURIComponent(incidentId)}`, {
                method: 'POST',
                headers: getHeaders(token),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) {
            const detail = await parseApiError(response, 'Health insurance report generation failed');
            throw new Error(detail);
        }
        return response.json();
    },

    generateMotorInsuranceReport: async (incidentId, token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/reports/motor-insurance/${encodeURIComponent(incidentId)}`, {
                method: 'POST',
                headers: getHeaders(token),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) {
            const detail = await parseApiError(response, 'Motor insurance report generation failed');
            throw new Error(detail);
        }
        return response.json();
    },

    downloadReport: async (reportId, token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/reports/${encodeURIComponent(reportId)}/download`, {
                headers: getHeaders(token),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) {
            const detail = await parseApiError(response, 'Download failed');
            throw new Error(detail);
        }
        return response.blob();
    },

    listMyReports: async (token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/reports`, {
                headers: getHeaders(token),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) {
            const detail = await parseApiError(response, 'Failed to fetch reports');
            throw new Error(detail);
        }
        return response.json();
    },

    // ── Super Admin ───────────────────────────────────────────────────────────

    initSuperAdmin: async (token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/admin/init-super-admin`, {
                method: 'POST',
                headers: getHeaders(token),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) {
            const detail = await parseApiError(response, 'Admin initialization failed');
            throw new Error(detail);
        }
        return response.json();
    },

    adminGetStats: async (token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/admin/stats`, {
                headers: getHeaders(token),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) {
            const detail = await parseApiError(response, 'Failed to fetch stats');
            throw new Error(detail);
        }
        return response.json();
    },

    adminGetIncidents: async (token, params = {}) => {
        const query = new URLSearchParams(params).toString();
        let response;
        try {
            response = await fetch(`${BASE_URL}/admin/incidents${query ? '?' + query : ''}`, {
                headers: getHeaders(token),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) {
            const detail = await parseApiError(response, 'Failed to fetch admin incidents');
            throw new Error(detail);
        }
        return response.json();
    },

    adminGetIncident: async (incidentId, token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/admin/incidents/${encodeURIComponent(incidentId)}`, {
                headers: getHeaders(token),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) {
            const detail = await parseApiError(response, 'Failed to fetch incident');
            throw new Error(detail);
        }
        return response.json();
    },

    adminUpdateIncidentStatus: async (incidentId, status, token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/admin/incidents/${encodeURIComponent(incidentId)}/status`, {
                method: 'PATCH',
                headers: getHeaders(token),
                body: JSON.stringify({ status }),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) {
            const detail = await parseApiError(response, 'Status update failed');
            throw new Error(detail);
        }
        return response.json();
    },

    adminNotifyAuthorities: async (incidentId, token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/admin/incidents/${encodeURIComponent(incidentId)}/notify-authorities`, {
                method: 'POST',
                headers: getHeaders(token),
                body: JSON.stringify({ confirm: true }),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) {
            const detail = await parseApiError(response, 'Authority notification failed');
            throw new Error(detail);
        }
        return response.json();
    },

    adminGetAllReports: async (token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/admin/all-reports`, {
                headers: getHeaders(token),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) {
            const detail = await parseApiError(response, 'Failed to fetch reports');
            throw new Error(detail);
        }
        return response.json();
    },

    adminGetAnalytics: async (token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/admin/analytics`, {
                headers: getHeaders(token),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) {
            const detail = await parseApiError(response, 'Failed to fetch analytics');
            throw new Error(detail);
        }
        return response.json();
    },

    adminExportCSV: async (token) => {
        let response;
        try {
            response = await fetch(`${BASE_URL}/admin/analytics?export_csv=true`, {
                headers: getHeaders(token),
            });
        } catch {
            throw new Error(NETWORK_ERROR);
        }
        if (!response.ok) throw new Error('CSV export failed');
        return response.blob();
    },
};
