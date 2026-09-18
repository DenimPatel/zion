"""Pure-Python AES-256-GCM, compatible with WebCrypto.

This exists because the analyzer promises to run on the standard library alone,
and this machine has no usable crypto library at all: `cryptography` is not
installed, and OpenSSL's `enc` subcommand has no AEAD support, so it cannot
produce or verify a GCM tag. Node's AES-GCM is roughly a thousand times faster,
but using it would make the analyzer depend on Node.

Only the forward cipher is needed: GCM uses AES for the counter and for the
authentication key, never for decryption of the block cipher itself.

Correctness is pinned to the NIST GCM test vectors in `tests/test_crypto.py`
rather than to "it round-trips", because a cipher that round-trips with itself
can still be wrong.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# AES tables
# ---------------------------------------------------------------------------

SBOX = bytes.fromhex(
    "637c777bf26b6fc53001672bfed7ab76"
    "ca82c97dfa5947f0add4a2af9ca472c0"
    "b7fd9326363ff7cc34a5e5f171d83115"
    "04c723c31896059a071280e2eb27b275"
    "09832c1a1b6e5aa0523bd6b329e32f84"
    "53d100ed20fcb15b6acbbe394a4c58cf"
    "d0efaafb434d338545f9027f503c9fa8"
    "51a3408f929d38f5bcb6da2110fff3d2"
    "cd0c13ec5f974417c4a77e3d645d1973"
    "60814fdc222a908846eeb814de5e0bdb"
    "e0323a0a4906245cc2d3ac629195e479"
    "e7c8376d8dd54ea96c56f4ea657aae08"
    "ba78252e1ca6b4c6e8dd741f4bbd8b8a"
    "703eb5664803f60e613557b986c11d9e"
    "e1f8981169d98e949b1e87e9ce5528df"
    "8ca1890dbfe6426841992d0fb054bb16"
)

RCON = (
    0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80,
    0x1B, 0x36, 0x6C, 0xD8, 0xAB, 0x4D,
)


def _xtime(value: int) -> int:
    value <<= 1
    if value & 0x100:
        value ^= 0x11B
    return value & 0xFF


def _mul(a: int, b: int) -> int:
    """Multiply in GF(2^8)."""
    result = 0
    for _ in range(8):
        if b & 1:
            result ^= a
        a = _xtime(a)
        b >>= 1
    return result


# Precomputed MixColumns tables keep the round loop to a handful of lookups.
MUL2 = bytes(_mul(i, 2) for i in range(256))
MUL3 = bytes(_mul(i, 3) for i in range(256))


class AES256:
    """AES-256 block cipher, encryption direction only."""

    __slots__ = ("round_keys",)

    def __init__(self, key: bytes):
        if len(key) != 32:
            raise ValueError("AES-256 needs a 32-byte key")
        self.round_keys = self._expand(key)

    @staticmethod
    def _expand(key: bytes) -> list[bytes]:
        words = [list(key[i : i + 4]) for i in range(0, 32, 4)]
        for i in range(8, 60):
            temp = list(words[i - 1])
            if i % 8 == 0:
                temp = temp[1:] + temp[:1]
                temp = [SBOX[b] for b in temp]
                temp[0] ^= RCON[i // 8 - 1]
            elif i % 8 == 4:
                temp = [SBOX[b] for b in temp]
            words.append([words[i - 8][j] ^ temp[j] for j in range(4)])

        keys = []
        for rnd in range(15):
            keys.append(bytes(b for w in words[rnd * 4 : rnd * 4 + 4] for b in w))
        return keys

    def encrypt_block(self, block: bytes) -> bytes:
        keys = self.round_keys
        state = [block[i] ^ keys[0][i] for i in range(16)]

        for rnd in range(1, 14):
            key = keys[rnd]
            # SubBytes + ShiftRows, fused.
            s0 = SBOX[state[0]]
            s1 = SBOX[state[5]]
            s2 = SBOX[state[10]]
            s3 = SBOX[state[15]]
            s4 = SBOX[state[4]]
            s5 = SBOX[state[9]]
            s6 = SBOX[state[14]]
            s7 = SBOX[state[3]]
            s8 = SBOX[state[8]]
            s9 = SBOX[state[13]]
            s10 = SBOX[state[2]]
            s11 = SBOX[state[7]]
            s12 = SBOX[state[12]]
            s13 = SBOX[state[1]]
            s14 = SBOX[state[6]]
            s15 = SBOX[state[11]]

            # MixColumns + AddRoundKey.
            state = [
                MUL2[s0] ^ MUL3[s1] ^ s2 ^ s3 ^ key[0],
                s0 ^ MUL2[s1] ^ MUL3[s2] ^ s3 ^ key[1],
                s0 ^ s1 ^ MUL2[s2] ^ MUL3[s3] ^ key[2],
                MUL3[s0] ^ s1 ^ s2 ^ MUL2[s3] ^ key[3],
                MUL2[s4] ^ MUL3[s5] ^ s6 ^ s7 ^ key[4],
                s4 ^ MUL2[s5] ^ MUL3[s6] ^ s7 ^ key[5],
                s4 ^ s5 ^ MUL2[s6] ^ MUL3[s7] ^ key[6],
                MUL3[s4] ^ s5 ^ s6 ^ MUL2[s7] ^ key[7],
                MUL2[s8] ^ MUL3[s9] ^ s10 ^ s11 ^ key[8],
                s8 ^ MUL2[s9] ^ MUL3[s10] ^ s11 ^ key[9],
                s8 ^ s9 ^ MUL2[s10] ^ MUL3[s11] ^ key[10],
                MUL3[s8] ^ s9 ^ s10 ^ MUL2[s11] ^ key[11],
                MUL2[s12] ^ MUL3[s13] ^ s14 ^ s15 ^ key[12],
                s12 ^ MUL2[s13] ^ MUL3[s14] ^ s15 ^ key[13],
                s12 ^ s13 ^ MUL2[s14] ^ MUL3[s15] ^ key[14],
                MUL3[s12] ^ s13 ^ s14 ^ MUL2[s15] ^ key[15],
            ]

        key = keys[14]
        return bytes(
            [
                SBOX[state[0]] ^ key[0],
                SBOX[state[5]] ^ key[1],
                SBOX[state[10]] ^ key[2],
                SBOX[state[15]] ^ key[3],
                SBOX[state[4]] ^ key[4],
                SBOX[state[9]] ^ key[5],
                SBOX[state[14]] ^ key[6],
                SBOX[state[3]] ^ key[7],
                SBOX[state[8]] ^ key[8],
                SBOX[state[13]] ^ key[9],
                SBOX[state[2]] ^ key[10],
                SBOX[state[7]] ^ key[11],
                SBOX[state[12]] ^ key[12],
                SBOX[state[1]] ^ key[13],
                SBOX[state[6]] ^ key[14],
                SBOX[state[11]] ^ key[15],
            ]
        )


# ---------------------------------------------------------------------------
# GCM
# ---------------------------------------------------------------------------

# The reduction polynomial used by GCM, with the bit order GCM specifies.
_R = 0xE1000000000000000000000000000000


def _shift_right_one(value: int) -> int:
    """Multiply by x^-1 in GF(2^128), GCM convention."""
    if value & 1:
        return (value >> 1) ^ _R
    return value >> 1


def _ghash_tables(h: int) -> list[list[int]]:
    """Byte-indexed multiplication tables: table[j][b] = (b << (120 - 8j)) * H.

    Building this once turns each 128-bit multiply into sixteen array lookups
    and xors instead of a 128-step bit loop, which is the difference between
    minutes and seconds on a multi-megabyte source corpus.
    """
    shifted = []
    value = h
    for _ in range(128):
        shifted.append(value)
        value = _shift_right_one(value)

    tables = []
    for j in range(16):
        base = j * 8
        entries = [0] * 256
        for b in range(1, 256):
            accumulator = 0
            for k in range(8):
                if (b >> (7 - k)) & 1:
                    accumulator ^= shifted[base + k]
            entries[b] = accumulator
        tables.append(entries)
    return tables


def _ghash(h: bytes, aad: bytes, ciphertext: bytes) -> bytes:
    """GHASH(H, AAD, C), including the GCM length block."""
    tables = _ghash_tables(int.from_bytes(h, "big"))

    def absorb(data: bytes, state: int) -> int:
        for offset in range(0, len(data), 16):
            block = data[offset : offset + 16]
            if len(block) < 16:
                block = block + b"\x00" * (16 - len(block))
            value = state ^ int.from_bytes(block, "big")
            state = 0
            for index in range(16):
                byte = (value >> (120 - index * 8)) & 0xFF
                if byte:
                    state ^= tables[index][byte]
        return state

    state = absorb(aad, 0)
    state = absorb(ciphertext, state)
    lengths = (len(aad) * 8).to_bytes(8, "big") + (len(ciphertext) * 8).to_bytes(8, "big")
    return absorb(lengths, state).to_bytes(16, "big")


def _inc32(counter: bytes) -> bytes:
    value = (int.from_bytes(counter[12:], "big") + 1) & 0xFFFFFFFF
    return counter[:12] + value.to_bytes(4, "big")


def _xor(a: bytes, b: bytes) -> bytes:
    return bytes(x ^ y for x, y in zip(a, b))


def _ctr(cipher: AES256, iv: bytes, data: bytes) -> bytes:
    """AES-CTR starting at inc32(J0), which is where GCM's payload begins."""
    counter = _inc32(iv + b"\x00\x00\x00\x01")
    out = bytearray()
    for offset in range(0, len(data), 16):
        block = data[offset : offset + 16]
        keystream = cipher.encrypt_block(counter)
        counter = _inc32(counter)
        out += _xor(block, keystream[: len(block)])
    return bytes(out)


def gcm_encrypt(key: bytes, iv: bytes, plaintext: bytes, aad: bytes = b"") -> tuple[bytes, bytes]:
    """Return (ciphertext, tag) for AES-256-GCM."""
    if len(iv) != 12:
        raise ValueError("a 96-bit IV is required, which is what WebCrypto uses")
    cipher = AES256(key)
    h = cipher.encrypt_block(b"\x00" * 16)
    ciphertext = _ctr(cipher, iv, plaintext)
    tag_mask = cipher.encrypt_block(iv + b"\x00\x00\x00\x01")
    return ciphertext, _xor(_ghash(h, aad, ciphertext), tag_mask)


def gcm_decrypt(key: bytes, iv: bytes, ciphertext: bytes, tag: bytes, aad: bytes = b"") -> bytes:
    """Verify the tag, then return the plaintext. Raises ValueError on mismatch."""
    cipher = AES256(key)
    h = cipher.encrypt_block(b"\x00" * 16)
    tag_mask = cipher.encrypt_block(iv + b"\x00\x00\x00\x01")
    if _xor(_ghash(h, aad, ciphertext), tag_mask) != tag:
        raise ValueError("authentication tag mismatch")
    return _ctr(cipher, iv, ciphertext)
