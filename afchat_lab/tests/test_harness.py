"""Unit tests for the harness scoring math and judge JSON parsing.

Run from afchat_lab/ with the venv active:
    .venv/bin/python -m unittest discover -s tests
or, if pytest is installed:
    .venv/bin/python -m pytest tests
"""

import unittest

from pathlib import Path

from harness.judge import _parse_json
from harness.package import load_package
from harness.run_eval import representative_subset, summarize

LAB = Path(__file__).resolve().parent.parent


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


class AgentPackageTest(unittest.TestCase):
    def test_gemma4_package_loads(self):
        # The shared agent package lives at the repo root (loaded by lab AND Aristo).
        pkg = load_package(LAB.parent / "packages" / "gemma4-qa")
        self.assertEqual(pkg.name, "gemma4-qa")
        self.assertEqual(pkg.model["id"], "gemma-4-e4b:latest")
        self.assertEqual(pkg.model["context_length"], 32768)
        self.assertEqual(pkg.tool_names,
                         ["list_directory", "read_text_file", "search_content"])
        # v3: 8000 keeps a full 8-step run inside the 32k window (16000 overflowed
        # it on large docs and Ollama silently truncated the transcript);
        # num_predict bounds a runaway temp-0 repetition loop.
        self.assertEqual(pkg.runtime["max_tool_result_chars"], 8000)
        self.assertEqual(pkg.runtime["num_predict"], 2048)
        # the tuned prompt guidance must be present
        self.assertIn("search_content", pkg.system_prompt)
        self.assertIn("SAME language", pkg.system_prompt)

    def test_missing_keys_raise(self):
        import tempfile, os
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write('{"name": "x"}')  # no model/tools/system_prompt_file
            p = f.name
        try:
            with self.assertRaises(ValueError):
                load_package(p)
        finally:
            os.unlink(p)


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


class GrepSmartContextTest(unittest.TestCase):
    """search_content with OMITTED context returns the whole enclosing structure.

    Facts often sit in table rows that don't repeat the matched header keyword
    (e.g. a roster row "| 124-01 | מפקד הטייסת | 3,150 |" under a "שעות טיסה"
    column header) — a bare-match default silently strips the answer rows. The
    smart block returns the entire table (or paragraph) plus the nearest heading.
    """

    def setUp(self):
        import tempfile
        self.dir = tempfile.TemporaryDirectory()
        rows = "\n".join(f"| pilot-{k:02d} | {1000 + k} |" for k in range(1, 15))
        (Path(self.dir.name) / "doc.md").write_text(
            "## Squadron roster\n"
            "\n"
            "| role | flight hours |\n"
            "|------|-------------|\n"
            "| commander | 3,150 |\n"
            f"{rows}\n"
            "| newest wingman | 700 |\n"
            "\n"
            "The oldest airframe joined the squadron in 1998.\n"
            "It still flies every week.\n",
            encoding="utf-8",
        )

    def tearDown(self):
        self.dir.cleanup()

    def test_header_match_includes_bottom_row(self):
        from harness.agent import _grep_corpus
        out = _grep_corpus(self.dir.name, "flight hours")  # matches header only
        self.assertIn("3,150", out)   # first row
        self.assertIn("700", out)     # LAST row, 16 lines below the header

    def test_bottom_row_match_includes_header(self):
        from harness.agent import _grep_corpus
        out = _grep_corpus(self.dir.name, "newest wingman")
        self.assertIn("flight hours", out)  # header pulled in from above

    def test_nearest_heading_breadcrumb(self):
        from harness.agent import _grep_corpus
        out = _grep_corpus(self.dir.name, "commander")
        self.assertIn("## Squadron roster", out)

    def test_paragraph_expansion(self):
        from harness.agent import _grep_corpus
        out = _grep_corpus(self.dir.name, "1998")
        self.assertIn("every week", out)  # rest of the paragraph included

    def test_matches_in_same_table_collapse_to_one_block(self):
        from harness.agent import _grep_corpus
        out = _grep_corpus(self.dir.name, "pilot-")  # 14 matching rows
        self.assertEqual(out.count("| role | flight hours |"), 1)

    def test_explicit_zero_is_honored(self):
        from harness.agent import _grep_corpus
        out = _grep_corpus(self.dir.name, "flight hours", context=0)
        self.assertNotIn("3,150", out)

    def test_explicit_context_keeps_grep_a_behavior(self):
        from harness.agent import _grep_corpus
        out = _grep_corpus(self.dir.name, "flight hours", context=2)
        self.assertIn("3,150", out)   # 2 lines after the header
        self.assertNotIn("700", out)  # but not the bottom of the table


