"""Encryption for `--encrypt`: AES-256-GCM with a WebCrypto-compatible layout.

Design constraints, all of which shaped the code:

* The browser must be able to decrypt with WebCrypto alone. WebCrypto appends
  the 16-byte tag to the ciphertext and wants a 96-bit IV, so records are framed
  that way here.
* Geometry must stay plaintext. Only `strings.bin` and the `f/*` payloads are
  encrypted, so a locked city has byte-identical geometry and an identical
  skyline.
* The pure-Python cipher runs at about 0.44 MB/s, and interiors carry full
  source, so an 11 MB corpus would take ~27 s single-threaded. Records are
  therefore encrypted across processes, which brings it to a few seconds.

`cryptography` is tried first for portability; on this machine it is not
installed at all, so the vendored pure-Python implementation is the real path.
"""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
from dataclasses import dataclass

FRAME_MAGIC = b"ZIONENC1"
KDF = "PBKDF2-HMAC-SHA256"
CIPHER = "AES-256-GCM"
ITERATIONS = 310_000
SALT_BYTES = 16
IV_BYTES = 12
TAG_BYTES = 16
KEY_BYTES = 32

# Beyond this many bytes, encrypting in parallel beats the process-pool overhead.
PARALLEL_THRESHOLD_BYTES = 256 * 1024


def derive_key(passphrase: str, salt: bytes, iterations: int = ITERATIONS) -> bytes:
    """PBKDF2-HMAC-SHA256. hashlib's implementation is C, so this is ~0.1 s."""
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt, iterations, KEY_BYTES)


def _backend():
    """Return (encrypt_fn, name) preferring a real library when one exists."""
    try:  # pragma: no cover - depends on the host environment
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: F401

        def encrypt(key: bytes, iv: bytes, data: bytes, aad: bytes) -> bytes:
            return AESGCM(key).encrypt(iv, data, aad)

        return encrypt, "cryptography"
    except Exception:
        pass

    from vendor.aes_gcm import gcm_encrypt

    def encrypt(key: bytes, iv: bytes, data: bytes, aad: bytes) -> bytes:
        ciphertext, tag = gcm_encrypt(key, iv, data, aad)
        return ciphertext + tag

    return encrypt, "vendor/aes_gcm.py (pure Python)"


_encrypt_impl, BACKEND_NAME = _backend()


def frame(key: bytes, plaintext: bytes, record_id: str) -> bytes:
    """One self-contained encrypted record.

    Layout: magic | iv(12) | ciphertext | tag(16). The record id is authenticated
    as additional data, so a record cannot be moved to another building.
    """
    iv = secrets.token_bytes(IV_BYTES)
    aad = record_id.encode("utf-8")
    return FRAME_MAGIC + iv + _encrypt_impl(key, iv, plaintext, aad)


def encode_salt(salt: bytes) -> str:
    return base64.b64encode(salt).decode("ascii")


# ---------------------------------------------------------------------------
# Worker plumbing for parallel encryption
# ---------------------------------------------------------------------------

_WORKER_KEY: bytes | None = None


def _worker_init(key: bytes) -> None:  # pragma: no cover - runs in a subprocess
    global _WORKER_KEY
    _WORKER_KEY = key


def _worker_frame(job: tuple[str, bytes]) -> bytes:  # pragma: no cover - subprocess
    record_id, data = job
    assert _WORKER_KEY is not None
    return frame(_WORKER_KEY, data, record_id)


@dataclass
class Encryptor:
    """Encrypts records, in parallel when there is enough work to justify it."""

    key: bytes
    workers: int = 0
    enabled: bool = True

    def encrypt(self, data: bytes, record_id: str) -> bytes:
        if not self.enabled:
            return data
        return frame(self.key, data, record_id)

    def encrypt_many(self, jobs: list[tuple[str, bytes]]) -> list[bytes]:
        """Encrypt [(record_id, data), ...] preserving order."""
        if not self.enabled or not jobs:
            return [data for _, data in jobs]
        if self.workers <= 1 or sum(len(d) for _, d in jobs) < PARALLEL_THRESHOLD_BYTES:
            return [frame(self.key, data, record_id) for record_id, data in jobs]

        import multiprocessing

        # Small records are not worth shipping to a subprocess.
        with multiprocessing.Pool(
            processes=self.workers, initializer=_worker_init, initargs=(self.key,)
        ) as pool:
            return pool.map(_worker_frame, jobs, chunksize=4)


def default_workers() -> int:
    count = os.cpu_count() or 1
    return max(1, min(8, count))


def prepare(passphrase: str, workers: int | None = None) -> tuple[dict, Encryptor]:
    """Return (manifest crypto block, encryptor)."""
    salt = secrets.token_bytes(SALT_BYTES)
    key = derive_key(passphrase, salt)
    meta = {
        "cipher": CIPHER,
        "kdf": KDF,
        "iterations": ITERATIONS,
        "salt": encode_salt(salt),
        "keyBits": KEY_BYTES * 8,
        "saltBytes": SALT_BYTES,
        "ivBytes": IV_BYTES,
        "tagBytes": TAG_BYTES,
        "frame": FRAME_MAGIC.decode("ascii"),
        "aad": "record-id",
        "scope": ["strings.bin", "f/*.json", "f/*.src"],
        "backend": BACKEND_NAME,
    }
    return meta, Encryptor(key=key, workers=workers if workers is not None else default_workers())
