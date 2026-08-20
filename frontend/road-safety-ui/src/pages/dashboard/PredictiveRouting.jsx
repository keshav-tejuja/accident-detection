import { useEffect, useMemo, useState } from "react";
import { Circle, MapContainer, Marker, Polyline, Popup, TileLayer, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { indianBlackspots } from "@/data/indianBlackspots";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const DEFAULT_ORIGIN = { lat: 28.6139, lng: 77.2090, label: "New Delhi" };
const DEFAULT_DESTINATION = { lat: 28.5355, lng: 77.3910, label: "Noida Sector 18" };
const EARTH_RADIUS_M = 6371000;
const DETOUR_OFFSET_M = 1000;

const DEMO_GEOCODE = {
  delhi: { lat: 28.6139, lng: 77.2090 },
  noida: { lat: 28.5355, lng: 77.3910 },
  mumbai: { lat: 19.076, lng: 72.8777 },
  pune: { lat: 18.5204, lng: 73.8567 },
  bangalore: { lat: 12.9716, lng: 77.5946 },
  bengaluru: { lat: 12.9716, lng: 77.5946 },
  chennai: { lat: 13.0827, lng: 80.2707 },
  hyderabad: { lat: 17.385, lng: 78.4867 },
  kolkata: { lat: 22.5726, lng: 88.3639 },
};

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function toDegrees(value) {
  return (value * 180) / Math.PI;
}

function haversineDistanceMeters(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function bearingDegrees(from, to) {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const dLng = toRadians(to.lng - from.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function destinationPoint(from, distanceMeters, bearingDeg) {
  const angularDistance = distanceMeters / EARTH_RADIUS_M;
  const bearing = toRadians(bearingDeg);
  const lat1 = toRadians(from.lat);
  const lng1 = toRadians(from.lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );

  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );

  return { lat: toDegrees(lat2), lng: toDegrees(lng2) };
}

function routeDistanceMeters(path) {
  if (!Array.isArray(path) || path.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < path.length; i += 1) {
    sum += haversineDistanceMeters(path[i - 1], path[i]);
  }
  return sum;
}

function checkIntersection(routePath, dangerZones) {
  const intersections = [];
  for (let i = 0; i < routePath.length; i += 1) {
    const point = routePath[i];
    for (let z = 0; z < dangerZones.length; z += 1) {
      const zone = dangerZones[z];
      const distance = haversineDistanceMeters(point, { lat: zone.lat, lng: zone.lng });
      if (distance <= zone.radius) {
        intersections.push({ pointIndex: i, point, zone, distance });
        break;
      }
    }
  }
  return intersections;
}

function avoidDangerZonesGeometrically(routePath, dangerZones) {
  let safePath = [...routePath];
  let modificationsMade = true;
  let passes = 0;
  let intersectedZonesMap = new Map();

  while (modificationsMade && passes < 20) {
    modificationsMade = false;
    passes++;
    
    for (let z = 0; z < dangerZones.length; z++) {
      const zone = dangerZones[z];
      let entryIdx = -1;
      let exitIdx = -1;
      
      for (let i = 0; i < safePath.length; i++) {
        const dist = haversineDistanceMeters(safePath[i], { lat: zone.lat, lng: zone.lng });
        if (dist <= zone.radius) {
          if (entryIdx === -1) entryIdx = Math.max(0, i - 1);
          exitIdx = Math.min(safePath.length - 1, i + 1);
        }
      }
      
      if (entryIdx !== -1 && exitIdx !== -1 && entryIdx < exitIdx) {
        intersectedZonesMap.set(zone.id, zone);
        const entryPoint = safePath[entryIdx];
        const exitPoint = safePath[exitIdx];
        const center = { lat: zone.lat, lng: zone.lng };
        
        const b1 = bearingDegrees(center, entryPoint);
        const b2 = bearingDegrees(center, exitPoint);
        
        let diff = (b2 - b1 + 360) % 360;
        let direction = diff < 180 ? 1 : -1;
        if (diff > 180) diff = 360 - diff;
        
        const numSteps = Math.max(8, Math.floor(diff / 5));
        const stepAngle = (direction * diff) / numSteps;
        
        const detourPoints = [];
        const safeRadius = zone.radius + 150; // 150m safety buffer
        for (let j = 0; j <= numSteps; j++) {
          const angle = b1 + j * stepAngle;
          detourPoints.push(destinationPoint(center, safeRadius, angle));
        }
        
        safePath.splice(entryIdx, exitIdx - entryIdx + 1, ...detourPoints);
        modificationsMade = true;
        break; // restart passes
      }
    }
  }
  return { safePath, intersectedZones: Array.from(intersectedZonesMap.values()) };
}

async function fetchOsrmRoute(points) {
  const coordString = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const response = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${coordString}?overview=full&geometries=geojson`,
  );
  if (!response.ok) {
    throw new Error(`OSRM request failed (${response.status})`);
  }

  const json = await response.json();
  const coords = json?.routes?.[0]?.geometry?.coordinates || [];
  if (!coords.length) {
    throw new Error("No route returned from OSRM.");
  }
  return coords.map(([lng, lat]) => ({ lat, lng }));
}

function MapClickHandler({ mode, onPick }) {
  useMapEvents({
    click(event) {
      onPick({ lat: event.latlng.lat, lng: event.latlng.lng }, mode);
    },
  });
  return null;
}

async function resolveLocation(input, fallbackPoint) {
  const text = String(input || "").trim();
  if (!text) return fallbackPoint;

  const latLngMatch = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (latLngMatch) {
    return { lat: Number(latLngMatch[1]), lng: Number(latLngMatch[2]) };
  }

  const normalized = text.toLowerCase();
  if (DEMO_GEOCODE[normalized]) return DEMO_GEOCODE[normalized];

  const fromKey = Object.keys(DEMO_GEOCODE).find((key) => normalized.includes(key));
  if (fromKey) return DEMO_GEOCODE[fromKey];

  return fallbackPoint;
}

export default function PredictiveRouting() {
  const [originInput, setOriginInput] = useState(DEFAULT_ORIGIN.label);
  const [destinationInput, setDestinationInput] = useState(DEFAULT_DESTINATION.label);
  const [selectionMode, setSelectionMode] = useState("origin");
  const [selectedOrigin, setSelectedOrigin] = useState({ lat: DEFAULT_ORIGIN.lat, lng: DEFAULT_ORIGIN.lng });
  const [selectedDestination, setSelectedDestination] = useState({ lat: DEFAULT_DESTINATION.lat, lng: DEFAULT_DESTINATION.lng });
  const [routePath, setRoutePath] = useState([]);
  const [routeLoading, setRouteLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Ready for Route Analysis.");
  const [routeError, setRouteError] = useState("");
  const [intersectedZoneIds, setIntersectedZoneIds] = useState([]);
  const [pulseTick, setPulseTick] = useState(false);

  const dangerZones = useMemo(() => indianBlackspots, []);

  useEffect(() => {
    if (!intersectedZoneIds.length) return;
    const timer = setInterval(() => {
      setPulseTick((prev) => !prev);
    }, 650);
    return () => clearInterval(timer);
  }, [intersectedZoneIds.length]);

  useEffect(() => {
    let cancelled = false;

    const runRouting = async () => {
      setRouteLoading(true);
      setRouteError("");
      setStatusMessage("Ready for Route Analysis.");

      try {
        const origin = await resolveLocation(originInput, selectedOrigin);
        const destination = await resolveLocation(destinationInput, selectedDestination);

        if (cancelled) return;
        setSelectedOrigin(origin);
        setSelectedDestination(destination);

        const primaryPath = await fetchOsrmRoute([origin, destination]);
        if (cancelled) return;

        const intersections = checkIntersection(primaryPath, dangerZones);
        if (!intersections.length) {
          setRoutePath(primaryPath);
          setIntersectedZoneIds([]);
          setStatusMessage("Ready for Route Analysis.");
          return;
        }

        const firstHit = intersections[0];
        setRoutePath(primaryPath); // Show primary path temporarily
        setIntersectedZoneIds([...new Set(intersections.map((item) => item.zone.id))]);
        setStatusMessage(`⚠️ PRIMARY ROUTE AT RISK: Intersection detected at ${firstHit.zone.name}. Engaging autonomous detour...`);

        // Wait a moment so the user sees the danger zone warning
        await new Promise((r) => setTimeout(r, 1200));
        if (cancelled) return;

        const { safePath, intersectedZones } = avoidDangerZonesGeometrically(primaryPath, dangerZones);

        const primaryDistance = routeDistanceMeters(primaryPath);
        const detourDistance = routeDistanceMeters(safePath);
        const addedKm = Math.max(0, (detourDistance - primaryDistance) / 1000);

        setRoutePath(safePath);
        setIntersectedZoneIds([...new Set(intersectedZones.map((z) => z.id))]);
        
        const zoneNames = intersectedZones.map((z) => z.name).join(", ");
        setStatusMessage(
          `✅ SAFE ROUTE LOCKED: Bypassing ${zoneNames}. Total safety overhead: +${addedKm.toFixed(1)} km.`
        );
      } catch (err) {
        setRouteError(err?.message || "Failed to compute route.");
        setRoutePath([selectedOrigin, selectedDestination]);
      } finally {
        if (!cancelled) {
          setRouteLoading(false);
        }
      }
    };

    runRouting();

    return () => {
      cancelled = true;
    };
  }, [dangerZones, destinationInput, originInput]);

  const handleMapPick = (point, mode) => {
    const label = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
    if (mode === "destination") {
      setSelectedDestination(point);
      setDestinationInput(label);
      return;
    }
    setSelectedOrigin(point);
    setOriginInput(label);
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 ease-out">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-4xl font-extrabold tracking-tight text-white drop-shadow-[0_0_15px_rgba(255,255,255,0.1)]">Predictive Routing</h2>
        <p className="text-zinc-500 font-medium text-lg">Open-source autonomous route safety engine with blackspot detour logic across India.</p>
      </div>

      <Card className="glass-card border-white/5 bg-black/30 shadow-2xl overflow-hidden relative">
        <div className="flex flex-col gap-1.5 px-8 pt-7 pb-4 border-b border-white/5 bg-black/35 backdrop-blur-md">
          <h3 className="text-2xl font-extrabold tracking-tight text-white">Smart Open-Source Router</h3>
          <p className="text-zinc-500 text-sm font-medium">Routes are rebuilt with OSRM and detours are forced around high-risk blackspots.</p>
        </div>

        <div className="h-[calc(100vh-16rem)] min-h-[560px] relative overflow-hidden rounded-b-2xl">
          <MapContainer center={[selectedOrigin.lat, selectedOrigin.lng]} zoom={6} className="h-full w-full z-0">
            <MapClickHandler mode={selectionMode} onPick={handleMapPick} />
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />

            <Marker position={[selectedOrigin.lat, selectedOrigin.lng]}>
              <Popup>Origin</Popup>
            </Marker>
            <Marker position={[selectedDestination.lat, selectedDestination.lng]}>
              <Popup>Destination</Popup>
            </Marker>

            {dangerZones.map((zone) => {
              const intersected = intersectedZoneIds.includes(zone.id);
              const pulseScale = intersected && pulseTick ? 1.12 : 1;
              return (
                <Circle
                  key={zone.id}
                  center={[zone.lat, zone.lng]}
                  radius={zone.radius * pulseScale}
                  pathOptions={{
                    color: "#ef4444",
                    fillColor: "#ef4444",
                    fillOpacity: intersected ? 0.46 : 0.28,
                    weight: intersected ? 3 : 2,
                  }}
                >
                  <Popup>{zone.name}</Popup>
                </Circle>
              );
            })}

            {routePath.length > 0 && (
              <Polyline
                positions={routePath.map((p) => [p.lat, p.lng])}
                pathOptions={{ color: "#38bdf8", weight: 6, opacity: 0.92 }}
              />
            )}
          </MapContainer>

          <div className="absolute top-5 left-5 w-80 rounded-2xl border border-white/10 bg-slate-800/65 backdrop-blur-xl shadow-2xl p-5 z-[1000]">
            <p className="text-xs font-black uppercase tracking-widest text-zinc-400 mb-4">Route Planner Overlay</p>

            <div className="space-y-4">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSelectionMode("origin")}
                  className={`flex-1 rounded-full px-3 py-2 text-xs font-bold uppercase tracking-widest transition-colors ${
                    selectionMode === "origin" ? "bg-white text-zinc-950" : "bg-white/5 text-zinc-300 border border-white/10"
                  }`}
                >
                  Pick Origin
                </button>
                <button
                  type="button"
                  onClick={() => setSelectionMode("destination")}
                  className={`flex-1 rounded-full px-3 py-2 text-xs font-bold uppercase tracking-widest transition-colors ${
                    selectionMode === "destination" ? "bg-white text-zinc-950" : "bg-white/5 text-zinc-300 border border-white/10"
                  }`}
                >
                  Pick Destination
                </button>
              </div>

              <div className="space-y-2">
                <Label className="text-zinc-300 text-xs uppercase tracking-widest">Origin</Label>
                <Input value={originInput} onChange={(e) => setOriginInput(e.target.value)} className="bg-black/40 border-white/10 text-zinc-100" placeholder="City name or lat,lng" />
              </div>

              <div className="space-y-2">
                <Label className="text-zinc-300 text-xs uppercase tracking-widest">Destination</Label>
                <Input value={destinationInput} onChange={(e) => setDestinationInput(e.target.value)} className="bg-black/40 border-white/10 text-zinc-100" placeholder="City name or lat,lng" />
              </div>

              <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-300">
                {routeLoading
                  ? "Computing autonomous detour route..."
                  : routeError
                  ? `Routing error: ${routeError}`
                  : `${dangerZones.length} national blackspots loaded`}
              </div>

              <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-300 space-y-1">
                <div>{statusMessage}</div>
                <div>Active selection: {selectionMode === "origin" ? "Origin" : "Destination"}</div>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}