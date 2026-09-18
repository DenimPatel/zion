/**
 * Unlocking an encrypted city, in the browser, with WebCrypto.
 *
 * A locked city is not a broken city: the geometry is plaintext, so the skyline
 * renders exactly as it does unlocked. Only the labels are missing, and the
 * locked city fills them with deterministic procedural addresses derived from
 * the manifest salt -- which needs no passphrase, because it is not a secret.
 *
 * Parameter handling matches `analyzer/crypto.py` exactly: PBKDF2-HMAC-SHA256
 * over the manifest salt, AES-256-GCM with a fresh 96-bit IV per record, and the
 * 16-byte tag appended to the ciphertext, which is the layout WebCrypto expects.
 */

const FRAME_MAGIC = 'ZIONENC1';

const STREETS = [
  'Kessler', 'Rowan', 'Amber', 'Beacon', 'Cobalt', 'Dover', 'Ellery', 'Fenwick',
  'Garland', 'Haven', 'Ivory', 'Juniper', 'Kingsway', 'Lantern', 'Marlow',
  'Noble', 'Orchard', 'Pemberton', 'Quarry', 'Rosemont', 'Sable', 'Thistle',
  'Umber', 'Vesper', 'Willow', 'Xenia', 'Yarrow', 'Zephyr', 'Alder', 'Bramble',
];

const KINDS = ['Row', 'Street', 'Avenue', 'Lane', 'Court', 'Way', 'Terrace', 'Walk'];

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Deterministic address for a locked building.
 *
 * Uses HMAC-SHA256 keyed by the (public) manifest salt so the same building
 * always gets the same address across reloads, without revealing anything.
 */
export async function proceduralAddress(buildingId, saltBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    saltBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const message = new TextEncoder().encode(`zion-building-${buildingId}`);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const view = new DataView(mac.buffer);
  const number = 1 + (view.getUint32(0) % 240);
  const street = STREETS[mac[4] % STREETS.length];
  const kind = KINDS[mac[5] % KINDS.length];
  return `${number} ${street} ${kind}`;
}

export function isEncryptedFrame(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  return new TextDecoder().decode(bytes) === FRAME_MAGIC;
}

export class Vault {
  constructor(manifest) {
    this.manifest = manifest;
    this.crypto = (manifest && manifest.crypto) || null;
    this.key = null;
    this.saltBytes = this.crypto ? base64ToBytes(this.crypto.salt) : null;
    this._addressCache = new Map();
  }

  get locked() {
    return Boolean(this.crypto) && this.key === null;
  }

  get encrypted() {
    return Boolean(this.crypto);
  }

  async unlock(passphrase) {
    if (!this.crypto) return false;
    const encoder = new TextEncoder();
    const material = await crypto.subtle.importKey(
      'raw',
      encoder.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    this.key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: this.saltBytes,
        iterations: this.crypto.iterations,
        hash: 'SHA-256',
      },
      material,
      { name: 'AES-GCM', length: this.crypto.keyBits || 256 },
      false,
      ['decrypt']
    );
    return true;
  }

  lock() {
    this.key = null;
  }

  /**
   * Install an already-derived AES key, skipping PBKDF2.
   *
   * Used by headless verification: Chrome's virtual clock never lets a
   * 310,000-iteration PBKDF2 promise settle, so the *decryption* path (frame
   * parsing, additional data, tag verification, string decoding, unlock in
   * place) is exercised with a key derived outside the browser. PBKDF2 itself is
   * verified against the manifest parameters separately. The user-facing flow
   * always goes through `unlock()`.
   */
  async useRawKey(rawBytes) {
    this.key = await crypto.subtle.importKey(
      'raw',
      rawBytes,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    return true;
  }

  /** Decrypt one framed record. Throws if the tag does not verify. */
  async decryptFrame(buffer, recordId) {
    if (!this.key) throw new Error('locked');
    const bytes = new Uint8Array(buffer);
    const magic = new TextDecoder().decode(bytes.subarray(0, 8));
    if (magic !== FRAME_MAGIC) {
      throw new Error(`not an encrypted record (found "${magic}")`);
    }
    const iv = bytes.subarray(8, 8 + 12);
    const body = bytes.subarray(20); // ciphertext || tag, as WebCrypto wants
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode(recordId),
        tagLength: 128,
      },
      this.key,
      body
    );
    return plain;
  }

  async addressFor(buildingId) {
    if (this._addressCache.has(buildingId)) return this._addressCache.get(buildingId);
    const address = await proceduralAddress(buildingId, this.saltBytes);
    this._addressCache.set(buildingId, address);
    return address;
  }
}
