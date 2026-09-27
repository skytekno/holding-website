use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sky_holding_api::{AppState, config::Config, migrate, router};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;
use uuid::Uuid;

const TOKEN: &str = "integration-development-token-at-least-32-chars";
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    authenticated: bool,
) -> axum::response::Response {
    let mut req = Request::builder().method(method).uri(path);
    if authenticated {
        req = req.header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
    }
    if body.is_some() {
        req = req.header(header::CONTENT_TYPE, "application/json");
    }
    app.clone()
        .oneshot(
            req.body(body.map_or_else(Body::empty, |v| Body::from(v.to_string())))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn json_body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL pointing to a disposable PostgreSQL instance"]
async fn cms_contract_database_auth_cors_and_uploads() {
    let database_url = std::env::var("TEST_DATABASE_URL")
        .expect("TEST_DATABASE_URL required for integration test");
    let schema = format!("cms_test_{}", Uuid::new_v4().simple());
    let admin_pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .unwrap();
    // The identifier consists only of our fixed prefix and a generated UUID in hex.
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(&admin_pool)
        .await
        .unwrap();
    let set_path = Arc::new(format!("SET search_path TO {schema}"));
    let pool = PgPoolOptions::new()
        .max_connections(3)
        .after_connect(move |conn, _| {
            let set_path = set_path.clone();
            Box::pin(async move {
                sqlx::query(sqlx::AssertSqlSafe(set_path.as_ref().as_str()))
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
        .connect(&database_url)
        .await
        .unwrap();
    migrate(&pool).await.unwrap();
    let assets = tempfile::tempdir().unwrap();
    let config = Config::from_lookup(|key| match key {
        "APP_ENV" => Some("development".into()),
        "DATABASE_URL" => Some(database_url.clone()),
        "DEV_AUTH_TOKEN" => Some(TOKEN.into()),
        "CORS_ORIGINS" => Some("http://localhost:3001".into()),
        "STORAGE_BACKEND" => Some("local".into()),
        "LOCAL_ASSET_PATH" => Some(assets.path().display().to_string()),
        "ASSETS_BASE_URL" => Some("http://localhost:8080/assets".into()),
        _ => None,
    })
    .unwrap();
    let app = router(AppState::new(config, pool.clone()).unwrap());

    assert_eq!(
        request(&app, "GET", "/health/ready", None, false)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "GET", "/v1/admin/pages", None, false)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&app, "GET", "/v1/admin/assets", None, false)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let home = request(&app, "GET", "/v1/pages/home", None, false).await;
    assert_eq!(home.status(), StatusCode::OK);
    assert_eq!(home.headers()[header::CACHE_CONTROL], "private, no-store");
    assert_eq!(json_body(home).await["title"], "Sky Holding");

    let mut page = json!({"slug":"test-page","title":"Test page","description":"Description","body":"# Hello\n<script>alert(1)</script>","status":"draft"});
    let created = request(&app, "POST", "/v1/admin/pages", Some(page.clone()), true).await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created = json_body(created).await;
    assert!(created["published_at"].is_null());
    let id = created["id"].as_str().unwrap();
    assert_eq!(
        request(&app, "GET", "/v1/pages/test-page", None, false)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        json_body(request(&app, "GET", "/v1/pages", None, false).await)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        request(&app, "POST", "/v1/admin/pages", Some(page.clone()), true)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    page["status"] = json!("published");
    let published = request(
        &app,
        "PUT",
        &format!("/v1/admin/pages/{id}"),
        Some(page.clone()),
        true,
    )
    .await;
    assert_eq!(published.status(), StatusCode::OK);
    assert!(json_body(published).await["published_at"].is_string());
    assert_eq!(
        json_body(request(&app, "GET", "/v1/pages/test-page", None, false).await).await["body"],
        page["body"]
    );
    page["status"] = json!("draft");
    assert_eq!(
        request(
            &app,
            "PUT",
            &format!("/v1/admin/pages/{id}"),
            Some(page),
            true
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "GET", "/v1/pages/test-page", None, false)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, "DELETE", &format!("/v1/admin/pages/{id}"), None, true)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&app, "DELETE", &format!("/v1/admin/pages/{id}"), None, true)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let invalid =
        json!({"slug":"health","title":"Title","description":"","body":"","status":"draft"});
    assert_eq!(
        request(&app, "POST", "/v1/admin/pages", Some(invalid), true)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );

    for (origin, allowed) in [
        ("http://localhost:3001", true),
        ("https://attacker.test", false),
    ] {
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/v1/admin/pages")
                    .header(header::ORIGIN, origin)
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                    .header(
                        header::ACCESS_CONTROL_REQUEST_HEADERS,
                        "authorization,content-type",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            res.headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            allowed
        );
    }
    let mut payload = b"--test-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"../../picture.html\"\r\nContent-Type: text/html\r\n\r\n".to_vec();
    payload.extend_from_slice(b"\x89PNG\r\n\x1a\nexample");
    payload.extend_from_slice(b"\r\n--test-boundary--\r\n");
    let uploaded = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/assets")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(
                    header::CONTENT_TYPE,
                    "multipart/form-data; boundary=test-boundary",
                )
                .body(Body::from(payload))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(uploaded.status(), StatusCode::CREATED);
    let uploaded = json_body(uploaded).await;
    assert_eq!(uploaded["content_type"], "image/png");
    assert_eq!(uploaded["filename"], "picture.html");
    let asset_url = url::Url::parse(uploaded["url"].as_str().unwrap()).unwrap();
    let file = request(&app, "GET", asset_url.path(), None, false).await;
    assert_eq!(file.status(), StatusCode::OK);
    assert_eq!(file.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(
        file.headers()[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(
        json_body(request(&app, "GET", "/v1/admin/assets", None, true).await)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let invalid = "--bad\r\nContent-Disposition: form-data; name=\"file\"; filename=\"attack.svg\"\r\n\r\n<svg><script>alert(1)</script></svg>\r\n--bad--\r\n";
    let rejected = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/assets")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::CONTENT_TYPE, "multipart/form-data; boundary=bad")
                .body(Body::from(invalid))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);

    let mut oversized = b"--large\r\nContent-Disposition: form-data; name=\"file\"; filename=\"large.png\"\r\n\r\n\x89PNG\r\n\x1a\n".to_vec();
    oversized.resize(
        oversized.len() + sky_holding_api::assets::MAX_ASSET_BYTES,
        b'a',
    );
    oversized.extend_from_slice(b"\r\n--large--\r\n");
    let rejected = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/assets")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::CONTENT_TYPE, "multipart/form-data; boundary=large")
                .body(Body::from(oversized))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::PAYLOAD_TOO_LARGE);

    pool.close().await;
    sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE")))
        .execute(&admin_pool)
        .await
        .unwrap();
    admin_pool.close().await;
}
