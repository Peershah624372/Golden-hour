import { useCallback, useEffect, useState } from 'react';
import { EVENTS, type Ambulance, type Dispatch, type Hospital, type HospitalUnit, type Incident } from '@gh/shared';
import { api } from './api';
import { getSocket, joinRooms, useSocketEvent } from './socket';

/** Live incidents, fleet and hospitals: initial REST load + WebSocket updates. */
export function useLiveData(rooms: string[], opts: { onNewIncident?: (i: Incident) => void } = {}) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [ambulances, setAmbulances] = useState<Ambulance[]>([]);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const [i, a, h, d] = await Promise.all([
      api<Incident[]>('/incidents'),
      api<Ambulance[]>('/ambulances'),
      api<Hospital[]>('/hospitals'),
      api<Dispatch[]>('/dispatches/active'),
    ]);
    setIncidents(i);
    setAmbulances(a);
    setHospitals(h);
    setDispatches(d);
    setLoaded(true);
  }, []);

  const roomsKey = rooms.join(',');
  useEffect(() => {
    joinRooms(roomsKey.split(',').filter(Boolean));
    void reload();
    // Reload after a reconnect so nothing missed while offline is lost.
    const s = getSocket();
    const onReconnect = () => void reload();
    s.io.on('reconnect', onReconnect);
    return () => {
      s.io.off('reconnect', onReconnect);
    };
  }, [roomsKey, reload]);

  const { onNewIncident } = opts;
  useSocketEvent<Incident>(
    EVENTS.incidentNew,
    useCallback(
      (inc) => {
        setIncidents((list) => (list.some((x) => x.id === inc.id) ? list : [inc, ...list]));
        onNewIncident?.(inc);
      },
      [onNewIncident],
    ),
  );
  useSocketEvent<Incident>(
    EVENTS.incidentUpdated,
    useCallback((inc) => {
      setIncidents((list) => {
        const closed = ['CLOSED', 'MERGED', 'CANCELLED', 'NO_TRANSPORT'].includes(inc.status);
        const exists = list.some((x) => x.id === inc.id);
        if (closed) return list.filter((x) => x.id !== inc.id);
        return exists ? list.map((x) => (x.id === inc.id ? inc : x)) : [inc, ...list];
      });
    }, []),
  );
  useSocketEvent<Ambulance>(
    EVENTS.ambulanceLocation,
    useCallback((a) => setAmbulances((list) => list.map((x) => (x.id === a.id ? { ...x, ...a } : x))), []),
  );
  useSocketEvent<HospitalUnit>(
    EVENTS.hospitalCapacity,
    useCallback(
      (u) =>
        setHospitals((list) =>
          list.map((h) =>
            h.id === u.hospitalId ? { ...h, units: h.units.map((x) => (x.unitType === u.unitType ? u : x)) } : h,
          ),
        ),
      [],
    ),
  );
  useSocketEvent('demo:reset', reload);

  const upsertDispatch = useCallback((d: Dispatch) => {
    setDispatches((list) => {
      const done = ['CLEARED', 'CANCELLED'].includes(d.status);
      if (done) return list.filter((x) => x.id !== d.id);
      return list.some((x) => x.id === d.id) ? list.map((x) => (x.id === d.id ? d : x)) : [...list, d];
    });
  }, []);
  useSocketEvent(EVENTS.dispatchAssigned, upsertDispatch);
  useSocketEvent(EVENTS.dispatchStatus, upsertDispatch);

  return { incidents, ambulances, hospitals, dispatches, loaded, reload, setIncidents, setAmbulances, setHospitals };
}
