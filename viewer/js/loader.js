/**
 * Loading city data and resolving the string table.
 *
 * The viewer never parses source and never sees a path until it resolves an
 * integer index through `strings.bin`. That indirection is what lets the same
 * geometry render with real labels or, when the city was built with --encrypt,
 * with nothing but ciphertext until a passphrase unlocks it.
 */

const STRING_MAGIC = 'ZIONSTR1';

async function getJSON(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

async function getBuffer(url) {
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
    this._chunks = new Map();
  }

  /** Resolve a string index. Locked cities return the procedural placeholder. */
  s(index) {
    if (index === null || index === undefined || index < 0) return '';
    if (!this.strings || index >= this.strings.length) return '';
    return this.strings[index] ?? '';
  }

  async load(progress = () => {}) {
    progress('reading manifest');
    this.manifest = await getJSON(`${this.base}/city.json`);
    this.districts = this.manifest.districts || [];
    return this.manifest;
  }

  async loadStrings() {
    const buffer = await getBuffer(`${this.base}/strings.bin`);
    this.strings = decodeStrings(buffer);
    return this.strings;
  }

  /** Fetch one district chunk, memoised. */
  async chunk(districtId) {
    if (this._chunks.has(districtId)) return this._chunks.get(districtId);
    const district = this.districts.find((d) => d.id === districtId);
    if (!district) return null;
    const chunk = await getJSON(`${this.base}/${district.chunk}`);
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
    return getJSON(`${this.base}/${building.detail}`);
  }

  async source(building) {
    if (!building.source) return '';
    const buffer = await getBuffer(`${this.base}/${building.source}`);
    return new TextDecoder().decode(buffer);
  }
}
