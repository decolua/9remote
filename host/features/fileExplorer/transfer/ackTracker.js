// Cumulative-ACK tracker. Receiver records chunks as they arrive (any order,
// possible duplicates) and reports the contiguous high-watermark so the sender
// can ACK many chunks with one message.
export class AckTracker {
  constructor(totalSize) {
    this.totalSize = totalSize;
    this._contiguous = 0;        // bytes confirmed contiguous from offset 0
    this._gaps = new Map();      // offset (beyond contiguous) → length
    this._watermark = 0;
  }

  highWatermark() { return this._watermark; }

  // Record a received chunk. Returns the new high-watermark if it advanced,
  // or null if this chunk didn't extend the contiguous prefix (gap still open
  // or duplicate).
  mark(offset, length) {
    if (this.totalSize === 0) return null;
    if (offset < this._contiguous) return null; // duplicate / already covered
    this._gaps.set(offset, length);
    while (this._gaps.has(this._contiguous)) {
      const len = this._gaps.get(this._contiguous);
      this._gaps.delete(this._contiguous);
      this._contiguous += len;
    }
    if (this._contiguous > this._watermark) {
      this._watermark = this._contiguous;
      return this._watermark;
    }
    return null;
  }

  isComplete() {
    return this._watermark >= this.totalSize;
  }
}
