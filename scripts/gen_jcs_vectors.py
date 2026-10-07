#!/usr/bin/env python3
"""Generate RFC 8785 (JCS) canonicalization vectors.

Number cases use the exact IEEE 754 bit patterns from RFC 8785 Appendix B.
The canonical sample is additionally checked byte-for-byte against the
hexadecimal sequence published in RFC 8785 Section 3.2.4, so a faulty
reference library would fail this generator rather than corrupt the vectors.
"""
import hashlib
import json
import math
import os
import random
import struct

from jcs import canonicalize

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "test", "fixtures", "jcs-vectors.json")

# (hex bits, expected ECMAScript/JCS serialization, label) from Appendix B.
NUMBER_CASES = [
    ("7fefffffffffffff", "1.7976931348623157e+308", "max positive"),
    ("ffefffffffffffff", "-1.7976931348623157e+308", "max negative"),
    ("4340000000000000", "9007199254740992", "max pos int"),
    ("c340000000000000", "-9007199254740992", "max neg int"),
    ("4430000000000000", "295147905179352830000", "~2**68"),
    ("44b52d02c7e14af5", "9.999999999999997e+22", None),
    ("44b52d02c7e14af6", "1e+23", None),
    ("44b52d02c7e14af7", "1.0000000000000001e+23", None),
    ("444b1ae4d6e2ef4e", "999999999999999700000", None),
    ("444b1ae4d6e2ef4f", "999999999999999900000", None),
    ("444b1ae4d6e2ef50", "1e+21", None),
    ("3eb0c6f7a0b5ed8c", "9.999999999999997e-7", None),
    ("3eb0c6f7a0b5ed8d", "0.000001", None),
    ("41b3de4355555553", "333333333.3333332", None),
    ("41b3de4355555554", "333333333.33333325", None),
    ("41b3de4355555555", "333333333.3333333", None),
    ("41b3de4355555556", "333333333.3333334", None),
    ("41b3de4355555557", "333333333.33333343", None),
    ("becbf647612f3696", "-0.0000033333333333333333", None),
    ("43143ff3c1cb0959", "1424953923781206.2", "round to even"),
    ("0000000000000000", "0", "positive zero"),
    ("8000000000000000", "0", "negative zero"),
    ("3ff0000000000000", "1", "one"),
    ("bff0000000000000", "-1", "minus one"),
]

# Canonical text shown in RFC 8785 Section 3.2.3 (line wraps there are
# display only). Asserted character-for-character; hex is its UTF-8.
RFC_SAMPLE_TEXT = (
    '{"literals":[null,true,false],'
    '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
    '"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}'
)

RFC_SAMPLE_DOC = {
    "numbers": [333333333.33333329, 1e30, 4.5, 0.002, 1e-27],
    "string": "\u20ac$\u000f\nA'B\"\\\\\"/",
    "literals": [None, True, False],
}

# RFC 8785 Section 3.2.3 property-sort sample (explicit code points).
SORT_SAMPLE = {
    "\u20ac": "Euro Sign",
    "\r": "Carriage Return",
    "\ufb33": "Hebrew Letter Dalet With Dagesh",
    "1": "One",
    "\U0001F600": "Emoji: Grinning Face",
    "\u0080": "Control",
    "\u00f6": "Latin Small Letter O With Diaeresis",
}
EXPECTED_KEY_ORDER = ["\r", "1", "\u0080", "\u00f6", "\u20ac", "\U0001F600", "\ufb33"]


def random_number_vectors():
    """5000 random doubles plus powers-of-ten exponent boundaries."""
    random.seed(8785)
    values = []
    for _ in range(5000):
        values.append(struct.unpack("<Q", random.randbytes(8))[0])
    # Decode through Python for reference output.
    out = []
    seen = set()
    for bits in values:
        d = struct.unpack("<d", struct.pack("<Q", bits))[0]
        if math.isnan(d) or math.isinf(d):
            continue
        s = canonicalize(d).decode("utf-8")
        if s in seen:
            continue
        seen.add(s)
        out.append({"json": json.loads(canonicalize(d)), "expected": s})
    for e in range(-323, 309):
        for base in (10.0 ** e, -(10.0 ** e)):
            s = canonicalize(base).decode("utf-8")
            out.append({"json": json.loads(s), "expected": s})
    return out


def main():
    number_vectors = []
    for hexbits, expected, label in NUMBER_CASES:
        value = struct.unpack(">d", bytes.fromhex(hexbits))[0]
        got = canonicalize(value).decode("utf-8")
        assert got == expected, (
            f"{hexbits}: reference gave {got!r}, RFC says {expected!r}"
        )
        number_vectors.append({"hex": hexbits, "expected": expected, "label": label})

    sample_bytes = canonicalize(RFC_SAMPLE_DOC)
    expected_bytes = RFC_SAMPLE_TEXT.encode("utf-8")
    assert sample_bytes == expected_bytes, (
        "reference canonicalizer disagrees with RFC 8785 Section 3.2.4:\n"
        f"got:      {sample_bytes!r}\n"
        f"expected: {expected_bytes!r}"
    )

    sort_bytes = canonicalize(SORT_SAMPLE)
    # Independently verify the published key ordering before recording it.
    assert list(json.loads(sort_bytes).keys()) == EXPECTED_KEY_ORDER

    vectors = {
        "numberVectors": number_vectors,
        "randomNumbers": random_number_vectors(),
        "canonicalSample": {
            "document": RFC_SAMPLE_DOC,
            "canonicalUtf8Hex": sample_bytes.hex(),
            "sha256": hashlib.sha256(sample_bytes).hexdigest(),
        },
        "sortSample": {
            "document": SORT_SAMPLE,
            "canonicalUtf8Hex": sort_bytes.hex(),
            "sha256": hashlib.sha256(sort_bytes).hexdigest(),
            "expectedKeyOrder": EXPECTED_KEY_ORDER,
        },
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(vectors, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"wrote {len(number_vectors)} number vectors -> {os.path.relpath(OUT)}")


if __name__ == "__main__":
    main()
