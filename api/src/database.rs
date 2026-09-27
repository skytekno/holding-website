use std::{future::Future, time::Duration};

use anyhow::{Context, Result, anyhow, ensure};
use sqlx::{
    PgPool,
    postgres::{PgConnectOptions, PgPoolOptions, PgSslMode},
};
use tokio::time::{Instant, sleep, timeout_at};
use url::Url;

use crate::config::validate_app_env;

const STARTUP_CONNECTION_BUDGET: Duration = Duration::from_secs(180);
const POOL_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);

/// Both the service and migration job use this bounded startup path. The pool's
/// acquisition timeout remains short after startup, including for API requests.
pub async fn connect_database(
    database_url: &str,
    max_connections: u32,
    app_env: &str,
) -> Result<PgPool> {
    let options = connection_options(database_url, app_env)?;
    retry_connection(STARTUP_CONNECTION_BUDGET, || {
        PgPoolOptions::new()
            .max_connections(max_connections)
            .acquire_timeout(POOL_ACQUIRE_TIMEOUT)
            .connect_with(options.clone())
    })
    .await
    .context("Database startup connection failed after the 180-second retry window")
}

fn connection_options(database_url: &str, app_env: &str) -> Result<PgConnectOptions> {
    validate_app_env(app_env)?;
    // Parse once so malformed configuration does not consume the retry window.
    ensure!(
        database_url.starts_with("postgres://") || database_url.starts_with("postgresql://"),
        "DATABASE_URL must use PostgreSQL"
    );
    if app_env == "production" {
        let url = Url::parse(database_url).map_err(|_| anyhow!("Invalid DATABASE_URL"))?;
        ensure!(
            url.host_str().is_some_and(|host| !host.is_empty()) && url.fragment().is_none(),
            "Production DATABASE_URL requires a TCP hostname and must not contain a fragment"
        );
        let mut ssl_modes = 0;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "sslmode" => {
                    ensure!(
                        value == "verify-full",
                        "Production DATABASE_URL requires sslmode=verify-full"
                    );
                    ssl_modes += 1;
                }
                "ssl-mode" => anyhow::bail!("Use the canonical sslmode parameter in production"),
                "host" | "hostaddr" => anyhow::bail!(
                    "Production DATABASE_URL must specify its host only in the URL authority"
                ),
                _ => {}
            }
        }
        ensure!(
            ssl_modes == 1,
            "Production DATABASE_URL requires exactly one sslmode=verify-full parameter"
        );
    }
    // Do not include connection strings or parameter values in parse errors.
    let options: PgConnectOptions = database_url
        .parse()
        .map_err(|_| anyhow!("Invalid DATABASE_URL"))?;
    if app_env == "production" {
        validate_production_options(&options)?;
    }
    Ok(options)
}

fn validate_production_options(options: &PgConnectOptions) -> Result<()> {
    ensure!(
        options.get_socket().is_none(),
        "Production PostgreSQL connections must use TCP, not Unix sockets"
    );
    ensure!(
        matches!(options.get_ssl_mode(), PgSslMode::VerifyFull),
        "Production PostgreSQL connections require verified TLS"
    );
    Ok(())
}

async fn retry_connection<T, F, Fut>(budget: Duration, mut connect: F) -> Result<T, sqlx::Error>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, sqlx::Error>>,
{
    let started = Instant::now();
    let deadline = started + budget;
    let mut attempts = 0;
    let mut delay = Duration::from_secs(1);
    let mut last_error = None;
    loop {
        if Instant::now() >= deadline {
            break;
        }
        attempts += 1;
        match timeout_at(deadline, connect()).await {
            Ok(Ok(pool)) => {
                tracing::info!(
                    attempts,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "Database startup connection established"
                );
                return Ok(pool);
            }
            Ok(Err(error)) => {
                let retry_in = delay.min(deadline.saturating_duration_since(Instant::now()));
                // Intentionally log categories, never the DSN or driver message.
                tracing::warn!(
                    attempts,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    retry_in_ms = retry_in.as_millis() as u64,
                    error_kind = error_kind(&error),
                    "Database not ready; retrying startup connection"
                );
                last_error = Some(error);
                sleep(retry_in).await;
                delay = (delay * 2).min(Duration::from_secs(10));
            }
            Err(_) => break,
        }
    }
    tracing::error!(
        attempts,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "Database startup connection deadline exceeded"
    );
    Err(last_error.unwrap_or(sqlx::Error::PoolTimedOut))
}

