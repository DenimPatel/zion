/**
 * The reader's own notes on buildings: "split this before Q3", "ask Ada".
 *
 * Kept in this browser's localStorage, keyed by the city (its root folder name
 * and file count, both public in the manifest) and by the file's *path*, not
 * its building id -- ids are reassigned when the repository changes, paths
 * survive a rebuild. A locked city has no paths to key by, so notes wait for
 * the unlock. Storage can be unavailable (a private window, blocked site
 * data); every access is guarded and the viewer simply works without notes.
 *
 * Export/import is plain JSON, so notes can be handed to a colleague or kept
 * next to the repository.
 */

const PREFIX = 'zion-notes:';

function storage() {
  try {
    const store = window.localStorage;
    const probe = `${PREFIX}probe`;
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch (error) {
    return null;
  }
}

export class Notes {
  constructor(cityKey) {
    this.key = `${PREFIX}${cityKey}`;
    this.store = storage();
    this.items = {};
    this.listeners = [];
    this._load();
  }

  get available() {
    return Boolean(this.store);
  }

  _load() {
    if (!this.store) return;
    try {
      const raw = this.store.getItem(this.key);
      const parsed = raw ? JSON.parse(raw) : {};
      this.items = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      this.items = {};
    }
  }

  _save() {
    if (!this.store) return false;
    try {
      this.store.setItem(this.key, JSON.stringify(this.items));
    } catch (error) {
      return false;
    }
    for (const listener of this.listeners) listener();
    return true;
  }

  onChange(listener) {
    this.listeners.push(listener);
  }

  get(path) {
    const item = path ? this.items[path] : null;
    return item ? item.text : '';
  }

  set(path, text) {
    if (!path) return false;
    const trimmed = String(text || '').trim();
    if (trimmed) this.items[path] = { text: trimmed, at: new Date().toISOString() };
    else delete this.items[path];
    return this._save();
  }

  /** `[{path, text, at}]`, newest first. */
  all() {
    return Object.entries(this.items)
      .map(([path, item]) => ({ path, text: item.text, at: item.at }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  exportJson() {
    return JSON.stringify({ format: 'zion-notes', version: 1, notes: this.items }, null, 2);
  }

  /** Merge notes from an export; returns how many were added or replaced. */
  importJson(text) {
    const data = JSON.parse(text);
    const notes = data && data.format === 'zion-notes' ? data.notes : null;
    if (!notes || typeof notes !== 'object') throw new Error('not a Zion notes export');
    let count = 0;
    for (const [path, item] of Object.entries(notes)) {
      if (item && typeof item.text === 'string' && item.text.trim()) {
        this.items[path] = { text: item.text.trim(), at: item.at || new Date().toISOString() };
        count++;
      }
    }
    this._save();
    return count;
  }
}
