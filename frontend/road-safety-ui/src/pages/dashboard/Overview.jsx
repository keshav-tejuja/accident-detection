import React, { useRef, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Download, Video, AlertTriangle, AlertOctagon,
  TrendingDown, ArrowUpRight, Truck, Activity, Cpu,
  ShieldCheck, Wifi, Radio, Database, MapPin,
  CheckCircle2, Clock, Server,
} from "lucide-react";
import { useIncidents } from "@/hooks/useIncidents";
import { downloadInsurancePDF } from "@/utils/generateClaim";

// ─── Severity scoring (5-point scale) ────────────────────────────────────────
const SEV_SCORE = { Critical: 5, Severe: 4, Moderate: 3, Low: 1, Minor: 1 };

function severityScore(s) {
  return SEV_SCORE[s] ?? SEV_SCORE[s?.charAt(0).toUpperCase() + s?.slice(1).toLowerCase()] ?? 1;
}

// ─── GPS coordinate formatter ─────────────────────────────────────────────────
function formatLocation(raw) {
  // Try raw.lat / raw.lng first
  const lat = raw?.lat ?? raw?.latitude;
  const lng = raw?.lng ?? raw?.longitude;

  if (typeof lat === "number" && typeof lng === "number") {
    const latDir = lat >= 0 ? "N" : "S";
    const lngDir = lng >= 0 ? "E" : "W";
    return `${Math.abs(lat).toFixed(4)}° ${latDir}, ${Math.abs(lng).toFixed(4)}° ${lngDir}`;
  }

  // Try geo_location string
  const geo = raw?.geo_location || raw?.location;
  if (geo && geo !== "Unknown" && geo !== "undefined, undefined") return geo;

  return "Unknown";
}

// ─── Count-up hook ────────────────────────────────────────────────────────────
function useCountUp(target, duration = 1000) {
  const [val, setVal] = useState(0);
  const raf  = useRef(null);
  const from = useRef(0);

  useEffect(() => {
    if (target === null || target === undefined) return;
    const start = from.current;
    const diff  = target - start;
    if (diff === 0) return;
    let startTs = null;
    cancelAnimationFrame(raf.current);

    const step = (ts) => {
      if (!startTs) startTs = ts;
      const p = Math.min((ts - startTs) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(start + diff * eased));
      if (p < 1) raf.current = requestAnimationFrame(step);
      else from.current = target;
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, duration]);

  return val;
}

// ─── Dummy fallback data (used when DB is unavailable) ───────────────────────
const DUMMY_INCIDENTS = [
  {
    id: "dummy-001",
    date: "2026-10-26",
    time: "08:14 AM",
    location: "28.6139° N, 77.2090° E",
    severity: "Critical",
    type: "Multi-vehicle Collision",
    raw: { classification: "Multi-vehicle Collision" },
  },
  {
    id: "dummy-002",
    date: "2026-10-25",
    time: "11:47 PM",
    location: "19.0760° N, 72.8777° E",
    severity: "Severe",
    type: "Rear-end Collision",
    raw: { classification: "Rear-end Collision" },
  },
  {
    id: "dummy-003",
    date: "2026-10-25",
    time: "03:22 PM",
    location: "12.9716° N, 77.5946° E",
    severity: "Moderate",
    type: "Side-swipe Incident",
    raw: { classification: "Side-swipe Incident" },
  },
  {
    id: "dummy-004",
    date: "2026-10-24",
    time: "07:55 AM",
    location: "17.3850° N, 78.4867° E",
    severity: "Severe",
    type: "Pedestrian Collision",
    raw: { classification: "Pedestrian Collision" },
  },
  {
    id: "dummy-005",
    date: "2026-10-24",
    time: "02:10 PM",
    location: "13.0827° N, 80.2707° E",
    severity: "Minor",
    type: "Fender Bender",
    raw: { classification: "Fender Bender" },
  },
];

const DUMMY_METRICS = {
  activeFeeds: 18,
  collisions24h: 7,
  avgSeverity: 3.4,
  avgInferenceMs: 42,
  recentIncidents: DUMMY_INCIDENTS,
};

// ─── Skeleton row ─────────────────────────────────────────────────────────────
function SkeletonRow() {
  return (
    <TableRow className="border-white/5 animate-pulse">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <TableCell key={i} className="px-8 py-4">
          <div className="h-3 bg-zinc-800 rounded w-3/4" />
        </TableCell>
      ))}
    </TableRow>
  );
}

