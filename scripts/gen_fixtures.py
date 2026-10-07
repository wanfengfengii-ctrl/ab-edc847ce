#!/usr/bin/env python3
"""Generate independent test vectors for the recipe replay service.

Canonical digests are produced by the RFC 8785 reference implementation
(`jcs`), and expected patched documents by the independent `jsonpatch`
implementation of RFC 6902.  The Node service under test never sees this
script; only test/fixtures/vectors.json is consumed at test time.
"""
import copy
import hashlib
import json
import os
import random

import jsonpatch
from jcs import canonicalize

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "test", "fixtures", "vectors.json")

ZERO = "0" * 64


def digest(doc):
    return hashlib.sha256(canonicalize(doc)).hexdigest()


def rev(rid, pre, ops, post):
    return {
        "revisionId": rid,
        "preHash": pre,
        "postHash": digest(post),
        "operations": ops,
    }


def apply(doc, ops):
    # Deep-copy BOTH the document and the operation objects: jsonpatch inserts
    # an add/copy "value" by reference into the result, so a later remove/move
    # inside that inserted subtree would otherwise mutate the recorded op.
    return jsonpatch.JsonPatch(copy.deepcopy(ops)).apply(
        copy.deepcopy(doc), in_place=False)


def chain(baseline, planned):
    """planned: list of (revisionId, ops). Returns revision request objects."""
    revs = []
    cur = copy.deepcopy(baseline)
    for rid, ops in planned:
        pre = digest(cur)
        nxt = apply(cur, ops)
        revs.append(rev(rid, pre, ops, nxt))
        cur = nxt
    return revs, cur


def err(name, baseline, revisions, code, revision_index, operation_index,
        stage=None):
    entry = {
        "name": name,
        "request": {"baseline": baseline, "revisions": revisions},
        "status": 422,
        "expect": {
            "code": code,
            "revisionIndex": revision_index,
            "operationIndex": operation_index,
        },
    }
    if stage is not None:
        entry["expect"]["stage"] = stage
    return entry


