#!/usr/bin/env python3
"""Check or apply the repository's GitHub Flow policy; never publish source."""

import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "skytekno/holding-website"
BASE = f"repos/{REPOSITORY}"


def api(route, method="GET", payload=None, paginate=False):
    command = ["gh", "api", route, "--method", method,
               "-H", "Accept: application/vnd.github+json",
               "-H", "X-GitHub-Api-Version: 2026-03-10"]
    if payload is not None:
        command.extend(["--input", "-"])
    if paginate:
        command.extend(["--paginate", "--slurp"])
    result = subprocess.run(command, input=json.dumps(payload) if payload is not None else None,
                            capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"GitHub {method} {route} failed: {result.stderr.strip()}")
    value = json.loads(result.stdout)
    return [item for page in value for item in page] if paginate else value


def matches(actual, expected):
    """Compare intended fields while allowing response-only object metadata."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            key in actual and matches(actual[key], value) for key, value in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(
            any(matches(item, value) for item in actual) for value in expected)
    return actual == expected


def preserve_stronger_policy(current, desired):
    if current is None:
        return
    live_rules = {rule["type"]: rule for rule in current["rules"]}
    wanted_rules = {rule["type"]: rule for rule in desired["rules"]}
    conflict = bool(live_rules.keys() - wanted_rules.keys())
    conflict |= not matches(current["conditions"], desired["conditions"])
    live_review = live_rules.get("pull_request", {}).get("parameters", {})
    wanted_review = wanted_rules["pull_request"]["parameters"]
    conflict |= live_review.get("required_approving_review_count", 0) > wanted_review["required_approving_review_count"]
    for option in ["require_code_owner_review", "require_last_push_approval"]:
        conflict |= bool(live_review.get(option)) and not wanted_review[option]
    live_checks = live_rules.get("required_status_checks", {}).get("parameters", {}).get("required_status_checks", [])
    wanted_checks = wanted_rules["required_status_checks"]["parameters"]["required_status_checks"]
    conflict |= any(not any(matches(check, wanted) for wanted in wanted_checks) for check in live_checks)
    if conflict:
        raise RuntimeError("The existing named ruleset has additional protections or different branch scope. Reconcile the JSON policy before applying; nothing changed.")


def configure(apply=False, backup_root=None):
    policy = json.loads((ROOT / ".github/rulesets/main.json").read_text())
    settings = json.loads((ROOT / ".github/repository-settings.json").read_text())
    repository = api(BASE)
    if repository.get("default_branch") != "main":
        raise RuntimeError("Establish main as the default branch before activating GitHub Flow.")
    api(f"{BASE}/branches/main")
    rulesets = api(f"{BASE}/rulesets?includes_parents=false&per_page=100", paginate=True)
    named = [item for item in rulesets if item["name"] == policy["name"]]
    if len(named) > 1:
        raise RuntimeError("Multiple rulesets have the managed name; reconcile them before applying.")
    current = api(f"{BASE}/rulesets/{named[0]['id']}") if named else None
    if matches(repository, settings) and matches(current, policy):
        print("GitHub Flow merge settings and main ruleset match the checked-in policy.")
        return
    if not apply:
        raise RuntimeError("GitHub Flow policy differs or is missing. Review the JSON policies, then run with --apply.")
    if not repository.get("permissions", {}).get("admin"):
        raise RuntimeError("Repository administration permission is required; nothing changed.")
    preserve_stronger_policy(current, policy)

    backup_dir = backup_root or ROOT / ".artifacts"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = backup_dir / f"github-flow-before-{stamp}.json"
    with os.fdopen(os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as handle:
        json.dump({"repository": REPOSITORY,
                   "settings": {key: repository.get(key) for key in settings},
                   "ruleset": current}, handle, indent=2)
    print(f"Saved previous managed settings to {backup}", flush=True)

    # Install protection first; a later settings failure must not remove it.
    if not matches(current, policy):
        route = f"{BASE}/rulesets/{current['id']}" if current else f"{BASE}/rulesets"
        saved = api(route, "PUT" if current else "POST", policy)
    else:
        saved = current
    if not matches(repository, settings):
        api(BASE, "PATCH", settings)
    if not matches(api(f"{BASE}/rulesets/{saved['id']}"), policy) or not matches(api(BASE), settings):
        raise RuntimeError("GitHub returned settings that differ from the policy; inspect the saved backup and live rules.")
    print("Applied and verified GitHub Flow merge settings and main ruleset.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Back up and apply the reviewed JSON policy; default is read-only.")
    args = parser.parse_args()
    try:
        configure(args.apply)
    except (OSError, ValueError, RuntimeError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