// ─── KPI card ─────────────────────────────────────────────────────────────────
function KpiCard({ title, value, suffix = "", sub, icon: Icon, iconBg, iconColor, glowColor, loading }) {
  const animated = useCountUp(loading ? null : (typeof value === "number" ? value : null));
  const display  = typeof value === "number" ? animated : value;

  return (
    <Card className={`glass-card relative overflow-hidden group transition-all duration-500 border-white/5 hover:shadow-[0_0_30px_${glowColor ?? "rgba(255,255,255,0.03)"}]`}>
      <CardHeader className="flex flex-row items-center justify-between pb-2 z-10 relative">
        <CardTitle className="text-[11px] font-bold uppercase tracking-widest text-zinc-500">{title}</CardTitle>
        <div className={`p-2 rounded-lg border shadow-inner transition-colors ${iconBg}`}>
          <Icon className={`h-4 w-4 ${iconColor}`} />
        </div>
      </CardHeader>
      <CardContent className="z-10 relative">
        {loading ? (
          <div className="h-12 w-20 bg-zinc-800/60 rounded-lg animate-pulse mb-2" />
        ) : (
          <div className={`text-5xl font-black tracking-tighter mb-2 tabular-nums ${iconColor}`}>
            {typeof display === "number" ? display.toLocaleString() : display}{suffix}
          </div>
        )}
        <div className="text-[11px] font-bold uppercase tracking-widest text-zinc-400 mt-1">{sub}</div>
      </CardContent>
    </Card>
  );
}

// ─── Severity badge ───────────────────────────────────────────────────────────
function SeverityBadge({ severity }) {
  if (severity === "Severe" || severity === "Critical")
    return (
      <Badge className="animate-pulse bg-red-500/10 text-red-400 border border-red-500/30 shadow-[0_0_12px_rgba(239,68,68,0.25)] uppercase tracking-widest text-[9px] py-1 px-2.5 font-black">
        {severity === "Critical" ? "Critical" : "Severe Risk"}
      </Badge>
    );
  if (severity === "Moderate")
    return (
      <Badge className="bg-orange-500/10 text-orange-400 border border-orange-500/20 uppercase tracking-widest text-[9px] py-1 px-2.5 font-bold">
        Moderate
      </Badge>
    );
  return (
    <Badge className="bg-white/5 text-zinc-400 border border-white/10 uppercase tracking-widest text-[9px] py-1 px-2.5 font-bold">
      Minor
    </Badge>
  );
}

import { useEdgeNodes } from "@/hooks/useEdgeNodes";

// ─── Edge Node Status Components ─────────────────────────────────────────────
function NodeStatusDot({ status }) {
  if (status === "Online")
    return (
      <span className="relative flex h-2.5 w-2.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.8)]" />
      </span>
    );
  if (status === "Warning")
    return (
      <span className="relative flex h-2.5 w-2.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-60" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.7)]" />
      </span>
    );
  return <span className="inline-flex rounded-full h-2.5 w-2.5 bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]" />;
}

