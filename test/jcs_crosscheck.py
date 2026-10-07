#!/usr/bin/env python3
"""Independent JCS oracle used only for cross-checking src/jcs.js.

Generates random JSON documents (unicode keys, number boundaries, nested
arrays/objects), canonicalizes with an independent Python implementation,
and compares canonical UTF-8 bytes + SHA-256 against the Node implementation
via `node -e` IPC. Run: python3 test/jcs_crosscheck.py
"""
import json
import hashlib
import random
import subprocess
import sys

NUMBERS = [
    0, -0.0, 1, -1, 4, -4, 1.5, -1.5, 0.1, 0.000001, 0.0000001,
    1e-7, -1e-7, 1.5e-7, 2.5e-323, 5e-324,
    1e20, 1e21, -1e21, 1.5e21, 999999999999999800000.0,
    1e100, 1.2345678901234568e30, 1.2345678901234568e-30,
    123456.789, 1234567890123456.0, 2147483647.0,
    100.0, 10.0, 0.0,
]

KEYS = ["a", "b", "A", "α", "aa", "a/b", "a~b", "é", "é",
        "😀", "k1", "k", "10", "2", ""]


def jcs_number(x: float) -> str:
    if x == 0:
        return "0"  # -0.0 serializes as "0"
    s = repr(x)
    neg = s.startswith("-")
    s = s.lstrip("-")
    if "e" in s or "E" in s:
        mant, exp = s.upper().split("E")
        e = int(exp)
    else:
        mant, e = s, 0
    ip, fp = mant.split(".") if "." in mant else (mant, "")
    digits = ip + fp
    first = len(digits) - len(digits.lstrip("0"))
    last = len(digits.rstrip("0"))
    sig = digits[first:last]  # shortest round-trip significant digits
    e += len(ip) - 1 - first  # exponent of most significant digit
    if -6 <= e < 21:
        # Plain decimal notation.
        if e >= 0:
            ipart = e + 1
            if len(sig) <= ipart:
                body = sig + "0" * (ipart - len(sig))
            else:
                body = sig[:ipart] + "." + sig[ipart:]
        else:
            body = "0." + "0" * (-e - 1) + sig
    else:
        # Exponential notation: d[.ddd]E±e, dot mandatory.
        body = sig[0] + ("." + sig[1:] if len(sig) > 1 else ".0")
        body += ("E+" if e >= 0 else "E-") + str(abs(e))
    return ("-" if neg else "") + body


def jcs_str(s: str) -> str:
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif o < 0x20:
            out.append("\\u%04x" % o)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def jcs(v, buf):
    if v is None:
        buf.append("null")
    elif isinstance(v, bool):
        buf.append("true" if v else "false")
    elif isinstance(v, int) and not isinstance(v, bool):
        buf.append(jcs_number(float(v)))
    elif isinstance(v, float):
        buf.append(jcs_number(v))
    elif isinstance(v, str):
        buf.append(jcs_str(v))
    elif isinstance(v, list):
        buf.append("[")
        for i, item in enumerate(v):
            if i:
                buf.append(",")
            jcs(item, buf)
        buf.append("]")
    elif isinstance(v, dict):
        buf.append("{")
        keys = sorted(v.keys(), key=lambda k: k.encode("utf-8"))
        for i, k in enumerate(keys):
            if i:
                buf.append(",")
            buf.append(jcs_str(k))
            buf.append(":")
            jcs(v[k], buf)
        buf.append("}")
    else:
        raise TypeError(type(v))


def canonical(v):
    buf = []
    jcs(v, buf)
    return "".join(buf).encode("utf-8")


def rand_doc(rng, depth=0):
    if depth > 3:
        kind = rng.choice(["n", "s", "b"])
    else:
        kind = rng.choice(["o", "a", "n", "s", "b", "n"])
    if kind == "o":
        n = rng.randint(0, 6)
        keys = rng.sample(KEYS, min(n, len(KEYS)))
        return {k: rand_doc(rng, depth + 1) for k in keys}
    if kind == "a":
        return [rand_doc(rng, depth + 1) for _ in range(rng.randint(0, 5))]
    if kind == "n":
        return rng.choice(NUMBERS)
    if kind == "b":
        return rng.choice([True, False, None])
    return rng.choice(KEYS) + rng.choice(["", "\t", "\n\b", "x\\y"])


def main():
    rng = random.Random(20261007)
    docs = [
        {}, [], {"a": 1}, {"a": [True, False, None]},
        {"1": [False, True, None, {}], "0": True},
        {"é": 1, "é": 2, "a": 3},
        {"big": 1e21, "small": 1e-7, "z": 0.000001},
        {"esc": "a\tb\nc\"d\\e\b\f\r"},
    ]
    docs += [rand_doc(rng) for _ in range(300)]

    payload = json.dumps(docs, ensure_ascii=False)
    proc = subprocess.run(
        ["node", "-e", """
const fs=require('fs');
const {canonicalBytes}=require('./src/jcs');
const docs=JSON.parse(fs.readFileSync(0,'utf8'));
for(const d of docs){process.stdout.write(canonicalBytes(d));process.stdout.write('\\n');}
"""],
        input=payload.encode("utf-8"), capture_output=True, cwd=sys.argv[1] if len(sys.argv) > 1 else ".")
    if proc.returncode != 0:
        print(proc.stderr.decode())
        sys.exit(2)
    node_out = proc.stdout.decode("utf-8").split("\n")
    # node prints one line per doc; canonical JSON never contains raw newlines
    # (they are escaped), so the split is unambiguous.
    mismatches = 0
    for i, d in enumerate(docs):
        py_bytes = canonical(d)
        node_bytes = node_out[i].encode("utf-8")
        if py_bytes != node_bytes:
            mismatches += 1
            print("MISMATCH doc", i)
            print("  doc :", json.dumps(d, ensure_ascii=False)[:200])
            print("  py  :", py_bytes[:200])
            print("  node:", node_bytes[:200])
        elif hashlib.sha256(py_bytes).hexdigest() != hashlib.sha256(node_bytes).hexdigest():
            mismatches += 1
            print("HASH MISMATCH doc", i)
    print(f"{len(docs) - mismatches}/{len(docs)} documents canonicalize identically")
    sys.exit(1 if mismatches else 0)


if __name__ == "__main__":
    main()
