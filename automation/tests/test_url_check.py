import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from url_check import soft_404_pattern


class ClosureDetectionTests(unittest.TestCase):
    def test_conditional_deadlines_are_not_closures(self):
        for text in (
            "Applications accepted through 02/08/2027 or until the role is filled.",
            "Apply until this position is filled.",
            "Applications remain open until the job has been filled.",
            "Contact us before the opening is closed.",
            "We will notify candidates if the role is closed.",
            "We may remove the listing once the position is filled.",
            "Applications are accepted UNTIL THE ROLE IS FILLED.",
        ):
            with self.subTest(text=text):
                self.assertIsNone(soft_404_pattern(text))

    def test_actual_closures_still_match(self):
        for text in (
            "This position has been filled.",
            "The role is closed.",
            "This job is no longer available.",
            "No longer accepting applications.",
            "We've filled this position.",
            "This requisition has been closed.",
            "This listing has expired.",
        ):
            with self.subTest(text=text):
                self.assertIsNotNone(soft_404_pattern(text))

    def test_deadline_does_not_hide_separate_closure(self):
        self.assertIsNotNone(
            soft_404_pattern(
                "Applications accepted until the role is filled. "
                "Update: this position has been filled."
            )
        )

    def test_ordinary_posting_has_no_closure(self):
        self.assertIsNone(
            soft_404_pattern("Senior Product Manager, Growth. Apply for this job.")
        )


if __name__ == "__main__":
    unittest.main()