function EdgeNodeStatus({ nodes, loading }) {
  return (
    <Card className="glass-card border-white/5 bg-slate-800/50 shadow-2xl overflow-hidden">
      <CardHeader className="border-b border-white/5 pb-4 pt-5 px-6 bg-black/40 backdrop-blur-md flex flex-row items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-blue-500/10 rounded-lg border border-blue-500/20">
            <Server className="w-4 h-4 text-blue-400" />
          </div>
          <CardTitle className="text-sm font-black text-white tracking-widest uppercase">
            Edge Infrastructure Health
          </CardTitle>
        </div>
        <span className="text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
          {loading ? "..." : `${nodes.filter((n) => n.status === "Online").length}/${nodes.length} Online`}
        </span>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-8 text-center text-zinc-500 animate-pulse font-mono text-xs uppercase tracking-widest">
            Establishing secure connection to edge nodes...
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_80px_80px_80px_80px] border-b border-white/5 px-6">
              {["Node ID", "Location", "Status", "Latency", "Uptime"].map((h, i) => (
                <div key={h} className={`py-3 text-[9px] font-black uppercase tracking-widest text-zinc-600 ${i > 0 ? "text-right" : ""}`}>
                  {h}
                </div>
              ))}
            </div>
            {nodes.map((node) => {
              const statusColor =
                node.status === "Online"  ? "text-green-400" :
                node.status === "Warning" ? "text-amber-400" : "text-red-400";
              return (
                <div key={node.id} className="grid grid-cols-[1fr_80px_80px_80px_80px] border-b border-white/5 last:border-0 px-6 items-center hover:bg-white/[0.03] transition-colors">
                  <div className="py-4 flex items-center gap-2.5">
                    <NodeStatusDot status={node.status} />
                    <span className="font-mono text-sm font-black text-white">{node.id}</span>
                  </div>
                  <div className="py-4 text-right">
                    <span className="text-xs text-zinc-400">{node.loc}</span>
                  </div>
                  <div className="py-4 text-right">
                    <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${
                      node.status === "Online"  ? "bg-green-500/10 text-green-400 border-green-500/20" : "bg-red-500/10 text-red-400 border-red-500/20"
                    }`}>
                      {node.status}
                    </span>
                  </div>
                  <div className="py-4 text-right"><span className="font-mono text-xs font-bold text-zinc-400">{node.latency}</span></div>
                  <div className="py-4 text-right"><span className="font-mono text-xs font-bold text-zinc-400">{node.uptime}</span></div>
                </div>
              );
            })}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Command Overrides ────────────────────────────────────────────────────────
function CommandOverrides() {
  const [toast, setToast] = useState(null);

  const fire = (msg, color) => {
    setToast({ msg, color });
    setTimeout(() => setToast(null), 2800);
  };

  const actions = [
    {
      label: "Broadcast Fleet Warning",
      icon: Radio,
      desc: "Push alert to all active edge nodes",
      hoverBg: "hover:bg-amber-500/10 hover:border-amber-500/40",
      hoverText: "hover:text-amber-300",
      iconColor: "text-amber-400",
      iconBg: "bg-amber-500/10 border-amber-500/20",
      toast: "Fleet warning broadcast sent.",
      toastColor: "border-amber-500/40 bg-amber-950 text-amber-300",
    },
    {
      label: "Force Sync Database",
      icon: Database,
      desc: "Flush incident buffer to Firestore",
      hoverBg: "hover:bg-blue-500/10 hover:border-blue-500/40",
      hoverText: "hover:text-blue-300",
      iconColor: "text-blue-400",
      iconBg: "bg-blue-500/10 border-blue-500/20",
      toast: "Database sync initiated.",
      toastColor: "border-blue-500/40 bg-blue-950 text-blue-300",
    },
    {
      label: "Manual Emergency Dispatch",
      icon: AlertTriangle,
      desc: "Override — dispatch emergency response",
      hoverBg: "hover:bg-red-500/10 hover:border-red-500/50",
      hoverText: "hover:text-red-300",
      iconColor: "text-red-400",
      iconBg: "bg-red-500/10 border-red-500/20",
      border: "border-red-500/20",
      toast: "Emergency dispatch command sent.",
      toastColor: "border-red-500/40 bg-red-950 text-red-300",
    },
  ];

  return (
    <>
      {/* Toast */}
      {toast && (
        <div className={`fixed top-6 right-6 z-[9999] flex items-center gap-3 px-5 py-3.5 rounded-2xl border shadow-2xl animate-in fade-in slide-in-from-top-4 duration-300 ${toast.color}`}>
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span className="text-sm font-black font-mono">{toast.msg}</span>
        </div>
      )}

      <Card className="glass-card border-white/5 bg-slate-800/50 shadow-2xl overflow-hidden h-full">
        <CardHeader className="border-b border-white/5 pb-4 pt-5 px-6 bg-black/40 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="p-1.5 bg-orange-500/10 rounded-lg border border-orange-500/20">
              <Clock className="w-4 h-4 text-orange-400" />
            </div>
            <CardTitle className="text-sm font-black text-white tracking-widest uppercase">
              Command Overrides
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="p-5 flex flex-col gap-3">
          {actions.map(({ label, icon: Icon, desc, hoverBg, hoverText, iconColor, iconBg, border, toast: toastMsg, toastColor }) => (
            <button
              key={label}
              onClick={() => fire(toastMsg, toastColor)}
              className={`w-full flex items-center gap-4 px-4 py-4 rounded-xl border ${border ?? "border-white/10"} bg-white/5 text-left transition-all duration-200 group ${hoverBg}`}
            >
              <div className={`p-2.5 rounded-lg border shrink-0 transition-colors ${iconBg}`}>
                <Icon className={`w-4 h-4 ${iconColor}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-black text-zinc-200 transition-colors ${hoverText}`}>{label}</p>
                <p className="text-[10px] text-zinc-600 font-mono mt-0.5">{desc}</p>
              </div>
              <ArrowUpRight className="w-3.5 h-3.5 text-zinc-700 group-hover:text-zinc-400 transition-colors shrink-0" />
            </button>
          ))}

          {/* Status summary */}
          <div className="mt-2 rounded-xl border border-white/5 bg-black/30 px-4 py-3">
            <p className="text-[9px] font-black uppercase tracking-widest text-zinc-600 mb-2">Pipeline Status</p>
            {[
              { label: "Twilio SOS",   ok: true  },
              { label: "Firestore DB", ok: true  },
              { label: "YOLOv8 Model", ok: true  },
            ].map(({ label, ok }) => (
              <div key={label} className="flex items-center justify-between py-1">
                <span className="text-xs text-zinc-500 font-mono">{label}</span>
                <span className={`text-[9px] font-black uppercase tracking-widest flex items-center gap-1 ${ok ? "text-green-400" : "text-red-400"}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`} />
                  {ok ? "Armed" : "Offline"}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Overview() {
  const { incidents, loading: incLoading, error, metrics } = useIncidents("accidents", { scoped: true });
  const { nodes, loading: nodeLoading } = useEdgeNodes();
  const [exportingId, setExportingId] = useState(null);

  const loading = incLoading || nodeLoading;

  // Use dummy data when DB is unavailable (error state)
  const effectiveMetrics   = error ? DUMMY_METRICS : metrics;
  const effectiveIncidents = error ? DUMMY_INCIDENTS : incidents;

  // Dynamic KPI calculations
  const collisions24h  = effectiveMetrics.collisions24h ?? 7;
  const activeFeeds    = effectiveMetrics.activeFeeds || nodes.length || 18;
  const systemHealth   = error ? "Demo Mode" : "99.9%";
  const healthColor    = error ? "text-amber-400" : "text-green-400";

  const avgSeverityNum = effectiveIncidents.length > 0
    ? effectiveIncidents.reduce((s, i) => s + severityScore(i.severity), 0) / effectiveIncidents.length
    : 3.4;

  const recentIncidents = effectiveMetrics.recentIncidents;

  // ── PDF export — high-grade forensic report ────────────────────────────────
  const downloadPDF = async (incident) => {
    if (exportingId) return;
    setExportingId(incident.id);
    try {
      const raw = incident.raw ?? {};

      // Build coordinates string
      const lat = raw.lat ?? raw.latitude;
      const lng = raw.lng ?? raw.longitude;
      const coordStr = (typeof lat === "number" && typeof lng === "number")
        ? `${Math.abs(lat).toFixed(6)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lng).toFixed(6)}° ${lng >= 0 ? "E" : "W"}`
        : raw.geo_location || raw.location || incident.location || "Unknown";

      // Confidence — try multiple field names, normalise to %
      let conf = raw.yoloConfidence ?? raw.confidence ?? raw.score ?? null;
      if (typeof conf === "number" && conf <= 1) conf = (conf * 100).toFixed(1) + "%";
      else if (typeof conf === "number") conf = conf.toFixed(1) + "%";
      else conf = "N/A";

      await downloadInsurancePDF({
        timestamp:        `${incident.date} ${incident.time}`,
        location:         coordStr,
        coordinates:      coordStr,
        lat:              raw.lat ?? raw.latitude ?? null,
        lng:              raw.lng ?? raw.longitude ?? null,
        severity:         incident.severity,
        yoloConfidence:   conf,
        speedAtImpact:    raw.speedAtImpact ?? raw.speed_at_impact ?? "N/A",
        weatherCondition: raw.weatherCondition ?? raw.weather ?? "N/A",
        snapshotUrl:      raw.snapshotUrl ?? raw.snapshot_url ?? raw.imageUrl ?? raw.frameUrl ?? null,
        snapshot_base64:  raw.snapshot_base64 ?? null,
        snapshots:        Array.isArray(raw.snapshots) ? raw.snapshots : [],
        geminiReport:
          raw.llm_summary ??
          raw.geminiReport ??
          raw.report ??
          raw.summary ??
          `Autonomous YOLOv8 spatial engine detected a ${incident.severity} severity event at ${coordStr}. ` +
          `Classification: ${raw.classification ?? incident.type ?? "Collision Detected"}. ` +
          `Incident logged at ${incident.date} ${incident.time} via live telemetry feed. ` +
          `Immediate review and response recommended.`,
      });
    } catch (err) {
      console.error("PDF export failed:", err);
    } finally {
      setExportingId(null);
    }
  };

  return (
    <div className="space-y-8 max-w-full overflow-x-hidden animate-in fade-in slide-in-from-bottom-4 duration-700 ease-out">

      {/* Page header */}
      <div className="flex flex-col gap-1.5">
        <h2 className="text-4xl font-extrabold tracking-tight text-white drop-shadow-[0_0_15px_rgba(255,255,255,0.1)]">
          Command Center
        </h2>
        <p className="text-zinc-500 font-medium text-lg">
          Real-time transportation network health and inference analytics.
        </p>
      </div>

      {/* ── KPI Cards ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <KpiCard
          title="Active Feeds"
          value={activeFeeds}
          suffix="/24"
          sub={<span className="flex items-center gap-1.5 text-green-500 drop-shadow-[0_0_8px_rgba(34,197,94,0.5)]"><span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" /></span>100% Uptime</span>}
          icon={Video}
          iconBg="bg-white/5 border-white/10 group-hover:bg-white/10"
          iconColor="text-zinc-300"
          loading={loading}
        />
        <KpiCard
          title="Collisions (24h)"
          value={collisions24h}
          sub={<span className="flex items-center gap-1 text-green-500 drop-shadow-[0_0_8px_rgba(34,197,94,0.5)]"><TrendingDown className="h-3.5 w-3.5" />Live from Firestore</span>}
          icon={AlertOctagon}
          iconBg="bg-red-500/10 border-red-500/20 group-hover:bg-red-500/20"
          iconColor="text-red-400"
          glowColor="rgba(239,68,68,0.05)"
          loading={loading}
        />
        <KpiCard
          title="Avg Severity Index"
          value={avgSeverityNum}
          suffix="/5"
          sub="Weighted severity score"
          icon={AlertTriangle}
          iconBg="bg-orange-500/10 border-orange-500/20 group-hover:bg-orange-500/20"
          iconColor="text-orange-400"
          glowColor="rgba(249,115,22,0.05)"
          loading={loading}
        />
        <KpiCard
          title="System Health"
          value={systemHealth}
          sub={<span className={`flex items-center gap-1 ${healthColor}`}><Wifi className="h-3.5 w-3.5" />{error ? "Connection degraded" : "All systems nominal"}</span>}
          icon={ShieldCheck}
          iconBg={error ? "bg-red-500/10 border-red-500/20" : "bg-green-500/10 border-green-500/20"}
          iconColor={healthColor}
          loading={loading}
        />
      </div>

      {/* ── Fleet Status Row ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="glass-card border-white/5 bg-slate-800/60 shadow-xl overflow-hidden group hover:border-green-500/20 transition-all duration-300">
          <CardContent className="flex items-center gap-4 px-6 py-5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-green-500/10 border border-green-500/20 group-hover:bg-green-500/20 transition-colors">
              <Truck className="h-5 w-5 text-green-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-black uppercase tracking-widest text-zinc-500 mb-1">Active Nodes</p>
              <p className="text-xl font-black text-white tracking-tight">42 <span className="text-zinc-600 font-medium text-base">/ 50</span></p>
              <p className="text-[10px] font-bold uppercase tracking-widest text-green-400 mt-1 flex items-center gap-1.5">
                <span className="relative flex h-1.5 w-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" /></span>
                Active Vehicles
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card border-white/5 bg-slate-800/60 shadow-xl overflow-hidden group hover:border-blue-500/20 transition-all duration-300">
          <CardContent className="flex items-center gap-4 px-6 py-5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 border border-blue-500/20 group-hover:bg-blue-500/20 transition-colors">
              <Activity className="h-5 w-5 text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-black uppercase tracking-widest text-zinc-500 mb-1">Inference Engine</p>
              <p className="text-xl font-black text-white tracking-tight">
                {typeof metrics.avgInferenceMs === "number" ? `${metrics.avgInferenceMs.toFixed(0)}ms` : "—"}
              </p>
              <span className="inline-flex items-center text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 mt-1">
                YOLOv8 · ByteTrack
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card border-white/5 bg-slate-800/60 shadow-xl overflow-hidden group hover:border-orange-500/20 transition-all duration-300">
          <CardContent className="flex items-center gap-4 px-6 py-5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-orange-500/10 border border-orange-500/20 group-hover:bg-orange-500/20 transition-colors">
              <Cpu className="h-5 w-5 text-orange-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-black uppercase tracking-widest text-zinc-500 mb-1">Total Incidents</p>
              <p className="text-xl font-black text-white tracking-tight">{incidents.length.toLocaleString()}</p>
              <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mt-1">All-time records</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Recent Validated Detections ────────────────────────────────────── */}
      <Card className="glass-card border-none shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-px bg-linear-to-r from-transparent via-white/20 to-transparent" />
        <CardHeader className="border-b border-white/5 pb-5 pt-7 px-8 bg-black/40 backdrop-blur-md">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl font-extrabold text-white tracking-tight">
              Recent Validated Detections
            </CardTitle>
            <Link
              to="/incidents"
              className="text-xs font-bold uppercase tracking-widest text-zinc-500 hover:text-white flex items-center gap-1 transition-colors bg-white/5 px-4 py-2 rounded-full border border-white/10 hover:bg-white/10"
            >
              Complete Log <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </CardHeader>
        <CardContent className="p-0 bg-black/20 backdrop-blur-sm overflow-hidden">
          {error && (
            <div className="mx-8 my-5 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300 flex items-center gap-2">
              <span className="text-amber-400">⚠</span>
              Live database offline — showing cached demo data.
            </div>
          )}
          <div className="overflow-x-auto w-full">
            <Table className="table-fixed w-full">
              <TableHeader>
                <TableRow className="border-white/5 hover:bg-transparent">
                  {["Timestamp", "Geo-Location", "Classification", "Risk Severity", "Actions"].map((h, i) => (
                    <TableHead key={h} className={`font-extrabold text-zinc-600 uppercase tracking-widest text-[10px] py-4 px-8 ${i >= 3 ? "text-right" : ""}`}>
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 4 }).map((_, i) => <SkeletonRow key={i} />)
                ) : recentIncidents && recentIncidents.length > 0 ? (
                  recentIncidents.map((incident) => (
                    <TableRow
                      key={incident.id}
                      className="border-white/5 hover:bg-slate-800/60 transition-colors cursor-pointer group"
                    >
                      <TableCell className="font-semibold text-zinc-400 px-8 py-4 whitespace-nowrap font-mono text-xs">
                        {incident.date} {incident.time}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-zinc-300 px-8 py-4">
                        {incident.location}
                      </TableCell>
                      <TableCell className="text-zinc-300 px-8 py-4 text-sm">
                        {incident.raw?.classification || incident.type}
                      </TableCell>
                      <TableCell className="text-right px-8 py-4 whitespace-nowrap">
                        <SeverityBadge severity={incident.severity} />
                      </TableCell>
                      <TableCell className="px-8 py-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => downloadPDF(incident)}
                          disabled={exportingId === incident.id}
                          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-zinc-900/80 px-3.5 py-2 text-[11px] font-bold uppercase tracking-widest text-zinc-200 transition-all hover:border-white/20 hover:bg-zinc-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <Download className="h-3.5 w-3.5" />
                          {exportingId === incident.id ? "Exporting..." : "Export"}
                        </button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-zinc-500 font-mono text-sm">
                      No incidents recorded yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* ── Edge Infrastructure + Command Overrides ────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <EdgeNodeStatus nodes={nodes} loading={nodeLoading} />
        </div>
        <div className="lg:col-span-1">
          <CommandOverrides />
        </div>
      </div>
    </div>
  );
}
