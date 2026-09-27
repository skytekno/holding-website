use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::Response,
};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;

use crate::{AppState, config::Config, error::ApiError};

#[derive(Clone)]
pub struct Auth {
    config: Arc<Config>,
    client: reqwest::Client,
    keys: Arc<Mutex<Option<CachedKeys>>>,
}
struct CachedKeys {
    jwks: JwkSet,
    expires_at: Instant,
    fetched_at: Instant,
}
#[derive(Clone, Deserialize)]
struct Claims {
    sub: String,
    email: String,
    #[serde(default)]
    email_verified: bool,
    hd: Option<String>,
    azp: Option<String>,
}

impl Auth {
    pub fn new(config: Arc<Config>, client: reqwest::Client) -> Self {
        Self {
            config,
            client,
            keys: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn authorize(&self, token: &str) -> Result<(), ApiError> {
        if token.len() > 16384 {
            return Err(ApiError::unauthorized());
        }
        if self.config.app_env == "development"
            && let Some(expected) = &self.config.dev_auth_token
            && bool::from(
                Sha256::digest(token.as_bytes()).ct_eq(&Sha256::digest(expected.as_bytes())),
            )
        {
            return Ok(());
        }
        let header = decode_header(token).map_err(|_| ApiError::unauthorized())?;
        if header.alg != Algorithm::RS256 {
            return Err(ApiError::unauthorized());
        }
        let kid = header.kid.as_deref().ok_or_else(ApiError::unauthorized)?;
        let key = self.decoding_key(kid).await?;
        verify_google_token(token, &key, &self.config)
    }

    async fn decoding_key(&self, kid: &str) -> Result<DecodingKey, ApiError> {
        let mut cache = self.keys.lock().await;
        let refresh = match &*cache {
            None => true,
            Some(keys) => {
                Instant::now() >= keys.expires_at
                    || (keys.jwks.find(kid).is_none()
                        && keys.fetched_at.elapsed() >= Duration::from_secs(60))
            }
        };
        if refresh {
            let response = self
                .client
                .get("https://www.googleapis.com/oauth2/v3/certs")
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|error| {
                    tracing::warn!(error = %error, "Google signing key fetch failed");
                    ApiError(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Authentication temporarily unavailable",
                    )
                })?;
            let max_age = response
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok())
                .and_then(cache_max_age)
                .unwrap_or(300)
                .clamp(60, 86400);
            let jwks = response
                .json::<JwkSet>()
                .await
                .map_err(ApiError::internal)?;
            *cache = Some(CachedKeys {
                jwks,
                expires_at: Instant::now() + Duration::from_secs(max_age),
                fetched_at: Instant::now(),
            });
        }
        let key = cache
            .as_ref()
            .and_then(|keys| keys.jwks.find(kid))
            .ok_or_else(ApiError::unauthorized)?;
        DecodingKey::from_jwk(key).map_err(|_| ApiError::unauthorized())
    }
}

fn verify_google_token(token: &str, key: &DecodingKey, config: &Config) -> Result<(), ApiError> {
    let audience = config
        .google_client_id
        .as_ref()
        .ok_or_else(ApiError::unauthorized)?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[audience]);
    validation.set_issuer(&["accounts.google.com", "https://accounts.google.com"]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    validation.leeway = 0;
    let claims = decode::<Claims>(token, key, &validation)
        .map_err(|_| ApiError::unauthorized())?
        .claims;
    validate_identity(&claims, config)
}

fn cache_max_age(value: &str) -> Option<u64> {
    value
        .split(',')
        .map(str::trim)
        .find_map(|v| v.strip_prefix("max-age=").and_then(|n| n.parse().ok()))
}
fn validate_identity(claims: &Claims, config: &Config) -> Result<(), ApiError> {
    let email = claims.email.to_lowercase();
    let authoritative = email.ends_with("@gmail.com")
        || claims.hd.as_ref().is_some_and(|domain| !domain.is_empty());
    if !claims.email_verified
        || claims.sub.is_empty()
        || !authoritative
        || claims
            .azp
            .as_ref()
            .is_some_and(|azp| Some(azp) != config.google_client_id.as_ref())
    {
        return Err(ApiError::unauthorized());
    }
    if !config.admin_emails.contains(&email) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Administrator access required",
        ));
    }
    Ok(())
}

