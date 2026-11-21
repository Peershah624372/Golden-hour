import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';

let socket: Socket | null = null;
const joined = new Set<string>();

export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_URL || undefined, { transports: ['websocket', 'polling'] });
    // Re-join rooms after every reconnect.
    socket.on('connect', () => {
      if (joined.size) socket!.emit('join', [...joined]);
    });
  }
  return socket;
}

export function joinRooms(rooms: string[]) {
  const s = getSocket();
  rooms.forEach((r) => joined.add(r));
  s.emit('join', rooms);
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
