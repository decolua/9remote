// Adapter registry — DRY plugin point.
// Adapter file imports + calls registerProtocol(Class) once at module load.

const _registry = new Map();

export function registerProtocol(AdapterClass) {
  if (!AdapterClass?.id) throw new Error("Adapter missing static id");
  _registry.set(AdapterClass.id, AdapterClass);
}

export function getProtocol(id) {
  return _registry.get(id);
}

export function listProtocols() {
  return [..._registry.values()];
}
