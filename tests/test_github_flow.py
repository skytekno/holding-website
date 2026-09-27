import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("configure_github", ROOT / "scripts/configure_github.py")
github = importlib.util.module_from_spec(spec)
spec.loader.exec_module(github)


class GitHubFlowTests(unittest.TestCase):
    def setUp(self):
        self.settings = json.loads((ROOT / ".github/repository-settings.json").read_text())
        self.policy = json.loads((ROOT / ".github/rulesets/main.json").read_text())
        self.repo = {"default_branch": "main", "permissions": {"admin": True}, **self.settings}

    def test_check_and_reapply_are_read_only_when_already_correct(self):
        current = {"id": 42, **self.policy}
        for apply in [False, True]:
            with patch.object(github, "api", side_effect=[self.repo, {}, [{"id": 42, "name": self.policy["name"]}], current]) as api:
                github.configure(apply)
                self.assertTrue(all(len(call.args) == 1 for call in api.call_args_list))

    def test_missing_rule_fails_read_only_check(self):
        with patch.object(github, "api", side_effect=[self.repo, {}, []]) as api:
            with self.assertRaisesRegex(RuntimeError, "differs or is missing"):
                github.configure()
            self.assertEqual(api.call_count, 3)

    def test_non_admin_cannot_apply(self):
        with patch.object(github, "api", side_effect=[{**self.repo, "permissions": {"admin": False}}, {}, []]) as api:
            with self.assertRaisesRegex(RuntimeError, "administration permission"):
                github.configure(True)
            self.assertEqual(api.call_count, 3)

    def test_apply_backs_up_before_mutation_and_preserves_other_rulesets(self):
        changed = {**self.repo, "allow_merge_commit": True}
        saved = {"id": 42, **self.policy}
        with tempfile.TemporaryDirectory() as folder:
            calls = []
            def fake_api(route, method="GET", payload=None, paginate=False):
                calls.append((route, method))
                if method != "GET":
                    backups = list(Path(folder).glob("*.json"))
                    self.assertEqual(len(backups), 1)
                    self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
                    self.assertTrue(json.loads(backups[0].read_text())["settings"]["allow_merge_commit"])
                    return saved if method == "POST" else self.repo
                if "includes_parents" in route:
                    return [{"id": 77, "name": "Unrelated policy"}]
                if route.endswith("/rulesets/42"):
                    return saved
                if route.endswith("/branches/main"):
                    return {}
                return changed if len(calls) == 1 else self.repo
            with patch.object(github, "api", side_effect=fake_api):
                github.configure(True, Path(folder))
            self.assertEqual([method for _, method in calls if method != "GET"], ["POST", "PATCH"])
            self.assertFalse(any("/77" in route for route, _ in calls))

    def test_response_metadata_is_ignored_but_bypass_is_detected(self):
        self.assertTrue(github.matches({"id": 42, **self.policy}, self.policy))
        self.assertFalse(github.matches({**self.policy, "bypass_actors": [{"actor_type": "OrganizationAdmin"}]}, self.policy))

    def test_apply_refuses_to_remove_existing_review_protection(self):
        current = {"id": 42, **json.loads(json.dumps(self.policy))}
        next(rule for rule in current["rules"] if rule["type"] == "pull_request")["parameters"]["required_approving_review_count"] = 1
        with patch.object(github, "api", side_effect=[self.repo, {}, [{"id": 42, "name": self.policy["name"]}], current]) as api:
            with self.assertRaisesRegex(RuntimeError, "additional protections"):
                github.configure(True)
            self.assertEqual(api.call_count, 4)


if __name__ == "__main__":
    unittest.main()
