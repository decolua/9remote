// Multi-monitor registry. Stable identity via name+dims+pos (m.id() changes per run).
import { Monitor } from "node-screenshots";

export class MonitorManager {
  constructor() {
    this._list = [];
    this._activeIndex = 0;
    this._byIdentity = new Map();
    this.refresh();
  }

  _identity(m) {
    return `${m.name()}|${m.width()}x${m.height()}|${m.x()},${m.y()}|scale=${m.scaleFactor()}`;
  }

  // Re-enumerate monitors. Returns true if the set changed since the last call
  // (identity = name+dims+pos+scale), so callers can re-pin stale capture handles.
  refresh() {
    let all = [];
    try {
      all = Monitor.all();
    } catch (err) {
      return false;
    }
    const prevIdentities = new Set(this._list.map((e) => e.identity));
    const next = all.map((mon, index) => {
      const identity = this._identity(mon);
      const entry = {
        index,
        mon,
        identity,
        name: mon.name(),
        w: mon.width(),
        h: mon.height(),
        x: mon.x(),
        y: mon.y(),
        scale: mon.scaleFactor(),
        primary: typeof mon.isPrimary === "function" ? mon.isPrimary() : index === 0,
      };
      this._byIdentity.set(identity, entry);
      return entry;
    });
    this._list = next;
    const changed = prevIdentities.size !== next.length ||
      next.some((e) => !prevIdentities.has(e.identity));
    if (!this._list.find((e) => e.index === this._activeIndex)) {
      const primary = this._list.find((e) => e.primary);
      this._activeIndex = primary ? primary.index : (this._list[0]?.index ?? 0);
    }
    return changed;
  }

  list() {
    return this._list.map((e) => ({
      index: e.index, name: e.name, width: e.w, height: e.h,
      x: e.x, y: e.y, scale: e.scale, primary: e.primary,
    }));
  }

  getActive() {
    return this._list[this._activeIndex] ?? null;
  }

  getActiveIndex() {
    return this._activeIndex;
  }

  setActive(index) {
    if (!this._list.find((e) => e.index === index)) return false;
    this._activeIndex = index;
    return true;
  }
}
