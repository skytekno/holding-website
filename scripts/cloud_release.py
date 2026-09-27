#!/usr/bin/env python3
"""Build immutable images and release through Cloud Deploy. Uses no database payloads."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SERVICES = ("api", "web", "dashboard")
REPOSITORY = "skytekno/holding-website"
WORKFLOW_REF = f"{REPOSITORY}/.github/workflows/ci.yml@refs/heads/main"


def required(name, pattern=None, default=None):
    value = os.environ.get(name, default)
    if not value or (pattern and not re.fullmatch(pattern, value)):
        raise ValueError(f"Set a valid {name}; see infra/README.md")
    return value


def settings():
    return {
        "project": required("PROJECT_ID", r"[a-z][a-z0-9-]{4,28}[a-z0-9]"),
        "region": required("REGION", r"[a-z]+-[a-z]+[0-9]+", "asia-southeast2"),
        "name": required("RESOURCE_NAME", r"[a-z][a-z0-9-]{0,19}", "skyholding"),
    }


def gcloud(config, *args, capture=False):
    result = subprocess.run(
        ["gcloud", *args, f"--project={config['project']}", "--quiet"],
        check=True, text=True, stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else None


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def current_main_sha():
    request = urllib.request.Request(
        f"https://api.github.com/repos/{REPOSITORY}/git/ref/heads/main",
        headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                 "Authorization": f"Bearer {required('GH_TOKEN')}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)["object"]["sha"]
    except (urllib.error.URLError, KeyError, ValueError) as error:
        raise RuntimeError("Cannot verify current main on GitHub; refusing production release") from error


def verify_release_source(job):
    """Policy guard, backed by WIF and the protected-main ruleset, not local env trust."""
    expected = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": REPOSITORY,
                "GITHUB_REF": "refs/heads/main", "GITHUB_WORKFLOW_REF": WORKFLOW_REF,
                "GITHUB_JOB": job, "CI_REQUIRED_RESULT": "success"}
    if any(os.environ.get(key) != value for key, value in expected.items()):
        raise ValueError("Production builds/releases require the checked main CI workflow")
    if os.environ.get("GITHUB_EVENT_NAME") not in ("push", "workflow_dispatch"):
        raise ValueError("Only main push or main workflow_dispatch can release production")
    commit = required("COMMIT_SHA", r"[0-9a-f]{40}")
    if os.environ.get("GITHUB_SHA") != commit:
        raise ValueError("COMMIT_SHA must equal the workflow's checked source commit")
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, check=True,
                          text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()
    dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=ROOT,
                           check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()
    if head != commit or dirty:
        raise ValueError("Release source must be a clean checkout of the workflow commit")
    if current_main_sha() != commit:
        raise ValueError("This commit has been superseded on main; run the workflow for current main")
    return {"repository": REPOSITORY, "workflow": WORKFLOW_REF,
            "run_id": required("GITHUB_RUN_ID", r"[1-9][0-9]*"),
            "build_attempt": required("GITHUB_RUN_ATTEMPT", r"[1-9][0-9]*")}


def build(config, artifact):
    source = verify_release_source("build")
    release = required("RELEASE_ID", r"[a-z][a-z0-9-]{0,61}[a-z0-9]")
    commit = required("COMMIT_SHA", r"[0-9a-f]{40}")
    project, region, name = (config[k] for k in ("project", "region", "name"))
    gcloud(config, "builds", "submit", str(ROOT), f"--region={region}",
           f"--config={ROOT / 'infra/cloudbuild.yaml'}", f"--ignore-file={ROOT / '.gcloudignore'}",
           f"--service-account=projects/{project}/serviceAccounts/{name}-build@{project}.iam.gserviceaccount.com",
           f"--gcs-source-staging-dir=gs://{project}-{name}-build-source/source",
           f"--substitutions=_REGION={region},_REPOSITORY={name},_TAG={release}")
    images = {}
    for service in SERVICES:
        image = f"{region}-docker.pkg.dev/{project}/{name}/{service}"
        digest = gcloud(config, "artifacts", "docker", "images", "describe", f"{image}:{release}",
                        "--format=value(image_summary.digest)", capture=True)
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise ValueError(f"Artifact Registry returned an invalid digest for {service}")
        images[service] = f"{image}@{digest}"
    write_json(artifact, {**config, "release": release, "commit": commit, "images": images, "source": source})


def load_artifact(config, artifact):
    data = json.loads(artifact.read_text())
    if any(data.get(k) != v for k, v in config.items()):
        raise ValueError("Build artifact project/region/resource name does not match this deployment")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,61}[a-z0-9]", data.get("release", "")):
        raise ValueError("Invalid release ID in artifact")
    if not re.fullmatch(r"[0-9a-f]{40}", data.get("commit", "")):
        raise ValueError("Missing full source commit in artifact")
    expected_commit = os.environ.get("COMMIT_SHA")
    if expected_commit and data["commit"] != expected_commit:
        raise ValueError("Build artifact does not belong to the checked-out commit")
    for service in SERVICES:
        prefix = f"{config['region']}-docker.pkg.dev/{config['project']}/{config['name']}/{service}@sha256:"
        if not re.fullmatch(re.escape(prefix) + r"[0-9a-f]{64}", data.get("images", {}).get(service, "")):
            raise ValueError(f"Expected a same-project immutable digest for {service}")
    return data


def manifests(config, images):
    project, region, name = (config[k] for k in ("project", "region", "name"))
    db_version = required("DATABASE_SECRET_VERSION", r"[1-9][0-9]*")
    migration_version = required("MIGRATION_DATABASE_SECRET_VERSION", r"[1-9][0-9]*")
    client = required("GOOGLE_CLIENT_ID", r"[A-Za-z0-9_-]+\.apps\.googleusercontent\.com")
    admins = [v.strip().lower() for v in required("ADMIN_EMAILS").split(",")]
    if not all(re.fullmatch(r"[^ @,]+@[^ @,]+\.[^ @,]+", v) for v in admins):
        raise ValueError("ADMIN_EMAILS must be a comma-separated email allowlist")
    ca_version = os.environ.get("DATABASE_CA_SECRET_VERSION", "")
    if ca_version and not re.fullmatch(r"[1-9][0-9]*", ca_version):
        raise ValueError("DATABASE_CA_SECRET_VERSION must be empty or a numeric version")
    network = {"run.googleapis.com/network-interfaces": json.dumps([
        {"network": name, "subnetwork": f"{name}-run"}]),
        "run.googleapis.com/vpc-access-egress": "all-traffic"}
    environment = {
        "api": {"APP_ENV": "production", "GOOGLE_CLIENT_ID": client, "ADMIN_EMAILS": ",".join(admins),
                "CORS_ORIGINS": "https://cms.skyhold.ing", "STORAGE_BACKEND": "gcs",
                "GCS_BUCKET": f"{project}-{name}-assets", "ASSETS_BASE_URL": "https://assets.skyhold.ing",
                "DATABASE_MAX_CONNECTIONS": "5", "RUST_LOG": "info,tower_http=info"},
        "web": {"NODE_ENV": "production", "API_URL": "https://api.skyhold.ing", "SITE_URL": "https://skyhold.ing"},
        "dashboard": {"NODE_ENV": "production", "APP_ENV": "production", "API_URL": "https://api.skyhold.ing",
                      "SITE_URL": "https://skyhold.ing", "GOOGLE_CLIENT_ID": client},
        "migrate": {"APP_ENV": "production", "RUST_LOG": "info"},
    }
    result = {}
    for service in ("migrate", *SERVICES):
        database = service in ("api", "migrate")
        container = {"image": images["api" if service == "migrate" else service],
                     "resources": {"limits": {"cpu": "1", "memory": "512Mi"}},
                     "env": [{"name": k, "value": v} for k, v in environment[service].items()]}
        spec = {"serviceAccountName": f"{name}-{service}@{project}.iam.gserviceaccount.com", "containers": [container]}
        if database:
            secret = f"{name}-{'migration-' if service == 'migrate' else ''}database-url"
            container["env"].append({"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {
                "name": secret, "key": migration_version if service == "migrate" else db_version}}})
            if ca_version:
                container["env"].append({"name": "PGSSLROOTCERT", "value": "/var/run/secrets/postgres/ca.pem"})
                container["volumeMounts"] = [{"name": "database-ca", "mountPath": "/var/run/secrets/postgres"}]
                spec["volumes"] = [{"name": "database-ca", "secret": {"secretName": f"{name}-database-ca",
                    "items": [{"key": ca_version, "path": "ca.pem"}], "defaultMode": 292}}]
        metadata = {"name": f"{name}-{service}", "labels": {"cloud.googleapis.com/location": region}}
        if service == "migrate":
            container["args"] = ["--migrate"]
            spec.update({"maxRetries": 0, "timeoutSeconds": "600"})
            result[service] = {"apiVersion": "run.googleapis.com/v1", "kind": "Job", "metadata": metadata,
                "spec": {"template": {"metadata": {"annotations": network},
                    "spec": {"taskCount": 1, "parallelism": 1, "template": {"spec": spec}}}}}
        else:
            metadata["annotations"] = {"run.googleapis.com/ingress": "internal-and-cloud-load-balancing"}
            annotations = {"run.googleapis.com/execution-environment": "gen2", "autoscaling.knative.dev/minScale": "0",
                "autoscaling.knative.dev/maxScale": "5", "run.googleapis.com/cpu-throttling": "true",
                "run.googleapis.com/startup-cpu-boost": "true"}
            if database:
                annotations.update(network)
            spec.update({"containerConcurrency": 40 if service == "api" else 80, "timeoutSeconds": 60})
            container["ports"] = [{"containerPort": 8080}]
            container["startupProbe"] = {"periodSeconds": 5, "timeoutSeconds": 3, "failureThreshold": 48,
                "httpGet": {"path": "/health/ready" if service == "api" else "/health", "port": 8080}}
            container["livenessProbe"] = {"periodSeconds": 30, "timeoutSeconds": 3, "failureThreshold": 3,
                "httpGet": {"path": "/health/live" if service == "api" else "/health", "port": 8080}}
            result[service] = {"apiVersion": "serving.knative.dev/v1", "kind": "Service", "metadata": metadata,
                "spec": {"template": {"metadata": {"annotations": annotations}, "spec": spec},
                         "traffic": [{"latestRevision": True, "percent": 100}]}}
    return result


def render(config, data, directory):
    for service, manifest in manifests(config, data["images"]).items():
        target = directory / service
        # JSON is valid YAML. Only these two non-secret files enter Cloud Deploy's source bundle.
        write_json(target / "service.yaml", manifest)
        write_json(target / "skaffold.yaml", {"apiVersion": "skaffold/v4beta7", "kind": "Config",
            "metadata": {"name": f"{config['name']}-{service}"},
            "manifests": {"rawYaml": ["service.yaml"]}, "deploy": {"cloudrun": {}}})


def wait_rollout(config, pipeline, release, timeout=600):
    deadline = time.monotonic() + timeout
    common = [f"--region={config['region']}", f"--delivery-pipeline={pipeline}"]
    previous = None
    while time.monotonic() < deadline:
        rendered = json.loads(gcloud(config, "deploy", "releases", "describe", release, *common, "--format=json", capture=True))
        if rendered.get("renderState") == "FAILED":
            raise RuntimeError(f"Cloud Deploy render failed: {pipeline}/{release}")
        rollouts = json.loads(gcloud(config, "deploy", "rollouts", "list", *common, f"--release={release}",
                                    "--format=json", capture=True))
        if len(rollouts) > 1:
            raise RuntimeError("Unexpected extra rollout; inspect Cloud Deploy before continuing")
        state = rollouts[0].get("state") if rollouts else "RENDERING"
        if state != previous:
            print(f"{pipeline}: {state}", flush=True)
            previous = state
        if state == "SUCCEEDED":
            return
        if state in {"FAILED", "CANCELLED", "HALTED", "APPROVAL_REJECTED", "PENDING_APPROVAL"}:
            raise RuntimeError(f"Rollout cannot continue: {pipeline}/{release}: {state}")
        time.sleep(10)
    raise TimeoutError(f"Rollout timed out: {pipeline}/{release}; it may still be running")


def release(config, data, directory, evidence=None):
    source = verify_release_source("deploy")
    built_from = data.get("source", {})
    if any(built_from.get(key) != source[key] for key in ("repository", "workflow", "run_id")):
        raise ValueError("Release artifact must come from this workflow run's successful build")
    if data.get("commit") != required("COMMIT_SHA", r"[0-9a-f]{40}"):
        raise ValueError("Release artifact must match the checked source commit")
    render(config, data, directory)
    project, region, name = (config[k] for k in ("project", "region", "name"))
    bucket = f"gs://{project}-{name}-deploy"
    lock = bucket + "/release.lock"
    lock_file = directory / "release-lock.json"
    write_json(lock_file, {"release": data["release"], "commit": data["commit"], "created": int(time.time())})
    progress = {"project": project, "region": region, "release": data["release"], "commit": data["commit"],
                "images": data["images"], "source": built_from, "status": "in_progress",
                "rollouts": [], "migration": "pending", "started": int(time.time())}
    def record():
        if evidence is not None:
            write_json(evidence, progress)
    record()
    # The precondition prevents overlapping releases from replacing the migration job.
    try:
        gcloud(config, "storage", "cp", str(lock_file), lock, "--if-generation-match=0")
    except subprocess.CalledProcessError:
        progress.update(status="FAILED", error_type="LockAcquisitionFailed", lock_acquired=False)
        record()
        raise
    generation = None
    mutation_started = False
    try:
        generation = gcloud(config, "storage", "objects", "describe", lock,
                            "--format=value(generation)", capture=True)
        if not re.fullmatch(r"[1-9][0-9]*", generation):
            generation = None
            raise RuntimeError("Could not identify the acquired release lock generation")
        # Another release may have held the lock while this build was running.
        # Reject superseded source before the first rollout can mutate production.
        verify_release_source("deploy")
        for service in ("migrate", *SERVICES):
            pipeline = f"{name}-{service}"
            mutation_started = True
            gcloud(config, "deploy", "releases", "create", data["release"], f"--region={region}",
                   f"--delivery-pipeline={pipeline}", f"--source={directory / service}",
                   "--skaffold-file=skaffold.yaml", f"--gcs-source-staging-dir={bucket}/source",
                   f"--annotations=commit={data['commit']}")
            wait_rollout(config, pipeline, data["release"])
            progress["rollouts"].append({"pipeline": pipeline, "status": "SUCCEEDED"})
            record()
            if service == "migrate":
                gcloud(config, "run", "jobs", "execute", f"{name}-migrate", f"--region={region}", "--wait")
                progress["migration"] = "SUCCEEDED"
                record()
        gcloud(config, "storage", "rm", lock, f"--if-generation-match={generation}")
    except BaseException as error:
        retained = True
        if not mutation_started and generation is not None:
            try:
                gcloud(config, "storage", "rm", lock, f"--if-generation-match={generation}")
                retained = False
            except subprocess.CalledProcessError:
                pass
        progress.update(status="FAILED", error_type=type(error).__name__, lock_retained=retained)
        record()
        if retained:
            print(f"Release stopped. Lock retained at {lock}; inspect rollouts/job executions before clearing it. "
                  "No automatic database rollback was attempted.", file=sys.stderr)
        raise
    progress.update(status="SUCCEEDED", completed=int(time.time()), lock_retained=False)
    record()
    print(f"Release {data['release']} succeeded across all four Cloud Deploy pipelines.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "release", "render"))
    parser.add_argument("--artifact", type=Path, default=ROOT / ".artifacts/release.json")
    parser.add_argument("--output", type=Path, default=ROOT / ".artifacts/cloud-deploy")
    parser.add_argument("--evidence", type=Path, default=ROOT / ".artifacts/deployment.json")
    args = parser.parse_args()
    config = settings()
    if args.command == "build":
        build(config, args.artifact)
    else:
        data = load_artifact(config, args.artifact)
        if args.command == "render":
            render(config, data, args.output)
        else:
            with tempfile.TemporaryDirectory(prefix="skyholding-release-") as temp:
                release(config, data, Path(temp), args.evidence)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, TimeoutError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