pub async fn require_admin(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or_else(ApiError::unauthorized)?;
    state.auth.authorize(token).await?;
    Ok(next.run(request).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config::from_lookup(|key| {
            match key {
                "APP_ENV" => Some("development"),
                "DATABASE_URL" => Some("postgres://localhost/test"),
                "GOOGLE_CLIENT_ID" => Some("test-client"),
                "ADMIN_EMAILS" => Some("admin@skyhold.ing,admin@gmail.com"),
                "CORS_ORIGINS" => Some("http://localhost:3001"),
                "STORAGE_BACKEND" => Some("local"),
                "ASSETS_BASE_URL" => Some("http://localhost:8080/assets"),
                _ => None,
            }
            .map(str::to_owned)
        })
        .unwrap()
    }
    #[test]
    fn identity_requires_google_authoritative_email_and_allowlist() {
        let config = config();
        let mut claims = Claims {
            sub: "123".into(),
            email: "admin@skyhold.ing".into(),
            email_verified: true,
            hd: None,
            azp: None,
        };
        assert!(validate_identity(&claims, &config).is_err());
        claims.hd = Some("skyhold.ing".into());
        assert!(validate_identity(&claims, &config).is_ok());
        claims.email = "attacker@skyhold.ing".into();
        assert_eq!(
            validate_identity(&claims, &config).err().unwrap().0,
            StatusCode::FORBIDDEN
        );
        claims.email = "admin@gmail.com".into();
        claims.hd = None;
        assert!(validate_identity(&claims, &config).is_ok());
        claims.email_verified = false;
        assert!(validate_identity(&claims, &config).is_err());
    }
    #[test]
    fn wrong_authorized_party_rejected() {
        let claims = Claims {
            sub: "123".into(),
            email: "admin@gmail.com".into(),
            email_verified: true,
            hd: None,
            azp: Some("other-client".into()),
        };
        assert!(validate_identity(&claims, &config()).is_err());
    }
    #[test]
    fn cache_control_parsed() {
        assert_eq!(
            cache_max_age("public, max-age=7200, must-revalidate"),
            Some(7200)
        );
    }

    #[test]
    fn signed_google_claims_reject_wrong_audience_issuer_expiry_and_signature() {
        use jsonwebtoken::{EncodingKey, Header, encode};
        use serde_json::json;
        let config = config();
        let private =
            EncodingKey::from_rsa_der(include_bytes!("../tests/fixtures/test-rsa-private.der"));
        let public =
            DecodingKey::from_rsa_der(include_bytes!("../tests/fixtures/test-rsa-public.der"));
        let claims = json!({"sub":"123", "email":"admin@gmail.com", "email_verified":true, "iss":"https://accounts.google.com", "aud":"test-client", "exp":jsonwebtoken::get_current_timestamp()+600});
        let token = encode(&Header::new(Algorithm::RS256), &claims, &private).unwrap();
        assert!(verify_google_token(&token, &public, &config).is_ok());
        for (name, value) in [
            ("aud", json!("attacker-client")),
            ("iss", json!("https://attacker.test")),
            ("exp", json!(1)),
        ] {
            let mut invalid = claims.clone();
            invalid[name] = value;
            let token = encode(&Header::new(Algorithm::RS256), &invalid, &private).unwrap();
            assert!(
                verify_google_token(&token, &public, &config).is_err(),
                "{name}"
            );
        }
        let forged = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(b"attacker"),
        )
        .unwrap();
        assert!(verify_google_token(&forged, &public, &config).is_err());
        let mut tampered = token.into_bytes();
        let at = tampered.len() - 20;
        tampered[at] = if tampered[at] == b'A' { b'B' } else { b'A' };
        assert!(
            verify_google_token(std::str::from_utf8(&tampered).unwrap(), &public, &config).is_err()
        );
    }
}