fn error_kind(error: &sqlx::Error) -> &'static str {
    match error {
        sqlx::Error::Io(_) => "network",
        sqlx::Error::Tls(_) => "tls",
        sqlx::Error::Database(_) => "database",
        sqlx::Error::PoolTimedOut => "connection_timeout",
        sqlx::Error::Configuration(_) => "configuration",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[tokio::test(start_paused = true)]
    async fn transient_failures_recover_with_backoff() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let started = Instant::now();
        let result = retry_connection(Duration::from_secs(20), || {
            let attempt = attempts.fetch_add(1, Ordering::SeqCst);
            async move {
                if attempt < 2 {
                    Err(sqlx::Error::PoolTimedOut)
                } else {
                    Ok("connected")
                }
            }
        })
        .await;
        assert_eq!(result.unwrap(), "connected");
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert_eq!(started.elapsed(), Duration::from_secs(3));
    }

    #[tokio::test(start_paused = true)]
    async fn exhausted_retries_stop_at_deadline_without_extra_attempt() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let started = Instant::now();
        let result = retry_connection(Duration::from_millis(2500), || {
            attempts.fetch_add(1, Ordering::SeqCst);
            async { Err::<(), _>(sqlx::Error::PoolTimedOut) }
        })
        .await;
        assert!(matches!(result, Err(sqlx::Error::PoolTimedOut)));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(started.elapsed(), Duration::from_millis(2500));
    }

    #[tokio::test(start_paused = true)]
    async fn deadline_also_bounds_an_in_progress_connection_attempt() {
        let started = Instant::now();
        let result = retry_connection(Duration::from_secs(2), || async {
            std::future::pending::<Result<(), sqlx::Error>>().await
        })
        .await;
        assert!(matches!(result, Err(sqlx::Error::PoolTimedOut)));
        assert_eq!(started.elapsed(), Duration::from_secs(2));
    }

    #[tokio::test(start_paused = true)]
    async fn invalid_connection_string_does_not_retry() {
        let started = Instant::now();
        assert!(
            connect_database("invalid://database", 1, "development")
                .await
                .is_err()
        );
        assert_eq!(started.elapsed(), Duration::ZERO);
    }

    #[test]
    fn production_accepts_verified_external_database_and_ca_parameters() {
        for url in [
            "postgresql://app@db.example.com/cms?sslmode=verify-full",
            "postgres://app@db.example.com:6432/cms?sslmode=verify-full&sslrootcert=%2Fvar%2Frun%2Fsecrets%2Fpostgres%2Fca.pem&statement-cache-capacity=0",
        ] {
            let options = connection_options(url, "production").unwrap();
            assert!(matches!(options.get_ssl_mode(), PgSslMode::VerifyFull));
            assert_eq!(options.get_host(), "db.example.com");
            assert!(options.get_socket().is_none());
        }
    }

    #[test]
    fn production_rejects_unverified_tls_and_ambiguous_endpoints() {
        for url in [
            "postgres://db.example.com/cms",
            "postgres://db.example.com/cms?sslmode=disable",
            "postgres://db.example.com/cms?sslmode=allow",
            "postgres://db.example.com/cms?sslmode=prefer",
            "postgres://db.example.com/cms?sslmode=require",
            "postgres://db.example.com/cms?sslmode=verify-ca",
            "postgres://db.example.com/cms?ssl-mode=verify-full",
            "postgres://db.example.com/cms?sslmode=verify-full&ssl-mode=disable",
            "postgres://db.example.com/cms?sslmode=verify-full&sslmode=verify-full",
            "postgres://db.example.com/cms?sslmode=verify-full&host=other.example.com",
            "postgres://db.example.com/cms?sslmode=verify-full&hostaddr=127.0.0.1",
            "postgres://db.example.com/cms?sslmode=verify-full#ignored",
            "postgres:///cms?sslmode=verify-full",
        ] {
            assert!(connection_options(url, "production").is_err(), "{url}");
        }
    }

    #[test]
    fn production_rejects_socket_bypasses_including_ambient_options() {
        for url in [
            "postgres://%2Fvar%2Frun%2Fpostgresql/cms?sslmode=verify-full",
            "postgres://db.example.com/cms?sslmode=verify-full&host=%2Fvar%2Frun%2Fpostgresql",
        ] {
            assert!(connection_options(url, "production").is_err(), "{url}");
        }
        let options = PgConnectOptions::new_without_pgpass()
            .host("db.example.com")
            .socket("/var/run/postgresql")
            .ssl_mode(PgSslMode::VerifyFull);
        assert!(validate_production_options(&options).is_err());
    }

    #[test]
    fn development_remains_usable_and_unknown_environments_fail_closed() {
        assert!(
            connection_options("postgres://localhost/cms?sslmode=disable", "development").is_ok()
        );
        assert!(connection_options("postgres://localhost/cms?host=/tmp", "development").is_ok());
        assert!(connection_options("postgres://localhost/cms", "staging").is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn production_policy_failure_does_not_attempt_a_connection_or_retry() {
        let started = Instant::now();
        assert!(
            connect_database(
                "postgres://db.example.com/cms?sslmode=require",
                1,
                "production"
            )
            .await
            .is_err()
        );
        assert_eq!(started.elapsed(), Duration::ZERO);
    }
}
