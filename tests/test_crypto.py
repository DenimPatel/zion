"""Crypto tests.

The cipher is pinned to published vectors rather than to a round-trip, because a
cipher that encrypts and decrypts with itself can still be wrong in a way no
round-trip test would notice. The end-to-end test then checks the property the
feature actually promises: geometry is byte-identical locked or unlocked, and
everything that describes the repository is unreadable without the passphrase.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import unittest

from support import TempRepoCase, make_repo, read_bytes, read_json

from vendor.aes_gcm import AES256, gcm_decrypt, gcm_encrypt
from analyzer import crypto as zion_crypto


class CipherVectorTests(unittest.TestCase):
    def test_fips_197_aes_256_block(self):
        key = bytes.fromhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
        plain = bytes.fromhex("00112233445566778899aabbccddeeff")
        self.assertEqual(
            AES256(key).encrypt_block(plain).hex(),
            "8ea2b7ca516745bfeafc49904b496089",
        )

    def test_nist_gcm_case_13_empty(self):
        ciphertext, tag = gcm_encrypt(bytes(32), bytes(12), b"")
        self.assertEqual(ciphertext, b"")
        self.assertEqual(tag.hex(), "530f8afbc74536b9a963b4f1c4cb738b")

    def test_nist_gcm_case_14_one_zero_block(self):
        ciphertext, tag = gcm_encrypt(bytes(32), bytes(12), bytes(16))
        self.assertEqual(ciphertext.hex(), "cea7403d4d606b6e074ec5d3baf39d18")
        self.assertEqual(tag.hex(), "d0d1c8a799996bf0265b98b5d48ab919")

    def test_nist_gcm_case_16_64_bytes(self):
        key = bytes.fromhex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308")
        iv = bytes.fromhex("cafebabefacedbaddecaf888")
        plain = bytes.fromhex(
            "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72"
            "1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255"
        )
        ciphertext, tag = gcm_encrypt(key, iv, plain)
        self.assertEqual(
            ciphertext.hex(),
            "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa"
            "8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad",
        )
        self.assertEqual(tag.hex(), "b094dac5d93471bdec1a502270e3cc6c")
        self.assertEqual(gcm_decrypt(key, iv, ciphertext, tag), plain)

    def test_tampered_ciphertext_is_rejected(self):
        key = bytes(32)
        iv = bytes(12)
        ciphertext, tag = gcm_encrypt(key, iv, b"authentic payload")
        broken = bytearray(ciphertext)
        broken[0] ^= 0x01
        with self.assertRaises(ValueError):
            gcm_decrypt(key, iv, bytes(broken), tag)

    def test_tampered_tag_is_rejected(self):
        key = bytes(32)
        iv = bytes(12)
        ciphertext, tag = gcm_encrypt(key, iv, b"authentic payload")
        with self.assertRaises(ValueError):
            gcm_decrypt(key, iv, ciphertext, bytes(len(tag)))

    def test_aad_is_authenticated(self):
        key = bytes(32)
        iv = bytes(12)
        ciphertext, tag = gcm_encrypt(key, iv, b"payload", b"record-a")
        self.assertEqual(gcm_decrypt(key, iv, ciphertext, tag, b"record-a"), b"payload")
        with self.assertRaises(ValueError):
            gcm_decrypt(key, iv, ciphertext, tag, b"record-b")


class KeyDerivationTests(unittest.TestCase):
    def test_pbkdf2_matches_hashlib_reference(self):
        salt = bytes(range(16))
        key = zion_crypto.derive_key("passphrase", salt, 1000)
        self.assertEqual(key, hashlib.pbkdf2_hmac("sha256", b"passphrase", salt, 1000, 32))

    def test_default_iterations_are_the_declared_310k(self):
        self.assertEqual(zion_crypto.ITERATIONS, 310_000)

    def test_frame_layout_is_what_webcrypto_expects(self):
        meta, encryptor = zion_crypto.prepare("passphrase", workers=1)
        frame = encryptor.encrypt(b"hello", "f/1.json")
        self.assertEqual(frame[:8], b"ZIONENC1")
        self.assertEqual(len(frame[8:20]), 12)  # iv
        self.assertGreaterEqual(len(frame[20:]), 16)  # ciphertext + tag
        self.assertEqual(meta["cipher"], "AES-256-GCM")
        self.assertEqual(meta["kdf"], "PBKDF2-HMAC-SHA256")
        self.assertEqual(len(base64.b64decode(meta["salt"])), 16)


class EncryptedBuildTests(TempRepoCase):
    """The property the feature promises: same geometry, unreadable labels."""

    def _build(self, encrypt: bool, out_name: str):
        repo = make_repo(self.scratch())
        return self.build_city(
            repo,
            out_dir=os.path.join(self._tmp, out_name),
            encrypt=encrypt,
            passphrase="correct horse battery staple" if encrypt else None,
        )

    def test_geometry_is_byte_identical_and_payloads_are_not(self):
        _, _, plain = self._build(False, "plain")
        _, _, locked = self._build(True, "locked")

        for rel in ("city.json",):
            # The manifest legitimately differs: it carries the salt and the
            # encrypted flag.
            self.assertNotEqual(read_bytes(plain.out_dir + "/" + rel), read_bytes(locked.out_dir + "/" + rel))

        # Every district chunk is pure geometry, so it must be identical.
        for name in sorted(os.listdir(os.path.join(plain.out_dir, "d"))):
            self.assertEqual(
                read_bytes(os.path.join(plain.out_dir, "d", name)),
                read_bytes(os.path.join(locked.out_dir, "d", name)),
                f"district chunk {name} changed when encrypted",
            )

        # Everything with a label or a source body must be encrypted.
        for rel in ("strings.bin", "f/0.json", "f/0.src"):
            locked_bytes = read_bytes(os.path.join(locked.out_dir, rel))
            self.assertNotEqual(locked_bytes, read_bytes(os.path.join(plain.out_dir, rel)))
            self.assertEqual(locked_bytes[:8], b"ZIONENC1", rel)

    def test_locked_manifest_leaks_no_labels(self):
        _, _, locked = self._build(True, "locked")
        manifest = read_bytes(os.path.join(locked.out_dir, "city.json"))
        for probe in (b"macroharness", b"test_pipeline", b"Denim", b"pipeline.py"):
            self.assertNotIn(probe, manifest)

        chunks = b"".join(
            read_bytes(os.path.join(locked.out_dir, "d", name))
            for name in sorted(os.listdir(os.path.join(locked.out_dir, "d")))
        )
        for probe in (b"macroharness", b"pipeline.py", b"README"):
            self.assertNotIn(probe, chunks)

    def test_legend_stays_readable_because_it_is_schema_not_data(self):
        _, _, locked = self._build(True, "locked")
        manifest = read_json(os.path.join(locked.out_dir, "city.json"))
        labels = [entry["label"] for entry in manifest["legend"]]
        self.assertTrue(all(isinstance(label, str) and label for label in labels))
        self.assertIn("Logical source lines -> building height", labels)

    def test_python_can_decrypt_what_it_wrote(self):
        """The format must be self-describing enough to read without the viewer."""
        _, _, locked = self._build(True, "locked")
        manifest = read_json(os.path.join(locked.out_dir, "city.json"))
        meta = manifest["crypto"]
        key = zion_crypto.derive_key(
            "correct horse battery staple",
            base64.b64decode(meta["salt"]),
            meta["iterations"],
        )

        frame = read_bytes(os.path.join(locked.out_dir, "strings.bin"))
        self.assertEqual(frame[:8], b"ZIONENC1")
        iv = frame[8:20]
        body = frame[20:]
        plain = gcm_decrypt(key, iv, body[:-16], body[-16:], b"strings.bin")

        self.assertEqual(plain[:8], b"ZIONSTR1")
        count = struct.unpack("<I", plain[8:12])[0]
        self.assertGreater(count, 0)

        # The wrong passphrase must fail loudly rather than yield nonsense.
        wrong = zion_crypto.derive_key(
            "not the passphrase", base64.b64decode(meta["salt"]), meta["iterations"]
        )
        with self.assertRaises(ValueError):
            gcm_decrypt(wrong, iv, body[:-16], body[-16:], b"strings.bin")

    def test_records_are_bound_to_their_own_id(self):
        """A record cannot be moved to another building: the id is the AAD."""
        _, _, locked = self._build(True, "locked")
        manifest = read_json(os.path.join(locked.out_dir, "city.json"))
        meta = manifest["crypto"]
        key = zion_crypto.derive_key(
            "correct horse battery staple",
            base64.b64decode(meta["salt"]),
            meta["iterations"],
        )
        frame = read_bytes(os.path.join(locked.out_dir, "f/0.json"))
        iv, body = frame[8:20], frame[20:]
        with self.assertRaises(ValueError):
            gcm_decrypt(key, iv, body[:-16], body[-16:], b"f/999.json")

    def test_encryption_requires_a_passphrase(self):
        repo = make_repo(self.scratch())
        with self.assertRaises(ValueError):
            self.build_city(
                repo, out_dir=os.path.join(self._tmp, "nopass"), encrypt=True, passphrase=None
            )


if __name__ == "__main__":
    unittest.main()
