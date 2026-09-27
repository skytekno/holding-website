use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

pub struct ApiError(pub StatusCode, pub &'static str);
impl ApiError {
    pub fn bad_request(message: &'static str) -> Self {
        Self(StatusCode::BAD_REQUEST, message)
    }
    pub fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "Authentication required")
    }
    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(error = %error, "Request failed");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        if matches!(&error, sqlx::Error::RowNotFound) {
            return Self(StatusCode::NOT_FOUND, "Not found");
        }
        if let sqlx::Error::Database(db) = &error
            && db.is_unique_violation()
        {
            return Self(StatusCode::CONFLICT, "Slug already exists");
        }
        Self::internal(error)
    }
}
