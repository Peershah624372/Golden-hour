import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';
import { getIdentity } from './identity';

let socket: Socket | null = null;
/** Room -> how many mounted screens want it (leave only when the last one unmounts). */
const joined = new Map<string, number>();

const token = () => getIdentity()?.token ?? null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_URL || undefined, { transports: ['websocket', 'polling'] });
    // Re-join rooms after every reconnect (the server checks the staff token for each one).
    socket.on('connect', () => {
      if (joined.size) socket!.emit('join', [...joined.keys()], token());
    });
    socket.on('join:denied', (e: { room: string }) => console.warn(`[live] not allowed to join ${e.room}: sign in with the right role`));
  }
  return socket;
}

export function joinRooms(rooms: string[]) {
  const s = getSocket();
  for (const r of rooms) joined.set(r, (joined.get(r) ?? 0) + 1);
  s.emit('join', rooms, token());
}

export function leaveRooms(rooms: string[]) {
  const s = getSocket();
  for (const r of rooms) {
    const n = (joined.get(r) ?? 0) - 1;
    if (n > 0) joined.set(r, n);
    else {
      joined.delete(r);
      s.emit('leave', r);
    }
  }
}

/**
 * Join live rooms for as long as a screen is open. Leaving on unmount matters: a tab that
 * moves from the command center to the citizen SOS page must stop receiving staff traffic.
 */
export function useRooms(rooms: string[]) {
  const key = rooms.filter(Boolean).join(',');
  useEffect(() => {
    if (!key) return;
    const list = key.split(',');
    joinRooms(list);
    return () => leaveRooms(list);
  }, [key]);
}

/** Subscribe to a socket event for the lifetime of a component. */
export function useSocketEvent<T>(event: string, handler: (payload: T) => void) {
  useEffect(() => {
    const s = getSocket();
    s.on(event, handler);
    return () => {
      s.off(event, handler);
    };
  }, [event, handler]);
}

export function useSocketConnected() {
  const [connected, setConnected] = useState(() => getSocket().connected);
  useEffect(() => {
    const s = getSocket();
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    s.on('connect', on);
    s.on('disconnect', off);
    return () => {
      s.off('connect', on);
      s.off('disconnect', off);
    };
  }, []);
  return connected;
}