class GrepPathAndWideSearchTest(unittest.TestCase):
    """Bad paths must fail loudly; wide searches are diversified locators.

    A glob/unknown path silently scanning nothing reads exactly like "the fact
    is not in the documents" (observed model refusals). And a corpus-wide search
    must not let alphabetically-early files shadow the best-matching file.
    """

    def setUp(self):
        import tempfile
        self.dir = tempfile.TemporaryDirectory()
        base = Path(self.dir.name)
        # aa-*: early alphabetical file with a couple of matches; zz-*: LAST
        # alphabetical file with the most matches (the relevant one).
        (base / "aa-first.md").write_text("radar note\n\nradar again\n", encoding="utf-8")
        (base / "bb-second.md").write_text("radar mention\n", encoding="utf-8")
        (base / "cc-third.md").write_text("no match here\n", encoding="utf-8")
        (base / "dd-fourth.md").write_text("also nothing\n", encoding="utf-8")
        (base / "zz-target.md").write_text(
            "\n\n".join(f"radar fact {k}" for k in range(8)), encoding="utf-8")

    def tearDown(self):
        self.dir.cleanup()

    def test_glob_path_is_loud_error(self):
        from harness.agent import _grep_corpus
        out = _grep_corpus(self.dir.name, "radar", ["*"])
        self.assertIn("[tool error]", out)
        self.assertIn("Omit 'path'", out)

    def test_unknown_path_is_loud_error(self):
        from harness.agent import _grep_corpus
        out = _grep_corpus(self.dir.name, "radar", "no-such-file.md")
        self.assertIn("[tool error]", out)
        self.assertIn("no-such-file.md", out)

    def test_wide_search_ranks_best_file_first(self):
        from harness.agent import _grep_corpus
        out = _grep_corpus(self.dir.name, "radar")
        self.assertLess(out.index("zz-target.md"), out.index("aa-first.md"))

    def test_wide_search_caps_blocks_per_file_with_pointer(self):
        from harness.agent import _grep_corpus
        out = _grep_corpus(self.dir.name, "radar")
        self.assertEqual(out.count("zz-target.md:"), 3)  # 3 blocks, not all 8
        self.assertIn("more matching lines in zz-target.md", out)

    def test_wide_search_clamps_explicit_context(self):
        from harness.agent import _grep_corpus
        out = _grep_corpus(self.dir.name, "radar fact 0", context=25)
        # zz-target has 15 lines after the match; a wide search clamps to 10.
        self.assertEqual(out.count("zz-target.md:"), 11)

    def test_narrow_search_keeps_full_depth(self):
        from harness.agent import _grep_corpus
        out = _grep_corpus(self.dir.name, "radar fact 0", "zz-target.md", context=25)
        self.assertEqual(out.count("zz-target.md:"), 15)  # whole remaining file

    def test_toc_pattern_exempt_from_wide_caps(self):
        from harness.agent import _grep_corpus
        base = Path(self.dir.name)
        for k in range(6):
            (base / f"doc{k}.md").write_text(
                "\n".join(f"## section {k}-{h}\n\nbody" for h in range(5)), encoding="utf-8")
        out = _grep_corpus(self.dir.name, "## ", context=0)
        # 30 headings across 6 files — far beyond the wide 3-per-file/12-total caps.
        self.assertGreaterEqual(out.count("## section"), 30)

    def test_zero_hit_phrase_relaxes_to_words(self):
        from harness.agent import _grep_corpus
        out = _grep_corpus(self.dir.name, "radar maximum duration limit")
        self.assertIn("no lines matched the exact phrase", out)
        self.assertIn("zz-target.md", out)  # 'radar' word matches ranked in

    def test_line_budget_cuts_at_block_boundary_with_note(self):
        from harness.agent import _grep_corpus
        # 15 matches × 26 lines each in one file: far beyond the 110-line budget.
        base = Path(self.dir.name)
        (base / "zz-deep.md").write_text(
            "\n".join(f"radar item {k}\n" + "\n".join(f"detail {k}-{j}" for j in range(25))
                      for k in range(15)), encoding="utf-8")
        out = _grep_corpus(self.dir.name, "radar item", "zz-deep.md", context=25)
        self.assertIn("of 15 matches", out)
        self.assertNotIn("TRUNCATED", out)
        self.assertLess(len(out.splitlines()), 130)


class PointerNudgeTest(unittest.TestCase):
    def test_refusal_detection(self):
        from harness.agent import _is_refusal
        self.assertTrue(_is_refusal("המידע לא נמצא במסמכים שסופקו."))
        self.assertTrue(_is_refusal("The information is Not Found in the corpus."))
        self.assertFalse(_is_refusal("המהירות המרבית היא 168 קשר (eitam.md)"))

    def test_pointer_marks_match_grep_output(self):
        # The nudge triggers on markers _grep_corpus actually emits — keep in sync.
        import tempfile
        from harness.agent import _POINTER_MARKS, _grep_corpus
        with tempfile.TemporaryDirectory() as d:
            for k in range(5):
                (Path(d) / f"f{k}.md").write_text(
                    "\n\n".join(f"radar row {j}" for j in range(9)), encoding="utf-8")
            out = _grep_corpus(d, "radar")
            self.assertTrue(any(m in out for m in _POINTER_MARKS))


if __name__ == "__main__":
    unittest.main()
