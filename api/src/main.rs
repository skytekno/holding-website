use anyhow::{Context, Result, bail};
use sky_holding_api::{AppState, config::Config, database::connect_database, migrate, router};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "sky_holding_api=info,tower_http=info".into()),
        )
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() && args != ["--migrate"] {
        bail!("Usage: sky-holding-api [--migrate]");
    }
    if args == ["--migrate"] {
        let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is required")?;
        let app_env = std::env::var("APP_ENV").unwrap_or_else(|_| "production".to_owned());
        let pool = connect_database(&database_url, 1, &app_env).await?;
        migrate(&pool).await?;
        tracing::info!("Database migrations complete");
        pool.close().await;
        return Ok(());
    }
    let config = Config::from_env()?;
    let pool = connect_database(
        &config.database_url,
        config.database_max_connections,
        &config.app_env,
    )
    .await?;
    if config.app_env == "development" {
        migrate(&pool).await?;
    }
    let port = config.port;
    let state = AppState::new(config, pool.clone())?;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!(port, "Sky Holding API listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown())
        .await?;
    pool.close().await;
    Ok(())
}
async fn shutdown() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Unable to install Ctrl-C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Unable to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
    tracing::info!("Shutdown signal received");
}
