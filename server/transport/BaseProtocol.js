/**
 * BaseProtocol — abstract interface all server transport adapters must implement.
 *
 * Interface:
 *   emit(event, data)      — send JSON event to client
 *   sendBinary(chunks)     — send binary chunks (WebRTC only; WS no-op)
 *   type                   — "ws" | "dc"
 *   isReady()              — boolean
 */
export class BaseProtocol {
  get type() { throw new Error("Not implemented: type"); }
  emit(_event, _data) { throw new Error("Not implemented: emit"); }
  sendBinary(_chunks) { throw new Error("Not implemented: sendBinary"); }
  isReady() { throw new Error("Not implemented: isReady"); }
}
