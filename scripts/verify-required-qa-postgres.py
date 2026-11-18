"""Fail closed unless the full-profile JUnit proves all eight named PG cases passed."""

import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

SUITES = {
    "packages/database/src/game-capacity-race-postgres.test.ts": (
        "scenario 1: concurrent joins against real PostgreSQL capacity",
        [
            "admits exactly one of six parallel joins when one seat is free (capacity 4)",
            "admits exactly one of four parallel joins when one seat is free (capacity 2)",
            "does not admit a duplicate seat when the same player races themselves",
        ],
    ),
    "packages/database/src/subscription-activation-confirmation-postgres.test.ts": (
        "scenario 5: subscription activation confirmation is idempotent",
        [
            "applies one PAID transition and one audit/outbox row on the first confirmation",
            "does not duplicate the transition or audit row when the confirmation is repeated",
            "stays idempotent when the retry arrives on another connection",
            "records pending then paid as two distinct transitions, never three",
            "refuses a confirmation whose provider transaction conflicts with the stored one",
        ],
    ),
}


def verify(root):
    counts = {}
    for filename, (group, titles) in SUITES.items():
        matches = [s for s in root.iter("testsuite") if s.get("name") == filename]
        if len(matches) != 1:
            raise ValueError("missing or duplicate required suite: " + filename)
        suite = matches[0]
        expected = {group + " > " + title for title in titles}
        cases = suite.findall("testcase")
        if (
            suite.get("tests") != str(len(expected))
            or any(suite.get(key) != "0" for key in ("failures", "errors", "skipped"))
            or len(cases) != len(expected)
        ):
            raise ValueError("required suite summary did not pass: " + filename)
        for case in cases:
            name = case.get("name")
            if (
                name not in expected
                or case.get("classname") != filename
                or any(case.find(tag) is not None for tag in ("failure", "error", "skipped"))
                or float(case.get("time", "-1")) < 0
            ):
                raise ValueError("required case did not pass: " + filename)
            expected.remove(name)
        if expected:
            raise ValueError("required case missing: " + filename)
        counts[filename] = {"passed": len(cases), "skipped": 0}
    return counts


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("expected the full-profile JUnit report path")
        report = Path(sys.argv[1])
        if not 0 < report.stat().st_size <= 20_000_000:
            raise ValueError("invalid report size")
        result = verify(ET.parse(report).getroot())
        print("REQUIRED_QA_POSTGRES_PASS " + json.dumps(result, sort_keys=True))
    except (OSError, ValueError, ET.ParseError) as error:
        print("REQUIRED_QA_POSTGRES_FAIL: " + str(error), file=sys.stderr)
        sys.exit(1)
