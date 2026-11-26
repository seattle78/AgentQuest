#!/usr/bin/env python3
"""Run the approval-gate test suite and print a category summary.

Usage (from the approval-gate dir):
    python3 tests/run_tests.py [-v]

Exit code is non-zero if any test fails. Categories are read from test
method names: test_attack_* (must be blocked = deny or ask),
test_normal_* (must be allowed), test_infra_* (harness checks).
"""

import os
import sys
import tempfile
import unittest

GATE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(GATE_DIR, "tests"))


def main(argv):
    # Isolate gate state/audit from the real ~/.claude directory.
    tmp = tempfile.mkdtemp(prefix="gate-run-")
    os.environ["GATE_STATE_DIR"] = os.path.join(tmp, "state")
    os.environ["GATE_AUDIT_LOG"] = os.path.join(tmp, "audit.jsonl")

    verbosity = 2 if "-v" in argv else 1
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromName("test_gate")
    # Snapshot the test ids BEFORE running: iterating a suite after
    # run() is unreliable (CPython empties the suite's entries).
    all_ids = [t.id() for t in _iter_tests(suite)]
    runner = unittest.TextTestRunner(verbosity=verbosity)
    result = runner.run(suite)

    # Per-category counts, from test ids (module.Class.test_method).
    failed_ids = {t[0].id() for t in result.failures + result.errors}
    counts = {"attack": [0, 0], "normal": [0, 0], "infra": [0, 0]}
    for tid in all_ids:
        method = tid.rsplit(".", 1)[-1]
        for cat in counts:
            if method.startswith("test_%s_" % cat):
                counts[cat][1] += 1
                if tid not in failed_ids:
                    counts[cat][0] += 1
                break

    print()
    print("=" * 60)
    print("APPROVAL GATE -- summary")
    print("  attack cases blocked (deny or ask): %d / %d"
          % tuple(counts["attack"]))
    print("  normal cases passed (allow):        %d / %d"
          % tuple(counts["normal"]))
    print("  infra checks passed:                %d / %d"
          % tuple(counts["infra"]))
    print("  total: %d tests, %d failures, %d errors"
          % (result.testsRun, len(result.failures), len(result.errors)))
    print("=" * 60)
    return 0 if result.wasSuccessful() else 1


def _iter_tests(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from _iter_tests(item)
        else:
            yield item


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
