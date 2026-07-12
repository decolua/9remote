"use client";

import { useCallback, useEffect, useMemo } from "react";
import { usePersistedState } from "@/shared/hooks/usePersistedState";

// Manage a persisted list of key IDs (flat) OR 2D grid of IDs.
// mode "flat"  → state: string[]          → for single-row bars
// mode "grid"  → state: string[][]        → for multi-row panels (fixed row count)
export function useCustomKeys(storageKey, pool, defaultValue, mode = "flat", legacyDefaults = []) {
  const [state, setState, reset] = usePersistedState(storageKey, defaultValue);
  const map = useMemo(() => new Map(pool.map(k => [k.id, k])), [pool]);

  // Migrate: if persisted state exactly matches a legacy default, upgrade to current default.
  // Only fires when the user never customized — idempotent (after upgrade, no legacy match).
  const flatState = mode === "grid" ? state?.flat?.() : state;
  const equals = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  const isLegacy = flatState && legacyDefaults.some(legacy => mode === "grid" ? equals(legacy.flat(), flatState) : equals(legacy, flatState));
  const migrated = isLegacy ? defaultValue : state;

  const resolve = useCallback((ids) => ids.map(id => map.get(id)).filter(Boolean), [map]);

  // Expected row count for grid mode = defaultValue.length (source of truth)
  const expectedRowCount = mode === "grid" && Array.isArray(defaultValue) ? defaultValue.length : 1;

  // Normalize shape defensively. If legacy/corrupted shape in grid mode → fallback to default.
  const rows = useMemo(() => {
    if (mode === "grid") {
      const validGrid = Array.isArray(migrated) && migrated.length === expectedRowCount && migrated.every(Array.isArray);
      if (validGrid) return migrated;
      return defaultValue; // restore default when shape invalid (e.g. legacy flat)
    }
    return [Array.isArray(migrated) ? migrated : []];
  }, [migrated, mode, defaultValue, expectedRowCount]);
  const keys = useMemo(() => resolve(rows.flat()), [rows, resolve]);
  const available = useMemo(() => {
    const used = new Set(keys.map(k => k.id));
    return pool.filter(k => !used.has(k.id));
  }, [keys, pool]);

  // Get/set a single row (always returns array)
  const getRow = useCallback((r) => (mode === "grid" ? migrated[r] || [] : migrated), [migrated, mode]);

  // Persist migration: when state matched a legacy default, write upgraded value back.
  useEffect(() => {
    if (isLegacy) setState(defaultValue);
  }, [isLegacy, defaultValue, setState]);

  const updateRows = useCallback((fn) => {
    setState(prev => {
      if (mode === "grid") {
        const validGrid = Array.isArray(prev) && prev.length === expectedRowCount && prev.every(Array.isArray);
        const base = validGrid ? prev.map(r => [...r]) : defaultValue.map(r => [...r]);
        return fn(base);
      }
      const flat = Array.isArray(prev) ? prev : [];
      return fn([[...flat]])[0];
    });
  }, [setState, mode, defaultValue, expectedRowCount]);

  const add = useCallback((id, row = 0) => {
    updateRows(rowsArr => {
      if (!rowsArr[row]) rowsArr[row] = [];
      if (!rowsArr.flat().includes(id)) rowsArr[row] = [...rowsArr[row], id];
      return rowsArr;
    });
  }, [updateRows]);

  const removeAt = useCallback((row, col) => {
    updateRows(rowsArr => {
      if (!rowsArr[row]) return rowsArr;
      rowsArr[row] = rowsArr[row].filter((_, i) => i !== col);
      return rowsArr;
    });
  }, [updateRows]);

  const replaceAt = useCallback((row, col, id) => {
    updateRows(rowsArr => {
      if (!rowsArr[row]) rowsArr[row] = [];
      const existing = rowsArr.flat().indexOf(id);
      // If id already placed elsewhere, remove it first (uniqueness)
      if (existing >= 0) {
        for (const r of rowsArr) {
          const ci = r.indexOf(id);
          if (ci >= 0) r.splice(ci, 1);
        }
      }
      // Insert/replace at target
      if (col >= rowsArr[row].length) rowsArr[row].push(id);
      else rowsArr[row][col] = id;
      return rowsArr;
    });
  }, [updateRows]);

  const swap = useCallback((a, b) => {
    updateRows(rowsArr => {
      const rA = rowsArr[a.row], rB = rowsArr[b.row];
      if (!rA || !rB) return rowsArr;
      const tmp = rA[a.col];
      rA[a.col] = rB[b.col];
      rB[b.col] = tmp;
      return rowsArr;
    });
  }, [updateRows]);

  return {
    mode, rows, keys, available,
    getRow, add, removeAt, replaceAt, swap, reset
  };
}
