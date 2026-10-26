import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { UploadCloud, FileVideo, CheckCircle2, X, AlertCircle, ShieldAlert } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { uploadVideoToCloudinary } from "@/services/cloudinary";
import { api } from "@/api";
import { queueVideoForSync } from "@/services/offlineSync";
import { useGeolocation } from "@/hooks/useGeolocation";
import EmergencyModal from "@/components/EmergencyModal";
import FirstResponderModal from "@/components/FirstResponderModal";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/services/firebase";

export default function VideoUpload() {
  const { getFreshToken, user } = useAuth();
  const { coordinates, locationError, requestLocation } = useGeolocation();
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [status, setStatus] = useState("idle"); // idle, uploading, success, error
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [offlineBanner, setOfflineBanner] = useState("");
  const [locationWarning, setLocationWarning] = useState("");
  const [sosModalOpen, setSosModalOpen] = useState(false);
  const [sosDispatching, setSosDispatching] = useState(false);
  const [lastUploadedVideoUrl, setLastUploadedVideoUrl] = useState("");
  const [handledAnalysisId, setHandledAnalysisId] = useState(null);
  const [firstResponderOpen, setFirstResponderOpen] = useState(false);
  const [insuranceReports, setInsuranceReports] = useState({});

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleFileSelect = (selectedFile) => {
    // Basic validation for video files
    if (selectedFile.type.startsWith("video/")) {
      setFile(selectedFile);
      setStatus("idle");
      setUploadProgress(0);
      setAnalysisResult(null);
      setErrorMessage("");
      setOfflineBanner("");
      setLocationWarning("");
      setInsuranceReports({});
    } else {
      setStatus("error");
      setErrorMessage("Invalid file format. Please upload a valid video file.");
    }
  };

  const normalizeAnalysis = (raw) => {
    const detected = Boolean(raw?.accident ?? raw?.accidentDetected ?? raw?.crash_detected ?? false);
    const confidenceRaw = raw?.confidence ?? raw?.yolo_confidence ?? raw?.score ?? null;
    const confidence = typeof confidenceRaw === "number"
      ? (confidenceRaw <= 1 ? confidenceRaw * 100 : confidenceRaw)
      : null;
      
    // Default summary
    let reportSummary = raw?.message || "Analysis completed.";
    if (raw?.report) {
        if (typeof raw.report === 'object' && raw.report.summary) {
            reportSummary = raw.report.summary;
        } else if (typeof raw.report === 'string') {
            reportSummary = raw.report;
        }
    }

    return {
      raw,
      detected,
      confidence,
      reportText: reportSummary,
      fullReportJson: raw?.report || null,
      incidentId: raw?.incident_id || raw?.accident_id || null,
      severity: raw?.severity || "UNKNOWN",
      analysisId: Date.now(),
    };
  };

  const generateInsuranceReport = async (reportType) => {
    if (!analysisResult?.incidentId || !analysisResult.detected) return;

    setInsuranceReports((current) => ({
      ...current,
      [reportType]: { status: "generating", error: "" },
    }));

    try {
      const token = await getFreshToken();
      if (!token) {
        throw new Error("Your session expired. Please log in again.");
      }

      const generate = reportType === "health"
        ? api.generateHealthInsuranceReport
        : api.generateMotorInsuranceReport;
      const report = await generate(analysisResult.incidentId, token);

      setInsuranceReports((current) => ({
        ...current,
        [reportType]: {
          status: "ready",
          reportId: report.report_id,
          filename: report.filename,
          pageCount: report.page_count,
          message: report.status === "already_exists"
            ? "A report was already generated for this incident."
            : "Report generated successfully.",
          error: "",
        },
      }));
    } catch (error) {
      setInsuranceReports((current) => ({
        ...current,
        [reportType]: { status: "error", error: error.message || "Report generation failed." },
      }));
    }
  };

  const downloadInsuranceReport = async (reportType) => {
    const report = insuranceReports[reportType];
    if (!report?.reportId) return;

    setInsuranceReports((current) => ({
      ...current,
      [reportType]: { ...current[reportType], status: "downloading", error: "" },
    }));

    try {
      const token = await getFreshToken();
      if (!token) {
        throw new Error("Your session expired. Please log in again.");
      }

      const pdf = await api.downloadReport(report.reportId, token);
      const url = URL.createObjectURL(pdf);
      const link = document.createElement("a");
      link.href = url;
      link.download = report.filename || `${report.reportId}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);

      setInsuranceReports((current) => ({
        ...current,
        [reportType]: { ...current[reportType], status: "ready" },
      }));
    } catch (error) {
      setInsuranceReports((current) => ({
        ...current,
        [reportType]: {
          ...current[reportType],
          status: "ready",
          error: error.message || "Report download failed.",
        },
      }));
    }
  };

  const handleUploadAndAnalyze = async () => {
    if (!file) return;

    setErrorMessage("");
    setAnalysisResult(null);
    setStatus("uploading");
    setIsAnalyzing(true);
    setUploadProgress(0);
    setOfflineBanner("");

    try {
      const token = await getFreshToken();

      if (!navigator.onLine) {
        await queueVideoForSync({
          fileBlob: file,
          fileName: file.name,
          fileType: file.type,
          token,
          userId: user?.uid || null,
        });

        setStatus("success");
        setUploadProgress(100);
        setOfflineBanner("Offline Mode: Footage saved locally. Will auto-sync when connection is restored.");
        return;
      }

      setUploadProgress(15);
      if (!token) {
        throw new Error("Your session expired. Please login again.");
      }

      setUploadProgress(45);
      const cloudinaryUrl = await uploadVideoToCloudinary(file);
      setLastUploadedVideoUrl(cloudinaryUrl);

      setUploadProgress(75);
      const detectionResponse = await api.detectAccident(cloudinaryUrl, token);

      setUploadProgress(100);
      setStatus("success");
      setAnalysisResult(normalizeAnalysis(detectionResponse));
    } catch (error) {
      setStatus("error");
      setUploadProgress(0);
      setErrorMessage(error?.message || "Upload/analysis failed. Please try again.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const clearSelection = () => {
    setFile(null);
    setStatus("idle");
    setUploadProgress(0);
    setIsAnalyzing(false);
    setAnalysisResult(null);
    setErrorMessage("");
    setOfflineBanner("");
    setLocationWarning("");
    setSosModalOpen(false);
    setLastUploadedVideoUrl("");
    setFirstResponderOpen(false);
    setInsuranceReports({});
  };

  const dispatchEmergencySOS = async (cloudinaryVideoUrl = lastUploadedVideoUrl, userCoordinates = coordinates) => {
    if (sosDispatching) return;

    try {
      setSosDispatching(true);
      const token = await getFreshToken();

      const userRef = user?.uid ? doc(db, "users", user.uid) : null;
      let emergencyContacts = [];

      if (userRef) {
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
          emergencyContacts = userSnap.data()?.contacts || [];
        }
      }

      if (!emergencyContacts.length) {
        setLocationWarning("No emergency contacts saved. Please add contacts in Settings before dispatching SOS.");
        setSosModalOpen(false);
        return;
      }

      await api.dispatchSOS(
        {
          userId: user?.uid || null,
          coordinates: userCoordinates || null,
          severity: analysisResult?.severity || "UNKNOWN",
          cloudinaryVideoUrl: cloudinaryVideoUrl || null,
          target_phone_numbers: emergencyContacts,
        },
        token
      );

      setSosModalOpen(false);
      setErrorMessage("");
      setOfflineBanner("Emergency SOS has been dispatched successfully.");
    } catch (error) {
      setErrorMessage(error?.message || "Failed to dispatch SOS.");
    } finally {
      setSosDispatching(false);
    }
  };

  useEffect(() => {
    if (!analysisResult) return;
    if (handledAnalysisId === analysisResult.analysisId) return;

    console.log("Backend returned exact severity string:", analysisResult.severity);

    const severityLevel = analysisResult.severity?.toUpperCase() || "";
    if (["CRITICAL", "HIGH", "SEVERE", "SEVERE RISK"].includes(severityLevel)) {
      // Show the First Responder Guide specifically for CRITICAL events
      if (severityLevel === "CRITICAL") {
        setFirstResponderOpen(true);
      }

      const fireEmergency = async () => {
        const locationData = coordinates ? { coordinates } : await requestLocation();

        if (locationData.error) {
          setLocationWarning(locationData.error);
        }

        setHandledAnalysisId(analysisResult.analysisId);
        console.log("Crash detected! Executing SOS sequence...");
        await dispatchEmergencySOS(lastUploadedVideoUrl, locationData.coordinates || coordinates || null);
      };

      fireEmergency();
    }
  }, [analysisResult, handledAnalysisId, requestLocation]);

  useEffect(() => {
    if (locationError) {
      setLocationWarning(locationError);
    }
  }, [locationError]);

  return (
    <div className="flex flex-col gap-8 max-w-4xl mx-auto h-full">
      <FirstResponderModal
        open={firstResponderOpen}
        onDismiss={() => setFirstResponderOpen(false)}
      />
      <EmergencyModal
        open={sosModalOpen}
        onCancel={() => setSosModalOpen(false)}
        onDispatch={() => dispatchEmergencySOS(lastUploadedVideoUrl, coordinates)}
        initialSeconds={10}
      />

      <div>
        <h2 className="text-3xl font-bold tracking-tight text-white">Upload Footage</h2>
        <p className="text-zinc-400 mt-1">Submit recorded dashcam videos for YOLOv8 batch processing and severity analysis.</p>
      </div>

      {offlineBanner && (
        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200">
          {offlineBanner}
        </div>
      )}

      {locationWarning && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {locationWarning}
        </div>
      )}

      <Card className="glass-card border border-white/10 bg-black/30">
        <CardHeader>
          <CardTitle className="text-white">Video Ingestion</CardTitle>
          <CardDescription className="text-zinc-400">Supported formats: MP4, AVI, MKV. Maximum file size: 500MB.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          
          {/* Drag & Drop Zone */}
          {!file && (
            <div
              className={`border-2 border-dashed rounded-xl p-12 flex flex-col items-center justify-center transition-colors cursor-pointer ${
                isDragging ? "border-white/50 bg-white/10" : "border-white/20 bg-zinc-900/40 hover:bg-zinc-900/60"
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => document.getElementById("file-upload").click()}
            >
              <UploadCloud className={`h-12 w-12 mb-4 ${isDragging ? "text-white" : "text-zinc-400"}`} />
              <p className="text-sm font-medium text-white mb-1">
                Drag and drop your video file here
              </p>
              <p className="text-xs text-zinc-500 mb-4">or click to browse your files</p>
              <Button variant="outline" className="pointer-events-none border-white/20 text-zinc-100">Select File</Button>
              <input 
                id="file-upload" 
                type="file" 
                accept="video/*" 
                className="hidden" 
                onChange={(e) => e.target.files && handleFileSelect(e.target.files[0])}
              />
            </div>
          )}

          {/* Error State */}
          {status === "error" && (
            <div className="p-4 rounded-md border border-red-500/30 bg-red-500/10 flex items-center gap-3 text-red-300 text-sm">
              <AlertCircle className="h-5 w-5" />
              <span>{errorMessage || "Upload failed. Please try again."}</span>
            </div>
          )}

          {/* File Selected / Uploading State */}
          {file && status !== "error" && (
            <div className="border border-white/10 rounded-xl p-6 bg-zinc-900/40 shadow-sm flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="h-12 w-12 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-100">
                    <FileVideo className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white truncate max-w-50 sm:max-w-xs">{file.name}</p>
                    <p className="text-xs text-zinc-400">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                  </div>
                </div>
                {status === "idle" && (
                  <Button variant="ghost" size="icon" onClick={clearSelection}>
                    <X className="h-4 w-4 text-zinc-400" />
                  </Button>
                )}
              </div>

              {(status === "uploading" || isAnalyzing) && (
                <div className="space-y-2 mt-2">
                  <div className="flex justify-between text-xs text-zinc-300 font-medium">
                    <span>{uploadProgress < 60 ? "Uploading to Cloudinary..." : "Analyzing with backend AI..."}</span>
                    <span>{uploadProgress}%</span>
                  </div>
                  <Progress value={uploadProgress} className="h-2" />
                </div>
              )}

              {status === "success" && (
                <div className="p-3 rounded-md bg-green-500/10 flex items-center gap-2 text-green-300 text-sm border border-green-500/30 mt-2">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Upload complete! Video is now queued for AI processing.</span>
                </div>
              )}

              {status === "idle" && (
                <div className="flex justify-end gap-3 mt-4">
                  <Button variant="outline" className="border-white/20 text-zinc-100" onClick={clearSelection}>Cancel</Button>
                  <Button onClick={handleUploadAndAnalyze} className="bg-white text-zinc-950 hover:bg-zinc-200">Begin Upload</Button>
                </div>
              )}

              {status === "success" && (
                <div className="flex justify-end mt-2">
                  <Button variant="outline" className="border-white/20 text-zinc-100" onClick={clearSelection}>Upload Another File</Button>
                </div>
              )}
            </div>
          )}

          {analysisResult && (
            <Card className="border border-white/10 bg-zinc-950/60">
              <CardHeader className="space-y-3">
                <div className="flex items-center gap-2 text-zinc-100">
                  <ShieldAlert className="h-5 w-5" />
                  <CardTitle className="text-lg">Analysis Results</CardTitle>
                </div>

                {analysisResult.detected ? (
                  <div className="rounded-md border border-red-500/40 bg-linear-to-r from-red-600/25 to-orange-500/15 px-4 py-3 text-red-200 font-semibold">
                    ⚠️ CRITICAL: Accident Detected
                  </div>
                ) : (
                  <div className="rounded-md border border-green-500/40 bg-green-600/15 px-4 py-3 text-green-200 font-semibold">
                    ✅ STATUS: Safe / No Collision
                  </div>
                )}
              </CardHeader>

              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-zinc-400">YOLOv8 Confidence:</span>
                  <span className="rounded-full border border-white/20 bg-zinc-900 px-3 py-1 font-semibold text-zinc-100">
                    {typeof analysisResult.confidence === "number"
                      ? `${analysisResult.confidence.toFixed(1)}%`
                      : "N/A"}
                  </span>
                  <span className="rounded-full border border-white/20 bg-zinc-900 px-3 py-1 font-semibold text-zinc-100">
                    Severity: {analysisResult.severity}
                  </span>
                </div>

                <div className="rounded-md border border-zinc-700 bg-zinc-800/60 p-4 relative">
                  <div className="flex justify-between items-center mb-2">
                      <p className="text-xs uppercase tracking-wide text-zinc-400">AI Summary / Report</p>
                      {analysisResult.fullReportJson && (
                          <Button 
                              size="sm" 
                              className="bg-blue-600 hover:bg-blue-500 text-white"
                              onClick={() => {
                                  import("@/utils/pdfGenerator").then(module => {
                                      module.generateIncidentPDF(analysisResult.fullReportJson);
                                  });
                              }}
                          >
                              Download AI Summary PDF
                          </Button>
                      )}
                  </div>
                  <p className="text-sm leading-6 text-zinc-200 whitespace-pre-wrap">{analysisResult.reportText}</p>
                </div>

                {analysisResult.detected && (
                  <section className="space-y-4 rounded-lg border border-blue-400/30 bg-blue-500/5 p-4">
                    <div>
                      <h3 className="font-semibold text-white">Generate Accident Report</h3>
                      <p className="mt-1 text-sm text-zinc-400">
                        Create a downloadable, AI-assisted insurance report from the saved incident record.
                      </p>
                    </div>

                    {!analysisResult.incidentId && (
                      <p className="text-sm text-amber-300">
                        The backend did not return an incident reference. Please update/restart the backend before generating a report.
                      </p>
                    )}

                    {[
                      ["health", "Health Insurance Report"],
                      ["motor", "Motor Accident Insurance Claim Report"],
                    ].map(([type, title]) => {
                      const report = insuranceReports[type];
                      const busy = report?.status === "generating" || report?.status === "downloading";

                      return (
                        <div key={type} className="flex flex-col gap-3 rounded-md border border-white/10 bg-black/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="font-medium text-zinc-100">{title}</p>
                            {report?.status === "generating" && (
                              <p role="status" className="mt-1 text-sm text-blue-300">Generating PDF report…</p>
                            )}
                            {report?.status === "downloading" && (
                              <p role="status" className="mt-1 text-sm text-blue-300">Downloading PDF…</p>
                            )}
                            {report?.message && (
                              <p role="status" className="mt-1 text-sm text-emerald-300">
                                {report.message}{report.pageCount ? ` (${report.pageCount} pages)` : ""}
                              </p>
                            )}
                            {report?.error && (
                              <p role="alert" className="mt-1 text-sm text-red-300">{report.error}</p>
                            )}
                            {report?.reportId && (
                              <p className="mt-1 text-xs text-zinc-500">Report ID: {report.reportId}</p>
                            )}
                          </div>
                          <div className="flex shrink-0 gap-2">
                            {report?.reportId ? (
                              <Button
                                type="button"
                                disabled={busy}
                                onClick={() => downloadInsuranceReport(type)}
                                className="bg-emerald-600 text-white hover:bg-emerald-500"
                              >
                                Download PDF
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                disabled={!analysisResult.incidentId || busy}
                                onClick={() => generateInsuranceReport(type)}
                                className="bg-blue-600 text-white hover:bg-blue-500"
                              >
                                {report?.status === "generating" ? "Generating…" : "Generate Report"}
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </section>
                )}
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>
    </div>
  );
}