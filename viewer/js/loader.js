/**
 * Loading city data and resolving the string table.
 *
 * The viewer never parses source and never sees a path until it resolves an
 * integer index through `strings.bin`. That indirection is what lets the same
 * geometry render with real labels or, when the city was built with --encrypt,
 * with nothing but ciphertext until a passphrase unlocks it.
 */

import { isEncryptedFrame } from './vault.js';

const STRING_MAGIC = 'ZIONSTR1';

/**
 * The single-file build inlines every payload as base64, because a
 * `file://` document has no origin and therefore cannot fetch anything.
 */
function embeddedBuffer(rel) {
  const payload = globalThis.__ZION_PAYLOAD__;
  if (!payload) return null;
  const key = rel.replace(/^\.\//, '');
  if (!(key in payload)) return null;
  const binary = atob(payload[key]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getJSON(base, rel) {
  const buffer = embeddedBuffer(rel);
  if (buffer) return JSON.parse(new TextDecoder().decode(buffer));
  const url = `${base}/${rel}`;
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

async function getBuffer(base, rel) {
  const buffer = embeddedBuffer(rel);
  if (buffer) return buffer;
  const url = `${base}/${rel}`;
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.arrayBuffer();
}

/** Decode the plain string table container: magic, count, then length-prefixed UTF-8. */
export function decodeStrings(buffer) {
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (magic !== STRING_MAGIC) {
    throw new Error(
      `string table is not plaintext (found "${magic}"). This city was built with --encrypt; ` +
        'unlock it with the passphrase to read real names.'
    );
  }
  const view = new DataView(buffer);
  const count = view.getUint32(8, true);
  const decoder = new TextDecoder();
  const strings = new Array(count);
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const length = view.getUint32(offset, true);
    offset += 4;
    strings[i] = decoder.decode(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return strings;
}

export class CitySource {
  constructor(base = '.') {
    this.base = base.replace(/\/$/, '');
    this.manifest = null;
    this.strings = null;
    this.districts = [];
    this.buildings = [];
    this.vault = null;
    this.locked = false;
    this._chunks = new Map();
    this._addresses = new Map();
  }

  /** Resolve a string index. Returns '' while the city is still locked. */
  s(index) {
    if (index === null || index === undefined || index < 0) return '';
    if (!this.strings || index >= this.strings.length) return '';
    return this.strings[index] ?? '';
  }

  /** A building's label: its real name, or a procedural address when locked. */
  label(building) {
    if (!this.locked) return this.s(building.name);
    return this._addresses.get(building.id) || `${building.archetype} ${building.id}`;
  }

  districtLabel(district) {
    if (!this.locked) return this.districtName(district);
    return `District ${district.id}`;
  }

  async assignLockedAddresses(buildings) {
    if (!this.locked || !this.vault) return;
    for (const building of buildings) {
      if (this._addresses.has(building.id)) continue;
      this._addresses.set(building.id, await this.vault.addressFor(building.id));
    }
  }

  async load(progress = () => {}) {
    progress('reading manifest');
    this.manifest = await getJSON(this.base, 'city.json');
    this.districts = this.manifest.districts || [];
    return this.manifest;
  }

  async loadStrings() {
    const buffer = await getBuffer(this.base, 'strings.bin');
    if (this.manifest && this.manifest.meta && this.manifest.meta.encrypted) {
      // Leave the labels unread until a passphrase arrives; the geometry in the
      // chunks is plaintext and does not depend on this.
      this.locked = true;
      this.strings = null;
      this._rawStrings = buffer;
      return null;
    }
    this.strings = decodeStrings(buffer);
    this.locked = false;
    return this.strings;
  }

  /** Decrypt and install the real string table after a successful unlock. */
  async unlockStrings() {
    if (!this.vault || !this._rawStrings) throw new Error('nothing to unlock');
    const plain = await this.vault.decryptFrame(this._rawStrings, 'strings.bin');
    this.strings = decodeStrings(plain);
    this.locked = false;
    return this.strings;
  }

  /** Fetch one district chunk, memoised. */
  async chunk(districtId) {
    if (this._chunks.has(districtId)) return this._chunks.get(districtId);
    const district = this.districts.find((d) => d.id === districtId);
    if (!district) return null;
    const chunk = await getJSON(this.base, district.chunk);
    this._chunks.set(districtId, chunk);
    return chunk;
  }

  districtName(district) {
    const key = this.s(district.key);
    return key === '(root)' ? 'root files' : key;
  }

  /** Every building in a district, with its district attached. */
  async buildingsFor(districtId) {
    const chunk = await this.chunk(districtId);
    if (!chunk) return [];
    return (chunk.buildings || []).map((b) => ({ ...b, districtId }));
  }

  async loadAll(progress = () => {}) {
    await this.load(progress);
    progress('unlocking labels');
    await this.loadStrings();
    const out = [];
    for (const district of this.districts) {
      out.push(...(await this.buildingsFor(district.id)));
    }
    this.buildings = out;
    progress('placing buildings');
    return out;
  }

  async detail(building) {
    const buffer = await getBuffer(this.base, building.detail);
    if (!isEncryptedFrame(buffer)) return JSON.parse(new TextDecoder().decode(buffer));
    if (!this.vault || this.vault.locked) throw new Error('city is locked');
    const plain = await this.vault.decryptFrame(buffer, building.detail);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async source(building) {
    if (!building.source) return '';
    const buffer = await getBuffer(this.base, building.source);
    if (!isEncryptedFrame(buffer)) return new TextDecoder().decode(buffer);
    if (!this.vault || this.vault.locked) throw new Error('city is locked');
    const plain = await this.vault.decryptFrame(buffer, building.source);
    return new TextDecoder().decode(plain);
  }
}
