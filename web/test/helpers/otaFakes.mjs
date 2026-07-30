// In-memory D1/KV fakes for OTA tests — just enough SQL to exercise the
// service invariants (no SQL engine, matching only the statements we issue).

// Primary keys mirror migrations/008_ota.sql so INSERT OR REPLACE behaves as D1 does
const PRIMARY_KEYS = {
  otaUpdateGroup: ["id"],
  otaChannelPointer: ["channel", "runtimeVersion", "platform"]
};

const TABLES = Object.keys(PRIMARY_KEYS);

// Extract "col = ?" pairs from a WHERE clause, in bind order
function whereCols(sql) {
  const where = sql.split(/\bWHERE\b/i)[1];
  if (!where) return [];
  return [...where.matchAll(/(\w+)\s*(=|!=)\s*\?/g)].map((m) => ({ col: m[1], op: m[2] }));
}

function matches(row, conds, values) {
  return conds.every(({ col, op }, i) =>
    op === "=" ? row[col] === values[i] : row[col] !== values[i]);
}

export function makeFakeD1() {
  const data = Object.fromEntries(TABLES.map((t) => [t, []]));
  let queries = 0;

  const tableOf = (sql) => TABLES.find((t) => sql.includes(t));

  const prepare = (sql) => {
    let values = [];
    const api = {
      bind: (...v) => { values = v; return api; },

      first: async () => {
        queries++;
        const rows = data[tableOf(sql)] || [];
        const conds = whereCols(sql);
        let hit = rows.filter((r) => matches(r, conds, values));
        if (/ORDER BY\s+buildNumber\s+DESC/i.test(sql)) {
          hit = [...hit].sort((a, b) => b.buildNumber - a.buildNumber);
        }
        return hit[0] ? { ...hit[0] } : null;
      },

      all: async () => {
        queries++;
        const rows = data[tableOf(sql)] || [];
        const conds = whereCols(sql);
        return { results: rows.filter((r) => matches(r, conds, values)).map((r) => ({ ...r })) };
      },

      run: async () => {
        queries++;
        const table = tableOf(sql);

        if (/^\s*INSERT/i.test(sql)) {
          const cols = sql.match(/\(([^)]+)\)\s*VALUES/i)[1].split(",").map((c) => c.trim());
          const row = Object.fromEntries(cols.map((c, i) => [c, values[i]]));
          if (/^\s*INSERT\s+OR\s+REPLACE/i.test(sql)) {
            const pk = PRIMARY_KEYS[table];
            data[table] = data[table].filter((r) => !pk.every((c) => r[c] === row[c]));
          }
          data[table].push(row);
          return { success: true };
        }

        if (/^\s*UPDATE/i.test(sql)) {
          const setPart = sql.split(/\bSET\b/i)[1].split(/\bWHERE\b/i)[0];
          const setCols = [...setPart.matchAll(/(\w+)\s*=\s*\?/g)].map((m) => m[1]);
          const conds = whereCols(sql);
          const setVals = values.slice(0, setCols.length);
          const whereVals = values.slice(setCols.length);
          for (const row of data[table]) {
            if (matches(row, conds, whereVals)) {
              setCols.forEach((c, i) => { row[c] = setVals[i]; });
            }
          }
          return { success: true };
        }

        if (/^\s*DELETE/i.test(sql)) {
          const conds = whereCols(sql);
          data[table] = data[table].filter((r) => !matches(r, conds, values));
          return { success: true };
        }

        return { success: true };
      }
    };
    return api;
  };

  return {
    prepare,
    _rows: (table) => data[table],
    _queryCount: () => queries
  };
}

export function makeFakeKV() {
  const store = new Map();
  return {
    get: async (key, type) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); }
  };
}
