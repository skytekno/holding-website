use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{AppState, error::ApiError};

#[derive(Serialize, sqlx::FromRow)]
pub struct Page {
    pub id: Uuid,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub body: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub published_at: Option<DateTime<Utc>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageInput {
    pub slug: String,
    pub title: String,
    pub description: String,
    pub body: String,
    pub status: String,
}
impl PageInput {
    fn validate(&self) -> Result<(), ApiError> {
        if !valid_slug(&self.slug) {
            return Err(ApiError::bad_request(
                "Slug must be 1-120 lowercase letters, digits or single hyphens and cannot use a reserved route",
            ));
        }
        if self.title.trim().is_empty() || self.title.chars().count() > 200 {
            return Err(ApiError::bad_request("Title must contain 1-200 characters"));
        }
        if self.description.chars().count() > 320 {
            return Err(ApiError::bad_request(
                "Description must contain at most 320 characters",
            ));
        }
        if self.body.len() > 200000 {
            return Err(ApiError::bad_request(
                "Body must contain at most 200000 bytes",
            ));
        }
        if !matches!(self.status.as_str(), "draft" | "published") {
            return Err(ApiError::bad_request("Status must be draft or published"));
        }
        Ok(())
    }
}
fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 120
        && !matches!(slug, "health" | "api" | "assets" | "v1")
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && !slug.contains("--")
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
pub async fn public_list(State(state): State<AppState>) -> Result<Json<Vec<Page>>, ApiError> {
    Ok(Json(
        sqlx::query_as::<_, Page>("SELECT * FROM pages WHERE status = 'published' ORDER BY slug")
            .fetch_all(&state.pool)
            .await?,
    ))
}
pub async fn public_get(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Json<Page>, ApiError> {
    Ok(Json(
        sqlx::query_as::<_, Page>("SELECT * FROM pages WHERE slug = $1 AND status = 'published'")
            .bind(slug)
            .fetch_one(&state.pool)
            .await?,
    ))
}
pub async fn admin_list(State(state): State<AppState>) -> Result<Json<Vec<Page>>, ApiError> {
    Ok(Json(
        sqlx::query_as::<_, Page>("SELECT * FROM pages ORDER BY updated_at DESC")
            .fetch_all(&state.pool)
            .await?,
    ))
}
pub async fn create(
    State(state): State<AppState>,
    Json(input): Json<PageInput>,
) -> Result<(StatusCode, Json<Page>), ApiError> {
    input.validate()?;
    let page = sqlx::query_as::<_, Page>("INSERT INTO pages (id, slug, title, description, body, status, published_at) VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $6='published' THEN now() ELSE NULL END) RETURNING *")
        .bind(Uuid::new_v4()).bind(input.slug).bind(input.title.trim()).bind(input.description).bind(input.body).bind(input.status).fetch_one(&state.pool).await?;
    Ok((StatusCode::CREATED, Json(page)))
}
pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<PageInput>,
) -> Result<Json<Page>, ApiError> {
    input.validate()?;
    Ok(Json(sqlx::query_as::<_, Page>("UPDATE pages SET slug=$2, title=$3, description=$4, body=$5, status=$6, updated_at=now(), published_at=CASE WHEN $6='published' THEN COALESCE(published_at,now()) ELSE NULL END WHERE id=$1 RETURNING *")
        .bind(id).bind(input.slug).bind(input.title.trim()).bind(input.description).bind(input.body).bind(input.status).fetch_one(&state.pool).await?))
}
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let deleted = sqlx::query("DELETE FROM pages WHERE id=$1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "Not found"));
    }
    Ok(StatusCode::NO_CONTENT)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slugs_are_canonical_and_reachable() {
        for slug in ["home", "about-us", "2026"] {
            assert!(valid_slug(slug));
        }
        for slug in [
            "",
            "About",
            "../secret",
            "two--hyphens",
            "-start",
            "end-",
            "health",
            "api",
            "robots.txt",
            "_next",
        ] {
            assert!(!valid_slug(slug), "{slug}");
        }
    }
    #[test]
    fn content_limits_and_status_enforced() {
        let mut input = PageInput {
            slug: "about".into(),
            title: "About".into(),
            description: String::new(),
            body: String::new(),
            status: "draft".into(),
        };
        assert!(input.validate().is_ok());
        input.status = "archived".into();
        assert!(input.validate().is_err());
        input.status = "published".into();
        input.title = " ".into();
        assert!(input.validate().is_err());
        input.title = "About".into();
        input.body = "a".repeat(200001);
        assert!(input.validate().is_err());
    }
}
