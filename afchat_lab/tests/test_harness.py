"""Unit tests for the harness scoring math and judge JSON parsing.

Run from afchat_lab/ with the venv active:
    .venv/bin/python -m unittest discover -s tests
or, if pytest is installed:
    .venv/bin/python -m pytest tests
"""

import unittest

from harness.judge import _parse_json
from harness.run_eval import representative_subset, summarize


def _row(verdict, finish, score, steps, elapsed):
    return {
        "verdict": verdict, "finish": finish, "score": score,
        "steps": steps, "elapsed_s": elapsed,
    }


class SummarizeTest(unittest.TestCase):
    def test_error_accounting_and_metrics(self):
        rows = [
            _row("correct", "answered", 1.0, 2, 10.0),
            _row("partial", "answered", 0.5, 3, 20.0),
            _row("incorrect", "answered", 0.0, 1, 5.0),
            _row("error", "error", 0.0, 1, 1.0),       # model error: stays in denominator
            _row("error", "answered", 0.0, 4, 8.0),    # judge error: excluded from denominator
        ]
        s = summarize(rows, "m", "id/m", duration_s=100)

        self.assertEqual(s["n"], 5)
        self.assertEqual(s["n_scored"], 4)             # judge error excluded
        self.assertEqual(s["correct"], 1)
        self.assertEqual(s["partial"], 1)
        self.assertEqual(s["incorrect"], 1)
        self.assertEqual(s["model_errors"], 1)
        self.assertEqual(s["judge_errors"], 1)
        self.assertEqual(s["score"], 1.5)
        self.assertEqual(s["pct"], 37.5)               # 100 * 1.5 / 4
        self.assertEqual(s["avg_steps"], 2.2)          # (2+3+1+1+4)/5
        self.assertEqual(s["duration_s"], 100)
        self.assertEqual(s["label"], "m")
        self.assertEqual(s["id"], "id/m")
        self.assertEqual(s["rows"], rows)

    def test_empty_rows_no_division_error(self):
        s = summarize([], "m", "id/m", duration_s=0)
        self.assertEqual(s["n"], 0)
        self.assertEqual(s["n_scored"], 0)
        self.assertEqual(s["pct"], 0.0)
        self.assertEqual(s["avg_steps"], 0)
        self.assertEqual(s["avg_q_s"], 0)
        self.assertEqual(s["std_q_s"], 0.0)

    def test_all_judge_errors_pct_zero_not_crash(self):
        rows = [_row("error", "answered", 0.0, 1, 1.0)]
        s = summarize(rows, "m", "id/m", duration_s=1)
        self.assertEqual(s["n_scored"], 0)
        self.assertEqual(s["pct"], 0.0)


class RepresentativeSubsetTest(unittest.TestCase):
    def setUp(self):
        self.qs = [{"id": f"q{i:02d}"} for i in range(1, 31)]  # q01..q30

    def test_includes_first_and_last(self):
        sub = representative_subset(self.qs, 5)
        self.assertEqual(sub[0]["id"], "q01")
        self.assertEqual(sub[-1]["id"], "q30")  # deep-fact questions are never skipped

    def test_even_spread(self):
        self.assertEqual([q["id"] for q in representative_subset(self.qs, 5)],
                         ["q01", "q08", "q15", "q23", "q30"])

    def test_deterministic(self):
        self.assertEqual(representative_subset(self.qs, 7), representative_subset(self.qs, 7))

    def test_limit_ge_len_returns_all(self):
        self.assertEqual(representative_subset(self.qs, 30), self.qs)
        self.assertEqual(representative_subset(self.qs, 999), self.qs)

    def test_nonpositive_returns_all(self):
        self.assertEqual(representative_subset(self.qs, 0), self.qs)

    def test_one(self):
        self.assertEqual(representative_subset(self.qs, 1), [self.qs[0]])


class ParseJsonTest(unittest.TestCase):
    def test_plain_object(self):
        self.assertEqual(
            _parse_json('{"verdict": "correct", "score": 1.0}'),
            {"verdict": "correct", "score": 1.0},
        )

    def test_object_with_surrounding_text(self):
        self.assertEqual(_parse_json('here it is {"a": 1} thanks'), {"a": 1})

    def test_no_json_returns_none(self):
        self.assertIsNone(_parse_json("no json here at all"))

    def test_malformed_json_returns_none(self):
        self.assertIsNone(_parse_json("{not valid json}"))


if __name__ == "__main__":
    unittest.main()
