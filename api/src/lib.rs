pub mod assets;
pub mod auth;
pub mod config;
pub mod database;
pub mod error;
pub mod pages;

use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::Response,
    routing::{get, put},
};
use serde_json::json;
use sqlx::PgPool;
use tower_http::{cors::CorsLayer, services::ServeDir, trace::TraceLayer};

use assets::Storage;
use auth::Auth;
use config::Config;
use error::ApiError;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub auth: Auth,
    pub storage: Storage,
}
impl AppState {
    pub fn new(config: Config, pool: PgPool) -> anyhow::Result<Self> {
        let config = Arc::new(config);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            pool,
            auth: Auth::new(config.clone(), client.clone()),
            storage: Storage::new(config.clone(), client),
            config,
        })
    }
}
pub async fn migrate(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}
pub fn router(state: AppState) -> Router {
    let admin = Router::new()
        .route("/pages", get(pages::admin_list).post(pages::create))
        .route("/pages/{id}", put(pages::update).delete(pages::delete))
        .route(
            "/assets",
            get(assets::list)
                .post(assets::upload)
                .layer(DefaultBodyLimit::max(assets::MAX_ASSET_BYTES + 65536)),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_admin,
        ));
    let cors = CorsLayer::new()
        .allow_origin(state.config.cors_origins.clone())
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .max_age(Duration::from_secs(3600));
    let mut app = Router::new()
        .route(
            "/health/live",
            get(|| async { Json(json!({ "status": "ok" })) }),
        )
        .route("/health/ready", get(ready))
        .route("/v1/pages", get(pages::public_list))
        .route("/v1/pages/{slug}", get(pages::public_get))
        .nest("/v1/admin", admin)
        .fallback(|| async { ApiError(StatusCode::NOT_FOUND, "Not found") });
    if state.config.storage_backend == "local" {
        app = app.nest_service(
            "/assets",
            ServeDir::new(&state.config.local_asset_path).append_index_html_on_directories(false),
        );
    }
    app.layer(DefaultBodyLimit::max(256 * 1024))
        .layer(cors)
        .layer(middleware::from_fn(response_headers))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
async fn ready(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    match sqlx::query_scalar::<_, i64>("SELECT count(*) FROM pages WHERE slug = 'home'")
        .fetch_one(&state.pool)
        .await
    {
        Ok(_) => Ok(Json(json!({ "status": "ready" }))),
        Err(error) => {
            tracing::warn!(error = %error, "Database readiness failed");
            Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "Not ready"))
        }
    }
}
async fn response_headers(request: Request, next: Next) -> Response {
    let asset = request.uri().path().starts_with("/assets/");
    let mut response = next.run(request).await;
    let cacheable_asset = asset && response.status().is_success();
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if cacheable_asset {
            "public, max-age=31536000, immutable"
        } else {
            "private, no-store"
        }),
    );
    if asset
        && response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|v| v == "application/pdf")
    {
        response.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment"),
        );
    }
    response
}
