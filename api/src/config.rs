use std::{collections::HashSet, path::PathBuf};

use anyhow::{Context, Result, bail};
use axum::http::HeaderValue;
use url::Url;

pub fn validate_app_env(app_env: &str) -> Result<()> {
    if !matches!(app_env, "development" | "production") {
        bail!("APP_ENV must be development or production");
    }
    Ok(())
}

#[derive(Clone)]
pub struct Config {
    pub app_env: String,
    pub port: u16,
    pub database_url: String,
    pub database_max_connections: u32,
    pub cors_origins: Vec<HeaderValue>,
    pub google_client_id: Option<String>,
    pub admin_emails: HashSet<String>,
    pub dev_auth_token: Option<String>,
    pub storage_backend: String,
    pub local_asset_path: PathBuf,
    pub assets_base_url: String,
    pub gcs_bucket: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let value = |name: &str, default: &str| get(name).unwrap_or_else(|| default.to_owned());
        let app_env = value("APP_ENV", "production");
        validate_app_env(&app_env)?;
        let production = app_env == "production";
        let database_url = get("DATABASE_URL").context("DATABASE_URL is required")?;
        if !(database_url.starts_with("postgres://") || database_url.starts_with("postgresql://")) {
            bail!("DATABASE_URL must use PostgreSQL");
        }
        let port = value("PORT", "8080")
            .parse::<u16>()
            .context("PORT must be a valid TCP port")?;
        if port == 0 {
            bail!("PORT must not be zero");
        }
        let database_max_connections = value("DATABASE_MAX_CONNECTIONS", "5")
            .parse::<u32>()
            .context("DATABASE_MAX_CONNECTIONS must be an integer")?;
        if !(1..=100).contains(&database_max_connections) {
            bail!("DATABASE_MAX_CONNECTIONS must be between 1 and 100");
        }
        let cors = get("CORS_ORIGINS").context("CORS_ORIGINS is required")?;
        let mut cors_origins = Vec::new();
        for origin in cors.split(',').map(str::trim).filter(|v| !v.is_empty()) {
            let parsed = Url::parse(origin).context("CORS_ORIGINS contains an invalid URL")?;
            if parsed.origin().ascii_serialization() != origin
                || (!matches!(parsed.scheme(), "http" | "https"))
                || (production && parsed.scheme() != "https")
            {
                bail!(
                    "CORS_ORIGINS must contain exact origins (HTTPS in production), without paths or trailing slashes"
                );
            }
            cors_origins.push(origin.parse().context("Invalid CORS origin header")?);
        }
        if cors_origins.is_empty() {
            bail!("CORS_ORIGINS must not be empty");
        }
        let google_client_id = get("GOOGLE_CLIENT_ID").filter(|v| !v.trim().is_empty());
        let admin_emails: HashSet<String> = value("ADMIN_EMAILS", "")
            .split(',')
            .map(|v| v.trim().to_lowercase())
            .filter(|v| !v.is_empty())
            .collect();
        if admin_emails
            .iter()
            .any(|email| !email.contains('@') || email.contains(char::is_whitespace))
        {
            bail!("ADMIN_EMAILS contains an invalid email");
        }
        let dev_auth_token = get("DEV_AUTH_TOKEN").filter(|v| !v.is_empty());
        if production && dev_auth_token.is_some() {
            bail!("DEV_AUTH_TOKEN is forbidden in production");
        }
        if dev_auth_token.as_ref().is_some_and(|v| v.len() < 32) {
            bail!("DEV_AUTH_TOKEN must contain at least 32 characters");
        }
        if (production || dev_auth_token.is_none())
            && (google_client_id.is_none() || admin_emails.is_empty())
        {
            bail!(
                "GOOGLE_CLIENT_ID and ADMIN_EMAILS are required when development auth is disabled"
            );
        }
        let storage_backend = value("STORAGE_BACKEND", "gcs");
        if !matches!(storage_backend.as_str(), "local" | "gcs") {
            bail!("STORAGE_BACKEND must be local or gcs");
        }
        if production && storage_backend != "gcs" {
            bail!("Production requires durable GCS storage");
        }
        let gcs_bucket = get("GCS_BUCKET").filter(|v| !v.is_empty());
        if storage_backend == "gcs" && gcs_bucket.is_none() {
            bail!("GCS_BUCKET is required for GCS storage");
        }
        if gcs_bucket.as_ref().is_some_and(|v| {
            !v.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b))
        }) {
            bail!("Invalid GCS_BUCKET name");
        }
        let assets_base_url = get("ASSETS_BASE_URL")
            .context("ASSETS_BASE_URL is required")?
            .trim_end_matches('/')
            .to_owned();
        let assets_url = Url::parse(&assets_base_url).context("ASSETS_BASE_URL must be a URL")?;
        if !matches!(assets_url.scheme(), "http" | "https")
            || (production && assets_url.scheme() != "https")
            || assets_url.query().is_some()
            || assets_url.fragment().is_some()
            || !assets_url.username().is_empty()
            || assets_url.password().is_some()
        {
            bail!(
                "ASSETS_BASE_URL must be a public HTTP URL (HTTPS in production), without credentials, query or fragment"
            );
        }
        Ok(Self {
            app_env,
            port,
            database_url,
            database_max_connections,
            cors_origins,
            google_client_id,
            admin_emails,
            dev_auth_token,
            storage_backend,
            local_asset_path: value("LOCAL_ASSET_PATH", "./var/assets").into(),
            assets_base_url,
            gcs_bucket,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(overrides: &[(&str, &str)]) -> Result<Config> {
        let mut env = std::collections::HashMap::from([
            ("APP_ENV", "development"),
            ("DATABASE_URL", "postgres://localhost/cms"),
            ("CORS_ORIGINS", "http://localhost:3001"),
            ("DEV_AUTH_TOKEN", "development-token-at-least-32-chars"),
            ("STORAGE_BACKEND", "local"),
            ("ASSETS_BASE_URL", "http://localhost:8080/assets"),
        ]);
        env.extend(overrides.iter().copied());
        Config::from_lookup(|name| env.get(name).map(|v| (*v).to_owned()))
    }
    #[test]
    fn development_is_explicit() {
        assert!(config(&[]).is_ok());
        assert!(config(&[("APP_ENV", "staging")]).is_err());
    }
    #[test]
    fn production_rejects_dev_tokens() {
        assert!(
            config(&[
                ("APP_ENV", "production"),
                ("CORS_ORIGINS", "https://cms.skyhold.ing")
            ])
            .is_err()
        );
    }
    #[test]
    fn exact_origins_only() {
        for origin in [
            "*",
            "https://cms.skyhold.ing/",
            "https://cms.skyhold.ing/path",
            "https://evil.test@cms.skyhold.ing",
        ] {
            assert!(config(&[("CORS_ORIGINS", origin)]).is_err(), "{origin}");
        }
    }
    #[test]
    fn rejects_short_tokens_and_unknown_storage() {
        assert!(config(&[("DEV_AUTH_TOKEN", "short")]).is_err());
        assert!(config(&[("STORAGE_BACKEND", "memory")]).is_err());
    }
}
