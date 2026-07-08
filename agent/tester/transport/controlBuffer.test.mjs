import assert from "node:assert";
import { ProtocolManager } from "../../transport/ProtocolManager.js";

// Minimal fake socket — constructor only reads socket.id
const fakeSocket = { id: "test-socket" };

const BOUND = 5;
const pm = new ProtocolManager(fakeSocket, {
  enableWebRTC: false,
  wsChunkSize: 1024,
  dcChunkSize: 1024,
  dcMaxTilesPerFrame: 10,
  maxControlBuffer: BOUND
});

// No adapters registered → _pickAdapter(control) returns null → every push buffers
assert.strictEqual(pm._adapters.size, 0, "no adapters expected");
for (let i = 0; i < 20; i++) pm._sendControl("evt", [i]);

assert.ok(pm._buffer.length <= BOUND, `buffer bound violated: ${pm._buffer.length} > ${BOUND}`);
// Oldest dropped → newest retained (FIFO shift)
assert.strictEqual(pm._buffer[pm._buffer.length - 1].args[0], 19, "newest message must survive");
assert.strictEqual(pm.hasReadyAdapter(), false, "no ready adapter expected");

console.log(`OK C4 — buffer.length=${pm._buffer.length} (bound=${BOUND}), newest=${pm._buffer[pm._buffer.length - 1].args[0]}`);
