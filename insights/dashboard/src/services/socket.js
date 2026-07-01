// Single shared socket.io connection. Same-origin so it rides the Vite proxy
// (/socket.io -> collector). Server emits: 'event', 'system-sample',
// 'sessions-changed'. Reconnection is handled by socket.io itself.
import { io } from 'socket.io-client'

let socket = null

export function getSocket() {
  if (!socket) {
    socket = io('/', {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    })
  }
  return socket
}
