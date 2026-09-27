#!/usr/bin/env python3
"""Exercise a running local stack with real PostgreSQL, API and Next.js responses."""
import base64
import json
import os
import urllib.error
import urllib.request
import uuid

API = os.environ.get("TEST_API_URL", "http://localhost:8080").rstrip("/")
WEB = os.environ.get("TEST_WEB_URL", "http://localhost:3000").rstrip("/")
CMS = os.environ.get("TEST_CMS_URL", "http://localhost:3001").rstrip("/")
TOKEN = os.environ.get("DEV_AUTH_TOKEN", "sky-holding-local-development-token-2026-only")


def request(url, method="GET", data=None, auth=False, headers=None):
    values = dict(headers or {})
    if auth:
        values["Authorization"] = f"Bearer {TOKEN}"
    if isinstance(data, dict):
        data = json.dumps(data).encode()
        values["Content-Type"] = "application/json"
    try:
        response = urllib.request.urlopen(
            urllib.request.Request(url, data=data, headers=values, method=method), timeout=30
        )
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read().decode()
        return response.status, response.headers, body


def expect(status, result, message):
    actual, _, body = result
    assert actual == status, f"{message}: expected {status}, got {actual}: {body[:300]}"
    return body


def main():
    for base, path in ((API, "/health/ready"), (WEB, "/health"), (CMS, "/health")):
        expect(200, request(base + path), "service health")
    expect(401, request(API + "/v1/admin/pages"), "anonymous CMS access")
    expect(401, request(API + "/v1/admin/pages", headers={"Authorization": "Bearer wrong"}), "invalid token")
    _, cors, _ = request(API + "/v1/pages", headers={"Origin": "https://untrusted.invalid"})
    assert "Access-Control-Allow-Origin" not in cors, "untrusted CORS origin accepted"
    _, cors, _ = request(API + "/v1/pages", headers={"Origin": CMS})
    assert cors.get("Access-Control-Allow-Origin") == CMS, "dashboard CORS origin missing"
    home = expect(200, request(WEB), "server-rendered home")
    assert "Sky Holding" in home and 'rel="canonical"' in home and 'application/ld+json' in home
    assert "user-agent: *" in expect(200, request(WEB + "/robots.txt"), "public robots").lower()
    cms = expect(200, request(CMS), "CMS shell")
    assert "noindex" in cms, "dashboard indexable"
    assert "Disallow: /" in expect(200, request(CMS + "/robots.txt"), "CMS robots")
    slug = "smoke-" + uuid.uuid4().hex[:12]
    page = {"slug": slug, "title": "Smoke Test Article", "description": "A temporary integration test page.",
            "body": "## Integration works\n\nAPI-owned content renders as HTML.\n\n<script>alert('unsafe')</script>", "status": "draft"}
    result = request(API + "/v1/admin/pages", "POST", page, True)
    created = json.loads(expect(201, result, "create draft"))
    page_id = created["id"]
    try:
        expect(404, request(API + "/v1/pages/" + slug), "draft API visibility")
        expect(404, request(WEB + "/" + slug), "draft web visibility")
        assert slug not in expect(200, request(WEB + "/sitemap.xml"), "draft sitemap")
        page["status"] = "published"
        expect(200, request(API + "/v1/admin/pages/" + page_id, "PUT", page, True), "publish")
        html = expect(200, request(WEB + "/" + slug), "published SSR page")
        assert "Integration works" in html and "API-owned content renders as HTML." in html
        assert "<script>alert('unsafe')</script>" not in html, "raw Markdown HTML executed"
        assert WEB + "/" + slug in html, "canonical not derived from runtime SITE_URL"
        assert slug in expect(200, request(WEB + "/sitemap.xml"), "published sitemap")
        assert slug in expect(200, request(WEB + "/llms.txt"), "published discovery index")
        page["status"] = "draft"
        expect(200, request(API + "/v1/admin/pages/" + page_id, "PUT", page, True), "unpublish")
        expect(404, request(WEB + "/" + slug), "unpublish freshness")
        assert slug not in expect(200, request(WEB + "/sitemap.xml"), "unpublish sitemap freshness")
    finally:
        expect(204, request(API + "/v1/admin/pages/" + page_id, "DELETE", auth=True), "cleanup page")
    # Uploads are immutable public assets. This one-pixel fixture remains in the local dev volume.
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
    boundary = "sky-smoke-" + uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"smoke.png\"\r\nContent-Type: image/png\r\n\r\n".encode()
            + png + f"\r\n--{boundary}--\r\n".encode())
    result = request(API + "/v1/admin/assets", "POST", body, True, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    asset = json.loads(expect(201, result, "asset upload"))
    assert asset["content_type"] == "image/png" and asset["size"] == len(png)
    with urllib.request.urlopen(asset["url"], timeout=10) as response:
        assert response.status == 200 and response.read() == png
    print("PASS: auth, CORS, draft/publish/unpublish, SSR, SEO, sitemap, crawler index, Markdown safety, assets")


if __name__ == "__main__":
    main()
