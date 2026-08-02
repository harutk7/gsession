import { EventEmitter } from 'events';

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const buffer = [];
let seq = 0;

// Record an event and broadcast it to live (SSE) listeners.
export function push(type, data = {}) {
  const evt = { id: ++seq, ts: new Date().toISOString(), type, ...data };
  buffer.push(evt);
  if (buffer.length > 200) buffer.shift();
  emitter.emit('event', evt);
  return evt;
}

export function recent(limit = 60) {
  return buffer.slice(-limit);
}

// Subscribe to live events. Returns an unsubscribe function.
export function onEvent(fn) {
  emitter.on('event', fn);
  return () => emitter.off('event', fn);
}