def main():
    fixtures = []

    # ---- S1: escaped pointers (~0/~1 ordering, "/" and "~1" keys) plus
    # RFC 6902 A.7 array move, "-" append and numeric representation ----
    baseline1 = {
        "/": 9,
        "~1": 10,
        "foo": ["all", "grass", "cows", "eat"],
        "nums": [333333333.33333329, 1e30, 0.002, 1e-27, 1424953923781206.2],
        "obj": {"€": 1, "z": [1, 2, 3], "a/b": "slash", "k~v": "tilde"},
    }
    ops1 = [
        {"op": "test", "path": "/~01", "value": 10},          # key "~1"
        {"op": "test", "path": "/~1", "value": 9},             # key "/"
        {"op": "test", "path": "/obj/a~1b", "value": "slash"},
        {"op": "test", "path": "/obj/k~0v", "value": "tilde"},
        {"op": "move", "from": "/foo/1", "path": "/foo/3"},   # A.7
        {"op": "add", "path": "/foo/-", "value": "end"},
    ]
    ops2 = [
        {"op": "test", "path": "/foo/3", "value": "grass"},
        {"op": "test", "path": "/foo/4", "value": "end"},
        {"op": "remove", "path": "/foo/0"},
        {"op": "copy", "from": "/~01", "path": "/foo/0"},
        {"op": "add", "path": "/new",
         "value": [1.0, 1, "1", None, True, False]},
        {"op": "replace", "path": "/nums/0",
         "value": 333333333.3333333},
    ]
    revs, final = chain(baseline1, [("esc-and-move", ops1), ("shift", ops2)])
    fixtures.append({
        "name": "escaped-pointers-array-move-and-numbers",
        "request": {"baseline": baseline1, "revisions": revs},
        "status": 200,
        "expect": {
            "revisionIds": ["esc-and-move", "shift"],
            "postHashes": [r["postHash"] for r in revs],
            "finalHash": digest(final),
            "finalDocument": final,
        },
    })

    # ---- S2: pure numeric representation stability (RFC 8785 App. B) ----
    baseline2 = {
        "v": 333333333.33333329,
        "big": 295147905179352830000,
        "tiny": 1e-27,
        "negzero": -0.0,
    }
    ops = [
        {"op": "test", "path": "/v", "value": 333333333.3333333},
        {"op": "test", "path": "/big", "value": 295147905179352830000},
        {"op": "test", "path": "/negzero", "value": 0},
    ]
    revs, final = chain(baseline2, [("num-test", ops)])
    fixtures.append({
        "name": "numeric-representation-stability",
        "request": {"baseline": baseline2, "revisions": revs},
        "status": 200,
        "expect": {
            "revisionIds": ["num-test"],
            "postHashes": [r["postHash"] for r in revs],
            "finalHash": digest(final),
            "finalDocument": final,
        },
    })

    # ---- S3: root replacement then nested rework ----
    baseline3 = {"old": True}
    ops3a = [{"op": "replace", "path": "", "value": {"a": [0, 0], "s": "x"}}]
    ops3b = [
        {"op": "add", "path": "/a/1", "value": 1},
        {"op": "move", "from": "/s", "path": "/t"},
    ]
    revs, final = chain(baseline3, [("root-replace", ops3a), ("rework", ops3b)])
    fixtures.append({
        "name": "root-replace-and-array-shift",
        "request": {"baseline": baseline3, "revisions": revs},
        "status": 200,
        "expect": {
            "revisionIds": ["root-replace", "rework"],
            "postHashes": [r["postHash"] for r in revs],
            "finalHash": digest(final),
            "finalDocument": final,
        },
    })

    # ---- Error: pre-hash mismatch on first revision ----
    b = {"a": 1}
    good_pre = digest(b)
    bad_pre = "0" * 63 + "1" if good_pre != "0" * 63 + "1" else "0" * 63 + "2"
    fixtures.append(err(
        "pre-hash-mismatch", b,
        [{"revisionId": "r", "preHash": bad_pre, "postHash": ZERO,
          "operations": [{"op": "test", "path": "/a", "value": 1}]}],
        "PRE_HASH_MISMATCH", 0, None, stage="pre"))

    # ---- Error: post-hash mismatch ----
    b = {"a": 1}
    ops = [{"op": "add", "path": "/b", "value": 2}]
    post = apply(b, ops)
    fixtures.append(err(
        "post-hash-mismatch", b,
        [{"revisionId": "r", "preHash": digest(b),
          "postHash": digest(post)[:-1] + ("0" if digest(post)[-1] != "0" else "1"),
          "operations": ops}],
        "POST_HASH_MISMATCH", 0, None, stage="post"))

    # ---- Error: test failure points at revision/op ----
    b = {"a": 1}
    revs, _ = chain(b, [("ok", [{"op": "add", "path": "/b", "value": 2}])])
    revs.append({
        "revisionId": "bad-test",
        "preHash": digest(apply(b, revs[0]["operations"])),
        "postHash": ZERO,
        "operations": [
            {"op": "add", "path": "/c", "value": 3},
            {"op": "test", "path": "/a", "value": "different"},
        ],
    })
    fixtures.append(err("test-failure-position", b, revs,
                        "TEST_ASSERTION_FAILED", 1, 1))

    # ---- Error: RFC 6902 A.15 type mismatch string vs number ----
    b = {"/": 9}
    fixtures.append(err(
        "test-type-mismatch", b,
        [{"revisionId": "r", "preHash": digest(b), "postHash": ZERO,
          "operations": [{"op": "test", "path": "/~01", "value": "10"}]}],
        # pointer "/~01" targets key "~1" which is absent here
        "POINTER_TARGET_NOT_FOUND", 0, 0))
    b2 = {"x": 10}
    fixtures.append(err(
        "test-string-vs-number", b2,
        [{"revisionId": "r", "preHash": digest(b2), "postHash": ZERO,
          "operations": [{"op": "test", "path": "/x", "value": "10"}]}],
        "TEST_ASSERTION_FAILED", 0, 0))

    # ---- Error: escaped pointer syntax ----
    b = {"a": 1}
    fixtures.append(err(
        "bad-pointer-escape", b,
        [{"revisionId": "r", "preHash": digest(b), "postHash": ZERO,
          "operations": [{"op": "remove", "path": "/a~2b"}]}],
        "INVALID_POINTER_SYNTAX", 0, 0))

    # ---- Error: pointer without leading slash ----
    fixtures.append(err(
        "pointer-missing-leading-slash", b,
        [{"revisionId": "r", "preHash": digest(b), "postHash": ZERO,
          "operations": [{"op": "remove", "path": "a"}]}],
        "INVALID_POINTER_SYNTAX", 0, 0))

    # ---- Error: dangling escape ----
    fixtures.append(err(
        "pointer-dangling-escape", b,
        [{"revisionId": "r", "preHash": digest(b), "postHash": ZERO,
          "operations": [{"op": "remove", "path": "/a~"}]}],
        "INVALID_POINTER_SYNTAX", 0, 0))

    # ---- Error: leading-zero array index ----
    b = {"a": [1, 2, 3]}
    fixtures.append(err(
        "array-index-leading-zero", b,
        [{"revisionId": "r", "preHash": digest(b), "postHash": ZERO,
          "operations": [{"op": "remove", "path": "/a/01"}]}],
        "INVALID_POINTER_SYNTAX", 0, 0))

    # ---- Error: add beyond array length ----
    fixtures.append(err(
        "array-index-out-of-range", b,
        [{"revisionId": "r", "preHash": digest(b), "postHash": ZERO,
          "operations": [{"op": "add", "path": "/a/5", "value": 9}]}],
        "ARRAY_INDEX_OUT_OF_RANGE", 0, 0))

    # ---- Error: "-" used to remove ----
    fixtures.append(err(
        "array-dash-not-removable", b,
        [{"revisionId": "r", "preHash": digest(b), "postHash": ZERO,
          "operations": [{"op": "remove", "path": "/a/-"}]}],
        "POINTER_TARGET_NOT_FOUND", 0, 0))

    # ---- Error: traversal through a scalar ----
    fixtures.append(err(
        "traversal-through-scalar", b,
        [{"revisionId": "r", "preHash": digest(b), "postHash": ZERO,
          "operations": [{"op": "remove", "path": "/a/0/x"}]}],
        "POINTER_TRAVERSAL_FAILURE", 0, 0))

    # ---- Error: move from proper prefix of path ----
    fixtures.append(err(
        "move-into-descendant", b,
        [{"revisionId": "r", "preHash": digest(b), "postHash": ZERO,
          "operations": [{"op": "move", "from": "/a", "path": "/a/0/x"}]}],
        "MOVE_INTO_DESCENDANT", 0, 0))

    # ---- Error: unknown operation ----
    fixtures.append(err(
        "unknown-operation", {"a": 1},
        [{"revisionId": "r", "preHash": digest({"a": 1}), "postHash": ZERO,
          "operations": [{"op": "frobnicate", "path": "/a", "value": 1}]}],
        "UNKNOWN_OPERATION", 0, 0))

    # ---- Error: missing value member ----
    fixtures.append(err(
        "missing-value", {"a": 1},
        [{"revisionId": "r", "preHash": digest({"a": 1}), "postHash": ZERO,
          "operations": [{"op": "replace", "path": "/a"}]}],
        "MISSING_VALUE", 0, 0))

    # ---- Error: missing from member ----
    fixtures.append(err(
        "missing-from", {"a": 1},
        [{"revisionId": "r", "preHash": digest({"a": 1}), "postHash": ZERO,
          "operations": [{"op": "move", "path": "/b"}]}],
        "MISSING_FROM", 0, 0))

    # ---- Atomicity: failing revision must roll back and halt chain ----
    base_a = {"a": [1, 2, 3], "marker": 0}
    revs, after1 = chain(
        base_a, [("ok-add", [{"op": "add", "path": "/marker", "value": 1}])])
    revs.append({
        "revisionId": "fails-midway",
        "preHash": digest(after1),
        "postHash": ZERO,
        "operations": [
            {"op": "add", "path": "/a/-", "value": 9},
            {"op": "test", "path": "/a/0", "value": "nope"},
        ],
    })
    revs.append({
        "revisionId": "must-not-run",
        "preHash": digest({"would": "be-wrong-if-chain-continued"}),
        "postHash": ZERO,
        "operations": [{"op": "add", "path": "/never", "value": True}],
    })
    fixtures.append(err("failed-revision-is-atomic", base_a, revs,
                        "TEST_ASSERTION_FAILED", 1, 1))

    # ---- UTF-16 key sort order (RFC 8785 3.2.3) exercised through chain ----
    # Exact code points from RFC 8785 Section 3.2.3 (UTF-16 code-unit order):
    # U+000D, U+0031, U+0080, U+00F6, U+20AC, U+1F600, U+FB33
    baseline_u = {
        "\u20ac": "Euro Sign",
        "\r": "Carriage Return",
        "\ufb33": "Hebrew Letter Dalet With Dagesh",
        "1": "One",
        "\U0001f600": "Emoji: Grinning Face",
        "\u0080": "Control",
        "\u00f6": "Latin Small Letter O With Diaeresis",
    }
    revs, final = chain(
        baseline_u, [("unicode-test",
                      [{"op": "test", "path": "/1", "value": "One"}])])
    fixtures.append({
        "name": "utf16-property-sort",
        "request": {"baseline": baseline_u, "revisions": revs},
        "status": 200,
        "expect": {
            "revisionIds": ["unicode-test"],
            "postHashes": [r["postHash"] for r in revs],
            "finalHash": digest(final),
            "finalDocument": final,
        },
    })

    # ---- Random differential fuzz chains ----
    # Independent random construction; only operations accepted by the
    # python jsonpatch engine are kept, so every chain is valid. The Node
    # implementation must reproduce documents and every RFC 8785 digest.
    random.seed(20261007)

    def rand_value(depth=0):
        kind = random.randrange(8 if depth < 2 else 4)
        if kind == 0:
            return random.choice([0, 1, -1, 7, 42, -9007199254740993,
                                  9007199254740992])
        if kind == 1:
            return random.choice([0.0, -0.0, 0.1, 1e-27, 3.141592653589793,
                                  333333333.33333329, 1e30, 2.2250738585072014e-308,
                                  random.random() * 1e6, -(10.0 ** random.randrange(1, 20))])
        if kind == 2:
            return random.choice(["", "x", "a/b", "k~v", "€", "😀", "line\nbreak",
                                  "quote\"", "back\\slash", "tab\tend"])
        if kind == 3:
            return random.choice([True, False, None])
        if kind in (4, 5) and depth < 3:
            return [rand_value(depth + 1) for _ in range(random.randrange(0, 4))]
        if depth < 3:
            keypool = ["", "a/b", "k~v", "€", "n", "x", "m", "😀"]
            out = {}
            for _ in range(random.randrange(0, 4)):
                k = random.choice(keypool)
                if k not in out:
                    out[k] = rand_value(depth + 1)
            return out
        return None

    def esc(key):
        return key.replace("~", "~0").replace("/", "~1")

    def enumerate_pointers(doc, prefix=""):
        """Yield (pointer, is_container) for every value reachable."""
        yield prefix, isinstance(doc, (dict, list))
        if isinstance(doc, dict):
            for k, v in doc.items():
                yield from enumerate_pointers(v, prefix + "/" + esc(k))
        elif isinstance(doc, list):
            for i, v in enumerate(doc):
                yield from enumerate_pointers(v, f"{prefix}/{i}")

    def pick_pointer(doc, container=False, non_root=False):
        opts = [(p, c) for p, c in enumerate_pointers(doc)
                if (not container or c) and (not non_root or p != "")]
        return random.choice(opts)[0] if opts else None

    def add_candidate(doc):
        pptr = pick_pointer(doc, container=True)
        if pptr is None:
            return None
        target = resolve_py(doc, pptr)
        if isinstance(target, list):
            if random.random() < 0.6 or not target:
                return pptr + "/-"
            return f"{pptr}/{random.randrange(len(target) + 1)}"
        if isinstance(target, dict):
            base = random.choice(["new", "a/b", "k~v", "€", "", "x"])
            key = f"{base}{random.randrange(100000)}"
            if key not in target:
                return pptr + "/" + esc(key)
        return None

    def resolve_py(doc, ptr):
        node = doc
        if ptr == "":
            return node
        for tok in ptr[1:].split("/"):
            tok = tok.replace("~1", "/").replace("~0", "~")
            node = node[tok] if isinstance(node, dict) else node[int(tok)]
        return node

    def try_op(cur, op):
        # Deep-copy the op so an inserted "value" shared with the result
        # cannot be mutated later by a subsequent remove/move in the chain.
        return jsonpatch.JsonPatch(copy.deepcopy([op])).apply(
            copy.deepcopy(cur), in_place=False)

    for chain_id in range(40):
        start = rand_value(0)
        if not isinstance(start, dict):
            start = {"root": start}
        cur = copy.deepcopy(start)
        n_revs = random.randrange(1, 8)
        planned = []
        for r in range(n_revs):
            ops = []
            guard = 0
            while len(ops) < random.randrange(1, 9) and guard < 60:
                guard += 1
                kind = random.random()
                op = None
                try:
                    if kind < 0.22:
                        tgt = add_candidate(cur)
                        if tgt is not None:
                            op = {"op": "add", "path": tgt, "value": rand_value()}
                    elif kind < 0.40:
                        src = pick_pointer(cur, non_root=True)
                        if src is not None:
                            op = {"op": "remove", "path": src}
                    elif kind < 0.58:
                        src = pick_pointer(cur)
                        if src is not None:
                            op = {"op": "replace", "path": src,
                                  "value": rand_value()}
                    elif kind < 0.72:
                        src = pick_pointer(cur, non_root=True)
                        tgt = add_candidate(cur)
                        if src is not None and tgt is not None:
                            op = {"op": "move", "from": src, "path": tgt}
                    elif kind < 0.86:
                        src = pick_pointer(cur)
                        tgt = add_candidate(cur)
                        if src is not None and tgt is not None:
                            op = {"op": "copy", "from": src, "path": tgt}
                    else:
                        src = pick_pointer(cur)
                        if src is not None:
                            op = {"op": "test", "path": src,
                                  "value": copy.deepcopy(resolve_py(cur, src))}
                    if op is not None:
                        nxt = try_op(cur, op)
                        cur = nxt
                        ops.append(op)
                except Exception:
                    pass
            if not ops:
                ops = [{"op": "test", "path": "", "value": copy.deepcopy(cur)}]
            planned.append((f"fuzz-{chain_id}-r{r}", ops))
        # Replay the planned ops from the recorded start to compute hashes.
        revs, final = chain(start, planned)
        fixtures.append({
            "name": f"fuzz-chain-{chain_id}",
            "request": {"baseline": start, "revisions": revs},
            "status": 200,
            "expect": {
                "revisionIds": [p[0] for p in planned],
                "postHashes": [r["postHash"] for r in revs],
                "finalHash": digest(final),
                "finalDocument": final,
            },
        })

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"fixtures": fixtures}, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"wrote {len(fixtures)} fixtures -> {os.path.relpath(OUT)}")


if __name__ == "__main__":
    main()
