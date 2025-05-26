export function setupStreamConnection(ws: import('ws').WebSocket, req: import('http').IncomingMessage): void;
export function setupStreamHeartbeat(wss: import('ws').Server): NodeJS.Timeout;
export function cleanup(): void;
