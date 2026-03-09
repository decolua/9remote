/**
 * BaseProtocol — abstract interface all transport adapters must implement.
 *
 * Interface:
 *   on(event, handler)      — subscribe to incoming events
 *   off(event, handler)     — unsubscribe
 *   emit(event, data)       — send outgoing event
 *   connect()               — establish connection
 *   disconnect()            — tear down connection
 *   type                    — "ws" | "dc-stun" | "dc-turn"
 *   connected               — boolean
 */
export class BaseProtocol {
  get type() { throw new Error("Not implemented: type"); }
  get connected() { throw new Error("Not implemented: connected"); }
  on(_event, _handler) { throw new Error("Not implemented: on"); }
  off(_event, _handler) { throw new Error("Not implemented: off"); }
  emit(_event, _data) { throw new Error("Not implemented: emit"); }
  connect() { throw new Error("Not implemented: connect"); }
  disconnect() { throw new Error("Not implemented: disconnect"); }
}
