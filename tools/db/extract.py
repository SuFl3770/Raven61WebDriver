#!/usr/bin/env python3
"""
Reads the stock driver's SQLite database and prints it as JSON the web driver
understands (millimetres, not raw counts).

    python tools/db/extract.py "<path>/Raven61 HE_datav6.db" > profile.json
    python tools/db/extract.py a.db --diff b.db      # what changed between two

Node 20 has no built-in SQLite, so this is Python — its sqlite3 module is in the
standard library, no install needed.

The database is the stock driver's own file. It is the fastest ground truth for
value encodings: change one setting in the stock driver, save, and diff.
"""

import json
import sqlite3
import sys

COUNTS_PER_MM = 50  # confirmed: 1.0mm -> 50, 2.0mm -> 100, default 1.5mm -> 75

KEY_MODE = {0: "normal", 1: "rapidTrigger"}
MACRO_TYPE = {2: "hidKey", 12: "special"}


def mm(counts):
    return round(counts / COUNTS_PER_MM, 3)


def connect(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def read(path):
    con = connect(path)
    out = {"source": path, "countsPerMm": COUNTS_PER_MM, "profiles": {}, "config": {}}

    for r in con.execute("SELECT profile, key, value FROM t_config_data"):
        out["config"].setdefault(str(r["profile"]), {})[r["key"]] = r["value"]

    for r in con.execute("SELECT * FROM t_profile_data"):
        out["profiles"][str(r["profile"])] = {
            "name": r["name"],
            "active": bool(r["status"]),
            "keys": {},
            "layers": {},
        }

    for r in con.execute("SELECT * FROM t_key_perf_data"):
        p = out["profiles"].setdefault(str(r["profile"]), {"keys": {}, "layers": {}})
        p["keys"][str(r["key_code"])] = {
            "actuationMm": mm(r["key_actuation"]),
            "mode": KEY_MODE.get(r["key_mode"], r["key_mode"]),
            "rapidTrigger": {
                "pressMm": mm(r["rt_press"]),
                "releaseMm": mm(r["rt_release"]),
            },
            "deadZone": {
                "enabled": bool(r["deadzone_state"]),
                "topMm": mm(r["press_deadzone"]),
                "bottomMm": mm(r["release_deadzone"]),
            },
            "switchType": r["switch_type"],
        }

    for r in con.execute("SELECT * FROM t_key_macro_data"):
        p = out["profiles"].setdefault(str(r["profile"]), {"keys": {}, "layers": {}})
        layer = p["layers"].setdefault(str(r["fn_layer"]), {})
        layer[str(r["key_code"])] = {
            "type": MACRO_TYPE.get(r["macro_type"], r["macro_type"]),
            "value": r["macro_value"],
            "desc": r["macro_desc"],
        }

    con.close()
    return out


def flatten(d, prefix=""):
    """Path -> value, so two databases can be compared leaf by leaf."""
    if isinstance(d, dict):
        for k, v in d.items():
            yield from flatten(v, f"{prefix}.{k}" if prefix else k)
    elif isinstance(d, list):
        for i, v in enumerate(d):
            yield from flatten(v, f"{prefix}[{i}]")
    else:
        yield prefix, d


def main():
    # Windows consoles default to a legacy codepage, which mangles the macro
    # description strings on the way out. Force UTF-8 for both streams.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    args = sys.argv[1:]
    if not args:
        print(__doc__.strip(), file=sys.stderr)
        return 1

    if "--diff" in args:
        i = args.index("--diff")
        a, b = read(args[0]), read(args[i + 1])
        fa, fb = dict(flatten(a)), dict(flatten(b))
        fa.pop("source", None)
        fb.pop("source", None)
        changed = sorted(k for k in fa.keys() | fb.keys() if fa.get(k) != fb.get(k))
        if not changed:
            print("# 두 DB의 설정이 동일합니다")
            return 0
        print(f"# {len(changed)}개 값이 다릅니다")
        for k in changed:
            print(f"{k}: {fa.get(k)!r} -> {fb.get(k)!r}")
        return 0

    json.dump(read(args[0]), sys.stdout, indent=2, ensure_ascii=False)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
