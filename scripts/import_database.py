#!/usr/bin/env python3
"""Import externally provisioned PostgreSQL credentials; never print payloads."""

import os
from pathlib import Path
import stat
import subprocess
import sys
from urllib.parse import parse_qsl, unquote, urlsplit

from cloud_release import settings


def validate_url(value):
    try:
        url = urlsplit(value)
        query = parse_qsl(url.query, keep_blank_values=True)
        if (not value.startswith(("postgres://", "postgresql://")) or not url.hostname
                or url.fragment or not url.path.strip("/") or any(c.isspace() for c in value)
                or "/" in unquote(url.hostname)
                or [v for k, v in query if k == "sslmode"] != ["verify-full"]
                or any(k in {"ssl-mode", "host", "hostaddr"} for k, _ in query)):
            raise ValueError()
        _ = url.port
    except (ValueError, UnicodeError):
        raise ValueError("Database URL must name a PostgreSQL host/database, use exactly one sslmode=verify-full, "
                         "and contain no host overrides, fragments or whitespace") from None


def read_private_file(name):
    path = Path(os.environ[name])
    if path.is_symlink() or not path.is_file() or stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError(f"{name} must be a regular non-symlink file readable only by its owner (chmod 600)")
    return path.read_text().strip()


def main():
    config = settings()
    # Validate every input before writes. Secret values never enter argv, state or logs.
    payloads = {}
    for variable, suffix in (("DATABASE_URL_FILE", "database-url"),
                             ("MIGRATION_DATABASE_URL_FILE", "migration-database-url")):
        payloads[suffix] = read_private_file(variable)
        validate_url(payloads[suffix])
    if os.environ.get("DATABASE_CA_FILE"):
        payloads["database-ca"] = read_private_file("DATABASE_CA_FILE")
        if "-----BEGIN CERTIFICATE-----" not in payloads["database-ca"]:
            raise ValueError("DATABASE_CA_FILE must contain a PEM certificate")
    for suffix, value in payloads.items():
        result = subprocess.run(["gcloud", "secrets", "versions", "add", f"{config['name']}-{suffix}",
            f"--project={config['project']}", "--data-file=-", "--format=value(name)", "--quiet"],
            input=value, text=True, check=True, stdout=subprocess.PIPE)
        print(f"{suffix}: created secret version {result.stdout.strip().rsplit('/', 1)[-1]}")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Database secret import failed: {error}", file=sys.stderr)
        sys.exit(1)
