import { MAX_SAVED_WORKSPACES, parseSavedWorkspace, type SavedWorkspace } from './protocol';

export type WorkspacePersistence = {
  readonly durable: boolean;
  load(): Promise<SavedWorkspace[]>;
  put(profile: SavedWorkspace): Promise<void>;
  remove(id: string): Promise<void>;
};
export type SecureKeyValue = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};
const INDEX = 'perch.workspaces.v1.index';
const keyFor = (id: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid saved workspace identity.');
  return `perch.workspaces.v1.${id}`;
};

/** One small encrypted item per workspace; no provider or infrastructure keys. */
export function secureWorkspacePersistence(storage: SecureKeyValue): WorkspacePersistence {
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const next = tail.then(action, action); tail = next.catch(() => {}); return next;
  }
  async function ids(): Promise<string[]> {
    const raw = await storage.get(INDEX); if (raw === null) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > MAX_SAVED_WORKSPACES || !value.every(item => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item)) || new Set(value).size !== value.length) throw new Error('The saved workspace index is invalid.');
    // Token deletion commits first. Reconcile a stale index left by an interrupted
    // removal so it cannot permanently consume a workspace slot.
    const present: string[] = [];
    for (const id of value) if (await storage.get(keyFor(id)) !== null) present.push(id);
    return present;
  }
  return {
    durable: true,
    load: () => serial(async () => {
      const result: SavedWorkspace[] = [];
      for (const id of await ids()) {
        const raw = await storage.get(keyFor(id));
        if (raw === null) continue; // A completed token removal can precede an interrupted index write.
        const profile = parseSavedWorkspace(JSON.parse(raw));
        if (profile.id !== id) throw new Error('A saved workspace identity does not match its record.');
        result.push(profile);
      }
      return result;
    }),
    put: profile => serial(async () => {
      const checked = parseSavedWorkspace(profile); const current = await ids();
      const exists = current.includes(checked.id);
      if (!exists && current.length >= MAX_SAVED_WORKSPACES) throw new Error('Remove a saved workspace before adding another.');
      const key = keyFor(checked.id); const previous = await storage.get(key);
      await storage.set(key, JSON.stringify(checked));
      if (exists) return;
      try { await storage.set(INDEX, JSON.stringify([...current, checked.id])); }
      catch (error) {
        // Do not leave a new token behind if adding it to the index fails.
        if (previous === null) await storage.remove(key); else await storage.set(key, previous);
        throw error;
      }
    }),
    remove: id => serial(async () => {
      const current = await ids();
      await storage.remove(keyFor(id));
      await storage.set(INDEX, JSON.stringify(current.filter(item => item !== id)));
    }),
  };
}

/** Browser previews intentionally keep workspace credentials in memory. */
export function memoryWorkspacePersistence(): WorkspacePersistence {
  const profiles = new Map<string, SavedWorkspace>();
  return { durable: false, load: async () => [...profiles.values()].map(item => ({ ...item })),
    put: async profile => { profiles.set(profile.id, parseSavedWorkspace(profile)); },
    remove: async id => { profiles.delete(id); } };
}
