"""Fail on Slither high or medium findings that are not in the triage file.

Usage: python gate.py slither.json slither-triage.toml
"""

import json
import sys
import tomllib

GATED = {"High", "Medium"}


def key(result):
    elements = result["elements"]
    first = elements[0] if elements else {}
    file = first.get("source_mapping", {}).get("filename_relative", "")
    function = first.get("name", "") if first.get("type") == "function" else ""
    nodes = []
    for e in elements:
        if e.get("type") == "node":
            nodes.append(e.get("name", ""))
            parent = e.get("type_specific_fields", {}).get("parent", {})
            if not function and parent.get("type") == "function":
                function = parent.get("name", "")
    return (result["check"], file, function, tuple(sorted(nodes)))


def main(report_path, triage_path):
    with open(report_path) as f:
        report = json.load(f)
    with open(triage_path, "rb") as f:
        triage = tomllib.load(f).get("finding", [])

    if not report.get("success", False):
        print(f"slither did not finish: {report.get('error')}")
        return 1

    known = {
        (t["check"], t["file"], t["function"], tuple(sorted(t.get("nodes", [])))): t for t in triage
    }
    for t in triage:
        if not t.get("reason", "").strip():
            print(f"triage entry without a reason: {t['check']} {t['file']} {t['function']}")
            return 1

    results = report.get("results", {}).get("detectors", [])
    seen = set()
    failed = 0
    for r in results:
        k = key(r)
        seen.add(k)
        where = f"{r['check']} ({r['impact']}) {k[1]} {k[2]}"
        if k in known:
            print(f"triaged   {where}: {known[k]['reason']}")
        elif r["impact"] in GATED:
            failed += 1
            print(f"UNTRIAGED {where}\n{r['description'].strip()}\n")
        else:
            print(f"note      {where}: not triaged, does not fail the job")

    for k, t in known.items():
        if k not in seen:
            print(f"stale     triage entry no longer reported: {t['check']} {t['file']} {t['function']}")

    print(f"{len(results)} findings, {failed} untriaged high or medium")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
