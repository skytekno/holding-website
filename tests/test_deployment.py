"""Release contract tests: migration gating, secret isolation and immutable inputs."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import cloud_release as release
import import_database as database


CONFIG = {"project": "skyholding-test", "region": "asia-southeast2", "name": "skyholding"}
IMAGES = {s: f"asia-southeast2-docker.pkg.dev/skyholding-test/skyholding/{s}@sha256:" + "a" * 64
          for s in release.SERVICES}
SOURCE = {"repository": release.REPOSITORY, "workflow": release.WORKFLOW_REF,
          "run_id": "123", "build_attempt": "1"}
DATA = {**CONFIG, "images": IMAGES, "release": "r-123-1", "commit": "b" * 40, "source": SOURCE}
ENV = {"DATABASE_SECRET_VERSION": "1", "MIGRATION_DATABASE_SECRET_VERSION": "2",
       "GOOGLE_CLIENT_ID": "123-example.apps.googleusercontent.com", "ADMIN_EMAILS": "admin@example.com",
       "COMMIT_SHA": DATA["commit"]}
CI_ENV = {**ENV, "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": release.REPOSITORY,
          "GITHUB_REF": "refs/heads/main", "GITHUB_WORKFLOW_REF": release.WORKFLOW_REF,
          "GITHUB_JOB": "deploy", "CI_REQUIRED_RESULT": "success", "GITHUB_EVENT_NAME": "push",
          "GITHUB_SHA": DATA["commit"], "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2"}


class DeploymentTests(unittest.TestCase):
    @patch.dict(os.environ, ENV, clear=True)
    def test_manifest_security_and_migration_identity(self):
        manifests = release.manifests(CONFIG, IMAGES)
        api = manifests["api"]["spec"]["template"]
        job = manifests["migrate"]["spec"]["template"]
        self.assertEqual(api["metadata"]["annotations"]["run.googleapis.com/vpc-access-egress"], "all-traffic")
        self.assertEqual(job["metadata"]["annotations"]["run.googleapis.com/vpc-access-egress"], "all-traffic")
        task = job["spec"]["template"]["spec"]
        self.assertEqual(task["maxRetries"], 0)
        self.assertEqual(task["containers"][0]["args"], ["--migrate"])
        self.assertNotEqual(task["serviceAccountName"], api["spec"]["serviceAccountName"])
        self.assertEqual(task["containers"][0]["image"], api["spec"]["containers"][0]["image"])
        for key in ("web", "dashboard"):
            serialized = json.dumps(manifests[key])
            self.assertNotIn("DATABASE_URL", serialized)
            self.assertNotIn("secretKeyRef", serialized)
            self.assertNotIn("network-interfaces", serialized)
            self.assertEqual(manifests[key]["metadata"]["annotations"]["run.googleapis.com/ingress"],
                             "internal-and-cloud-load-balancing")

    @patch.dict(os.environ, {**ENV, "DATABASE_CA_SECRET_VERSION": "3"}, clear=True)
    def test_custom_ca_applies_to_api_and_migration_only(self):
        manifests = release.manifests(CONFIG, IMAGES)
        for spec in (manifests["api"]["spec"]["template"]["spec"],
                     manifests["migrate"]["spec"]["template"]["spec"]["template"]["spec"]):
            secret = spec["volumes"][0]["secret"]
            self.assertEqual(secret["defaultMode"], 0o444)
            self.assertEqual(secret["items"][0]["key"], "3")
            self.assertIn({"name": "PGSSLROOTCERT", "value": "/var/run/secrets/postgres/ca.pem"},
                          spec["containers"][0]["env"])

    @patch.dict(os.environ, {**ENV, "DATABASE_SECRET_VERSION": "latest"}, clear=True)
    def test_rejects_mutable_secret_version(self):
        with self.assertRaises(ValueError):
            release.manifests(CONFIG, IMAGES)

    @patch.dict(os.environ, {}, clear=True)
    def test_rejects_wrong_provenance_and_mutable_image(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "artifact.json"
            for bad in ({**DATA, "project": "wrong-project"}, {**DATA, "images": {**IMAGES, "api": "api:latest"}}):
                release.write_json(path, bad)
                with self.assertRaises(ValueError):
                    release.load_artifact(CONFIG, path)
            release.write_json(path, DATA)
            with patch.dict(os.environ, {"COMMIT_SHA": "c" * 40}):
                with self.assertRaises(ValueError):
                    release.load_artifact(CONFIG, path)

    @patch.dict(os.environ, ENV, clear=True)
    def test_migration_failure_prevents_every_application_release_and_keeps_lock(self):
        calls = []
        def gcloud(config, *args, **kwargs):
            calls.append(args)
            if args[:3] == ("storage", "objects", "describe"):
                return "123"
            if args[:3] == ("run", "jobs", "execute"):
                raise subprocess.CalledProcessError(1, ["gcloud", "run", "jobs", "execute"])
        with tempfile.TemporaryDirectory() as folder, patch.object(release, "gcloud", side_effect=gcloud), \
                patch.object(release, "verify_release_source", return_value=SOURCE), \
                patch.object(release, "wait_rollout"):
            with self.assertRaises(subprocess.CalledProcessError):
                release.release(CONFIG, DATA, Path(folder))
        created = [c for c in calls if c[:3] == ("deploy", "releases", "create")]
        self.assertEqual(len(created), 1)
        self.assertIn("--delivery-pipeline=skyholding-migrate", created[0])
        self.assertFalse(any(c[:2] == ("storage", "rm") for c in calls))

    @patch.dict(os.environ, ENV, clear=True)
    def test_success_waits_for_each_rollout_and_releases_lock(self):
        events = []
        def gcloud(config, *args, **kwargs):
            events.append(args)
            if args[:3] == ("storage", "objects", "describe"):
                return "123"
        with tempfile.TemporaryDirectory() as folder, patch.object(release, "gcloud", side_effect=gcloud), \
                patch.object(release, "verify_release_source", return_value=SOURCE), \
                patch.object(release, "wait_rollout", side_effect=lambda _, pipeline, __: events.append(("wait", pipeline))):
            evidence = Path(folder) / "deployment.json"
            release.release(CONFIG, DATA, Path(folder), evidence)
            self.assertEqual(json.loads(evidence.read_text())["status"], "SUCCEEDED")
            self.assertEqual(json.loads(evidence.read_text())["migration"], "SUCCEEDED")
        self.assertEqual([e[1] for e in events if e[0] == "wait"],
                         ["skyholding-migrate", "skyholding-api", "skyholding-web", "skyholding-dashboard"])
        migrate_wait = events.index(("wait", "skyholding-migrate"))
        self.assertEqual(events[migrate_wait + 1][:3], ("run", "jobs", "execute"))
        self.assertEqual(events[-1][:2], ("storage", "rm"))
        self.assertIn("--if-generation-match=123", events[-1])
        self.assertIn("--if-generation-match=0", events[0])

    @patch.dict(os.environ, ENV, clear=True)
    def test_concurrent_release_does_not_create_a_rollout(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(release, "gcloud",
                side_effect=subprocess.CalledProcessError(1, ["gcloud", "storage", "cp"])) as call, \
                patch.object(release, "verify_release_source", return_value=SOURCE):
            with self.assertRaises(subprocess.CalledProcessError):
                release.release(CONFIG, DATA, Path(folder))
            self.assertEqual(call.call_count, 1)

    @patch.dict(os.environ, CI_ENV, clear=True)
    def test_release_source_requires_main_ci_context(self):
        for key, value in {"GITHUB_ACTIONS": "false", "GITHUB_REPOSITORY": "attacker/fork",
                           "GITHUB_REF": "refs/heads/feature", "GITHUB_EVENT_NAME": "pull_request",
                           "GITHUB_WORKFLOW_REF": "another-workflow", "CI_REQUIRED_RESULT": "skipped",
                           "GITHUB_SHA": "c" * 40}.items():
            with self.subTest(key=key), patch.dict(os.environ, {key: value}), \
                    patch.object(release.subprocess, "run") as git:
                with self.assertRaises(ValueError):
                    release.verify_release_source("deploy")
                git.assert_not_called()

    @patch.dict(os.environ, CI_ENV, clear=True)
    def test_release_source_rejects_dirty_wrong_or_superseded_commit(self):
        for head, dirty, latest in (("c" * 40, "", DATA["commit"]),
                                    (DATA["commit"], "?? injected-file", DATA["commit"]),
                                    (DATA["commit"], "", "c" * 40)):
            results = [subprocess.CompletedProcess([], 0, stdout=value) for value in (head, dirty)]
            with self.subTest(head=head, dirty=dirty, latest=latest), \
                    patch.object(release.subprocess, "run", side_effect=results), \
                    patch.object(release, "current_main_sha", return_value=latest):
                with self.assertRaises(ValueError):
                    release.verify_release_source("deploy")

    @patch.dict(os.environ, CI_ENV, clear=True)
    def test_checked_main_can_rerun_deploy_with_original_build_artifact(self):
        results = [subprocess.CompletedProcess([], 0, stdout=value) for value in (DATA["commit"], "")]
        with patch.object(release.subprocess, "run", side_effect=results), \
                patch.object(release, "current_main_sha", return_value=DATA["commit"]):
            source = release.verify_release_source("deploy")
        self.assertEqual(source["run_id"], SOURCE["run_id"])
        self.assertNotEqual(source["build_attempt"], SOURCE["build_attempt"])
        with tempfile.TemporaryDirectory() as folder, patch.object(release, "verify_release_source", return_value=source), \
                patch.object(release, "gcloud", return_value="123"), patch.object(release, "wait_rollout"):
            release.release(CONFIG, DATA, Path(folder))

    @patch.dict(os.environ, ENV, clear=True)
    def test_superseded_source_inside_lock_releases_only_owned_lock_without_rollouts(self):
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(release, "verify_release_source", side_effect=[SOURCE, ValueError("superseded")]), \
                patch.object(release, "gcloud", return_value="123") as cloud:
            with self.assertRaises(ValueError):
                release.release(CONFIG, DATA, Path(folder))
        commands = [call.args[1:] for call in cloud.call_args_list]
        self.assertEqual([command[:2] for command in commands],
                         [("storage", "cp"), ("storage", "objects"), ("storage", "rm")])
        self.assertIn("--if-generation-match=123", commands[-1])

    @patch.dict(os.environ, ENV, clear=True)
    def test_artifact_from_another_run_cannot_mutate_cloud(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(release, "verify_release_source", return_value=SOURCE), \
                patch.object(release, "gcloud") as cloud:
            with self.assertRaises(ValueError):
                release.release(CONFIG, {**DATA, "source": {**SOURCE, "run_id": "456"}}, Path(folder))
            cloud.assert_not_called()

    def test_required_gate_cannot_pass_skipped_failed_cancelled_or_non_main_manual_run(self):
        workflow = (release.ROOT / ".github/workflows/ci.yml").read_text()
        gate = workflow.split("  required:\n", 1)[1].split("  build:\n", 1)[0]
        self.assertIn("name: CI required", gate)
        self.assertIn("if: always()", gate)
        script = "\n".join(line[10:] for line in gate.split("        run: |\n", 1)[1].splitlines())
        with tempfile.TemporaryDirectory() as folder:
            env = {**os.environ, "EVENT_NAME": "push", "SOURCE_REF": "refs/heads/main",
                   "GITHUB_STEP_SUMMARY": str(Path(folder) / "summary"), "GCP_PROJECT_ID": ""}
            for checks in ("success", "failure", "skipped", "cancelled"):
                for integration in ("success", "failure", "skipped", "cancelled"):
                    result = subprocess.run(["bash", "-eo", "pipefail", "-c", script],
                        env={**env, "CHECKS_RESULT": checks, "INTEGRATION_RESULT": integration}, capture_output=True)
                    self.assertEqual(result.returncode == 0, checks == integration == "success")
            result = subprocess.run(["bash", "-eo", "pipefail", "-c", script], env={**env,
                "CHECKS_RESULT": "success", "INTEGRATION_RESULT": "success", "EVENT_NAME": "workflow_dispatch",
                "SOURCE_REF": "refs/heads/feature"}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)

    def test_workflow_action_refs_are_immutable_and_wif_matches_release_policy(self):
        workflow = (release.ROOT / ".github/workflows/ci.yml").read_text()
        refs = re.findall(r"uses: ([^\s]+)", workflow)
        self.assertTrue(refs)
        self.assertTrue(all(re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_-]+@[0-9a-f]{40}", ref) for ref in refs))
        wif = (release.ROOT / "infra/bootstrap/identity.tf").read_text()
        self.assertIn("assertion.workflow_ref == '" + release.WORKFLOW_REF + "'", wif)
        self.assertIn("assertion.event_name", wif)

    def test_render_and_rollout_failures_stop(self):
        for responses in (({"renderState": "FAILED"},),
                          ({"renderState": "SUCCEEDED"}, [{"state": "FAILED"}]),
                          ({"renderState": "SUCCEEDED"}, [{"state": "CANCELLED"}])):
            with patch.object(release, "gcloud", side_effect=[json.dumps(r) for r in responses]):
                with self.assertRaises(RuntimeError):
                    release.wait_rollout(CONFIG, "skyholding-api", "r-123-1")

    def test_database_import_rejects_unverified_or_ambiguous_tls_without_leaking_url(self):
        for suffix in ("", "?sslmode=require", "?sslmode=verify-full&sslmode=disable",
                       "?sslmode=verify-full&host=elsewhere", "?sslmode=verify-full#fragment"):
            url = "postgresql://user:do-not-print@db.example.com/cms" + suffix
            with self.assertRaises(ValueError) as caught:
                database.validate_url(url)
            self.assertNotIn("do-not-print", str(caught.exception))
        database.validate_url("postgresql://user:encoded%23secret@db.example.com/cms?sslmode=verify-full")


if __name__ == "__main__":
    unittest.main()
