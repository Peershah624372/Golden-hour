import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { roomAllowed, verifyToken } from './auth';

let io: Server | null = null;

/**
 * Rooms (filtered by role so a hospital only sees its own pre-alerts and a crew only its own jobs):
 *   dispatch            command center + shift leads
 *   admin               admin console
 *   crew:<ambulanceId>  one ambulance crew
 *   er:<hospitalId>     one hospital ER board
 *   incident:<id>       the citizen who reported it (ETA, status)
 *   map                 anything that shows the live fleet map (ambulance positions, capacity)
 */
export function initRealtime(server: HttpServer, corsOrigin: string | string[] | boolean) {
  io = new Server(server, { cors: { origin: corsOrigin } });
  io.on('connection', (socket) => {
    // Same rules as the HTTP API: staff rooms need a staff token for that unit / hospital.
    socket.on('join', (rooms: unknown, token?: unknown) => {
      const user = verifyToken(typeof token === 'string' ? token : null);
      const list = Array.isArray(rooms) ? rooms : [rooms];
      for (const r of list) {
        if (typeof r !== 'string' || !/^(dispatch|admin|map|crew:[\w-]+|er:[\w-]+|incident:[\w-]+)$/.test(r)) continue;
        if (roomAllowed(user, r)) socket.join(r);
        else socket.emit('join:denied', { room: r });
      }
    });
    socket.on('leave', (room: unknown) => {
      if (typeof room === 'string') socket.leave(room);
    });
  });
  return io;
}

/** Number of sockets currently in a room (e.g. is this crew's app open?). */
export function roomSize(room: string): number {
  return io?.sockets.adapter.rooms.get(room)?.size ?? 0;
}

export function closeRealtime() {
  io?.close();
  io = null;
}

export function emit(rooms: string | string[], event: string, payload: unknown) {
  if (!io) return;
  io.to(rooms).emit(event, payload);
}
