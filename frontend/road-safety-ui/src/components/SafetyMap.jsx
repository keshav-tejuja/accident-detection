import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query } from "firebase/firestore";
import { MapContainer, TileLayer, Marker, Polyline, Circle, Popup, useMapEvents } from "react-leaflet";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { db } from "@/services/firebase";
import "leaflet/dist/leaflet.css";

const DEFAULT_CENTER = [28.6139, 77.209];

function parseCoordinate(raw) {
  if (!raw) return null;

  const lat = Number(raw.lat ?? raw.latitude);
  const lng = Number(raw.lng ?? raw.lon ?? raw.longitude);

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return [lat, lng];
  }

  return null;
}

function getSeverityStyle(severity) {
  const normalized = String(severity || "").toUpperCase();

  if (normalized === "SEVERE RISK" || normalized === "CRITICAL") {
    return { radius: 15, color: "#ef4444", label: "SEVERE RISK" };
  }

  return { radius: 8, color: "#f97316", label: "RISK" };
}

function MapClickHandler({ selectionMode, onPick }) {
  useMapEvents({
    click(event) {
      onPick([event.latlng.lat, event.latlng.lng], selectionMode);
    },
  });

  return null;
}

export default function SafetyMap() {
  const [origin, setOrigin] = useState("Connaught Place");
  const [destination, setDestination] = useState("AIIMS Trauma Center");
  const [selectionMode, setSelectionMode] = useState("origin");
  const [selectedOrigin, setSelectedOrigin] = useState(DEFAULT_CENTER);
  const [selectedDestination, setSelectedDestination] = useState([28.61, 77.24]);
  const [routePath, setRoutePath] = useState([]);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const accidentHotspots = useMemo(
    () => [
      { id: "hotspot-1", coordinates: [28.6315, 77.2177] },
      { id: "hotspot-2", coordinates: [28.6247, 77.2312] },
      { id: "hotspot-3", coordinates: [28.6099, 77.2198] },
    ],
    [],
  );

  useEffect(() => {
    const loadIncidents = async () => {
      try {
        setLoading(true);
        setError("");

        const snapshot = await getDocs(query(collection(db, "accidents")));
        const mapped = snapshot.docs
          .map((docItem) => {
            const raw = docItem.data();
            const coordinates =
              parseCoordinate(raw.coordinates) ||
              parseCoordinate(raw.locationCoordinates) ||
              parseCoordinate({ lat: raw.latitude, lng: raw.longitude });

            if (!coordinates) return null;

            return {
              id: docItem.id,
              coordinates,
              severity: raw.severity || "RISK",
              location: raw.location || raw.address || "Unknown",
            };
          })
          .filter(Boolean);

        setIncidents(mapped);
      } catch (fetchError) {
        setError(fetchError?.message || "Failed to load safety map data.");
      } finally {
        setLoading(false);
      }
    };

    loadIncidents();
  }, []);

  useEffect(() => {
    const fetchRoute = async () => {
      setRouteLoading(true);
      setRouteError("");

      try {
        const startLat = selectedOrigin[0];
        const startLng = selectedOrigin[1];
        const endLat = selectedDestination[0];
        const endLng = selectedDestination[1];

        const response = await fetch(
          `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`,
        );

        if (!response.ok) {
          throw new Error(`Routing request failed (${response.status})`);
        }

        const data = await response.json();
        const coordinates = data?.routes?.[0]?.geometry?.coordinates || [];

        if (!coordinates.length) {
          throw new Error("No route geometry returned by OSRM.");
        }

        // OSRM returns [lng, lat] and Leaflet expects [lat, lng].
        const converted = coordinates.map(([lng, lat]) => [lat, lng]);
        setRoutePath(converted);
      } catch (err) {
        setRouteError(err?.message || "Failed to fetch route from OSRM.");
        setRoutePath([selectedOrigin, selectedDestination]);
      } finally {
        setRouteLoading(false);
      }
    };

    fetchRoute();
  }, [selectedOrigin, selectedDestination]);

  const handleMapPick = (coordinates, mode) => {
    if (mode === "destination") {
      setSelectedDestination(coordinates);
      setDestination(`Selected on map: ${coordinates[0].toFixed(5)}, ${coordinates[1].toFixed(5)}`);
      return;
    }

    setSelectedOrigin(coordinates);
    setOrigin(`Selected on map: ${coordinates[0].toFixed(5)}, ${coordinates[1].toFixed(5)}`);
  };

  return (
    <Card className="glass-card border-white/5 bg-black/30 shadow-2xl overflow-hidden relative">
      <div className="flex flex-col gap-1.5 px-8 pt-7 pb-4 border-b border-white/5 bg-black/35 backdrop-blur-md">
        <h3 className="text-2xl font-extrabold tracking-tight text-white">Predictive Safety Map</h3>
        <p className="text-zinc-500 text-sm font-medium">Select route endpoints on the map and compare them against historical accident zones.</p>
      </div>

      <div className="h-[calc(100vh-16rem)] min-h-[560px] relative">
        <MapContainer center={selectedOrigin} zoom={12} style={{ height: "100%", width: "100%", zIndex: 0 }} className="h-full w-full">
          <MapClickHandler selectionMode={selectionMode} onPick={handleMapPick} />
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {incidents.map((incident) => {
            const visual = getSeverityStyle(incident.severity);

            return (
              <Circle
                key={incident.id}
                center={incident.coordinates}
                radius={visual.radius * 20}
                pathOptions={{
                  color: visual.color,
                  fillColor: visual.color,
                  fillOpacity: 0.4,
                  weight: 1.5,
                }}
              >
                <Popup>
                  <div className="space-y-1 text-sm">
                    <p className="font-bold text-slate-900">{incident.location}</p>
                    <p>Severity: {incident.severity}</p>
                  </div>
                </Popup>
              </Circle>
            );
          })}

          {accidentHotspots.map((hotspot) => (
            <Circle
              key={hotspot.id}
              center={hotspot.coordinates}
              radius={170}
              pathOptions={{
                color: "red",
                fillColor: "#ef4444",
                fillOpacity: 0.4,
                weight: 2,
              }}
            >
              <Popup>High-Risk Collision Zone</Popup>
            </Circle>
          ))}

          <Marker
            position={selectedOrigin}
          >
            <Popup>Origin</Popup>
          </Marker>

          <Marker
            position={selectedDestination}
          >
            <Popup>Destination</Popup>
          </Marker>

          <Polyline
            positions={routePath}
            pathOptions={{
              color: "#38bdf8",
              weight: 6,
              opacity: 0.9,
            }}
          />
        </MapContainer>

        <div className="absolute top-5 left-5 w-90 rounded-2xl border border-white/10 bg-slate-800/65 backdrop-blur-xl shadow-2xl p-5 z-1000">
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
              <Input value={origin} onChange={(e) => setOrigin(e.target.value)} className="bg-black/40 border-white/10 text-zinc-100" placeholder="Enter origin" />
            </div>

            <div className="space-y-2">
              <Label className="text-zinc-300 text-xs uppercase tracking-widest">Destination</Label>
              <Input value={destination} onChange={(e) => setDestination(e.target.value)} className="bg-black/40 border-white/10 text-zinc-100" placeholder="Enter destination" />
            </div>

            <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-300">
              {loading
                ? "Loading historical incident coordinates..."
                : error
                ? `Data error: ${error}`
                : routeLoading
                ? "Computing OSRM route..."
                : routeError
                ? `Routing error: ${routeError}`
                : `${incidents.length} mapped danger zones loaded`}
            </div>

            <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-300 space-y-1">
              <div>Active selection: {selectionMode === "origin" ? "Origin" : "Destination"}</div>
              <div>Click the map to place the selected waypoint.</div>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}