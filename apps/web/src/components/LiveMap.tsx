import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect, useMemo } from 'react';
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet';
import type { Ambulance, Hospital, Incident } from '@gh/shared';
import { PRIORITY_STYLE } from '../lib/format';

export const DEFAULT_CENTER: [number, number] = [27.7052, 68.8574];

function incidentIcon(inc: Incident, selected: boolean) {
  const c = PRIORITY_STYLE[inc.priority].hex;
  const size = selected ? 30 : 22;
  const pulse = inc.priority === 'P1' && ['REPORTED', 'TRIAGED'].includes(inc.status) ? 'gh-pulse' : '';
  const sms = inc.channel === 'sms' || inc.channel === 'queued';
  return L.divIcon({
    className: 'gh-marker',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div class="${pulse}" style="width:${size}px;height:${size}px;border-radius:50%;background:${c};border:3px solid ${
      selected ? '#0f172a' : '#fff'
    };box-shadow:0 1px 4px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;color:#fff;font:700 10px system-ui">${
      sms ? 'SMS'.slice(0, size > 24 ? 3 : 1) : inc.patientsCount > 1 ? inc.patientsCount : ''
    }</div>`,
  });
}

const AMB_COLOR: Record<string, string> = {
  AVAILABLE: '#1c7c6b',
  RETURNING: '#2a9a84',
  OUT_OF_SERVICE: '#64748b',
};

function ambulanceIcon(a: Ambulance, highlight: boolean) {
  const c = AMB_COLOR[a.status] ?? '#1d4e89';
  return L.divIcon({
    className: 'gh-marker',
    iconSize: [50, 22],
    iconAnchor: [25, 11],
    html: `<div style="padding:2px 6px;border-radius:999px;background:${c};color:#fff;font:700 10px 'Plus Jakarta Sans Variable',system-ui;border:2px solid ${
      highlight ? '#facc15' : '#fff'
    };box-shadow:0 2px 6px rgba(16,35,31,.35);white-space:nowrap;text-align:center">${a.callSign}</div>`,
  });
}

function hospitalIcon(h: Hospital) {
  const diverting = h.units.some((u) => u.unitType === 'TRAUMA' && u.status === 'DIVERTING');
  return L.divIcon({
    className: 'gh-marker',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    html: `<div style="width:24px;height:24px;border-radius:8px;background:${diverting ? '#fef2f2' : '#eefaf7'};border:2px solid ${
      diverting ? '#dc2626' : '#146357'
    };color:${diverting ? '#dc2626' : '#146357'};font:800 14px/20px system-ui;text-align:center;box-shadow:0 2px 6px rgba(16,35,31,.25)">H</div>`,
  });
}

function FlyTo({ target }: { target: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo(target, Math.max(map.getZoom(), 14), { duration: 0.6 });
  }, [target, map]);
  return null;
}

export interface Route {
  id: string;
  points: [number, number][];
  color?: string;
}

export function LiveMap(props: {
  incidents?: Incident[];
  ambulances?: Ambulance[];
  hospitals?: Hospital[];
  routes?: Route[];
  selectedIncidentId?: string | null;
  highlightAmbulanceIds?: string[];
  onSelectIncident?: (id: string) => void;
  flyTo?: [number, number] | null;
  center?: [number, number];
  zoom?: number;
  className?: string;
}) {
  const { incidents = [], ambulances = [], hospitals = [], routes = [] } = props;
  const hl = useMemo(() => new Set(props.highlightAmbulanceIds ?? []), [props.highlightAmbulanceIds]);
  return (
    <MapContainer
      center={props.center ?? DEFAULT_CENTER}
      zoom={props.zoom ?? 13}
      className={props.className ?? 'h-full w-full'}
      zoomControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FlyTo target={props.flyTo ?? null} />
      {routes.map((r) => (
        <Polyline key={r.id} positions={r.points} pathOptions={{ color: r.color ?? '#2563eb', weight: 4, opacity: 0.7, dashArray: '6 6' }} />
      ))}
      {hospitals.map((h) => (
        <Marker key={h.id} position={[h.lat, h.lng]} icon={hospitalIcon(h)}>
          <Tooltip direction="top" offset={[0, -10]}>
            <div className="text-xs">
              <div className="font-bold">{h.name}</div>
              {h.units.map((u) => (
                <div key={u.unitType}>
                  {u.unitType}: {u.bedsFree} free ·{' '}
                  <span className={u.status === 'DIVERTING' ? 'font-bold text-red-600' : u.status === 'LIMITED' ? 'text-orange-600' : 'text-green-700'}>
                    {u.status}
                  </span>
                </div>
              ))}
            </div>
          </Tooltip>
        </Marker>
      ))}
      {ambulances.map((a) => (
        <Marker key={a.id} position={[a.lat, a.lng]} icon={ambulanceIcon(a, hl.has(a.id))} zIndexOffset={500}>
          <Tooltip direction="top" offset={[0, -8]}>
            {a.callSign} ({a.type}) · {a.status.replace(/_/g, ' ').toLowerCase()}
          </Tooltip>
        </Marker>
      ))}
      {incidents.map((i) => (
        <Marker
          key={i.id}
          position={[i.lat, i.lng]}
          icon={incidentIcon(i, i.id === props.selectedIncidentId)}
          zIndexOffset={1000}
          eventHandlers={{ click: () => props.onSelectIncident?.(i.id) }}
        />
      ))}
    </MapContainer>
  );
}
