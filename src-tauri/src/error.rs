//! Error type shared by every command. Serializes as `{ code, message }`.

use aws_sdk_s3::config::http::HttpResponse;
use aws_sdk_s3::error::{DisplayErrorContext, ProvideErrorMetadata, SdkError};
use serde::{Deserialize, Serialize};

/// Error codes, serialized verbatim (PascalCase) to match `ErrorCode` in `src/lib/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum ErrorCode {
    NotConnected,
    Auth,
    NoSuchBucket,
    NoSuchKey,
    AccessDenied,
    Network,
    Io,
    Cancelled,
    InvalidInput,
    /// The OS keychain is unavailable or refused access (saved-connection secrets).
    Keychain,
    /// The server-side state changed since the UI read it (tags, lifecycle); nothing was written.
    Conflict,
    /// The server does not implement this S3 feature (MinIO, R2, SeaweedFS and others implement
    /// tagging and lifecycle only partly).
    NotSupported,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code:?}: {message}")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
}

pub type AppResult<T> = Result<T, AppError>;

/// Every refusal to read an archived (not restored) object, whatever the operation (download,
/// copy, move, rename, restore of an archived version). The UI uses the same words.
pub const ARCHIVED: &str = "InvalidObjectState: The object is archived; restore it first.";

/// Start of the message of [`AppError::saved_but_unread`]; the UI must reload, never say "nothing changed".
pub const SAVED_BUT_UNREAD: &str = "Saved, but reading back failed";

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn not_connected() -> Self {
        Self::new(ErrorCode::NotConnected, "Not connected to S3")
    }
    pub fn cancelled() -> Self {
        Self::new(ErrorCode::Cancelled, "Cancelled")
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }
    /// A write succeeded but reading the result back failed: not a failed save. Keeps the code.
    pub fn saved_but_unread(e: AppError) -> Self {
        Self::new(e.code, format!("{SAVED_BUT_UNREAD}: {}. Reload to see the current state.", e.message))
    }
    pub fn is_cancelled(&self) -> bool {
        self.code == ErrorCode::Cancelled
    }
    /// A panic caught at the top of a background task (transfer or job), so it ends as a failure
    /// instead of staying "running". Only reachable in builds that unwind: release builds use
    /// `panic = "abort"`, where a panic ends the process.
    pub fn from_panic(payload: &(dyn std::any::Any + Send)) -> Self {
        let detail = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown cause".to_string());
        AppError::new(ErrorCode::Unknown, format!("Internal error: the operation stopped unexpectedly ({detail})."))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::new(ErrorCode::Io, e.to_string())
    }
}

impl From<tokio::task::JoinError> for AppError {
    fn from(e: tokio::task::JoinError) -> Self {
        AppError::new(ErrorCode::Unknown, format!("Background task failed: {e}"))
    }
}

impl From<aws_sdk_s3::primitives::ByteStreamError> for AppError {
    fn from(e: aws_sdk_s3::primitives::ByteStreamError) -> Self {
        AppError::new(ErrorCode::Network, format!("Error while streaming data: {}", DisplayErrorContext(&e)))
    }
}

fn looks_like_credentials_problem(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    t.contains("credential")
        || t.contains("sso")
        || t.contains("token has expired")
        || t.contains("no identity")
        || t.contains("identity resolver")
}

/// Most of the SDK text the user sees under "Details:".
const CREDENTIALS_DETAILS_MAX: usize = 500;

/// True when `t` (lowercase) contains `word` delimited by non-alphanumeric characters, so `sso`
/// matches "SSO session" and `sso_session` but not "association".
fn contains_word(t: &str, word: &str) -> bool {
    t.match_indices(word).any(|(i, _)| {
        let before = t[..i].chars().next_back();
        let after = t[i + word.len()..].chars().next();
        !before.is_some_and(|c| c.is_ascii_alphanumeric()) && !after.is_some_and(|c| c.is_ascii_alphanumeric())
    })
}

/// The first meaningful sentence of an SDK error chain: drops the trailing debug dump and the
/// generic "dispatch failure: other: an error occurred while loading credentials" links.
fn first_meaningful_sentence(text: &str) -> String {
    const BOILERPLATE: &[&str] = &[
        "dispatch failure",
        "construction failure",
        "other",
        "an error occurred while loading credentials",
        "failed to construct request",
        "failed to load credentials",
        "io error",
    ];
    let mut t = text.trim();
    for marker in [" (DispatchFailure", " (ConstructionFailure", " (ResponseError", " (ServiceError", " (TimeoutError"] {
        if let Some(i) = t.find(marker) {
            t = &t[..i];
        }
    }
    let mut parts: Vec<&str> = Vec::new();
    for seg in t.split(": ").map(str::trim).filter(|s| !s.is_empty()) {
        let lower = seg.to_ascii_lowercase();
        if BOILERPLATE.contains(&lower.trim_end_matches('.')) || parts.last() == Some(&seg) {
            continue;
        }
        parts.push(seg);
    }
    let joined = if parts.is_empty() { t.to_string() } else { parts.join(": ") };
    let mut sentence = match joined.find(". ") {
        Some(i) => joined[..=i].to_string(),
        None => joined,
    };
    if sentence.chars().count() > 200 {
        sentence = sentence.chars().take(200).collect::<String>() + "…";
    }
    if !sentence.ends_with(['.', '…', '!', '?']) {
        sentence.push('.');
    }
    sentence
}

/// The user-facing message of an `Auth` error caused by credentials that could not be loaded.
/// Expired `aws login` sessions and IAM Identity Center (SSO) sessions name the command to run
/// (with `--profile <name>` when the profile is known); anything else names the profile and the
/// first meaningful sentence. The raw SDK text follows after a blank line as "Details: …".
pub fn credentials_message(text: &str, profile: Option<&str>) -> String {
    let t = text.to_ascii_lowercase();
    let profile = profile.map(str::trim).filter(|p| !p.is_empty());
    let profile_arg = match profile {
        Some(p) if p.chars().any(char::is_whitespace) => format!(" --profile \"{p}\""),
        Some(p) => format!(" --profile {p}"),
        None => String::new(),
    };
    let login_marker = t.contains("login token") || t.contains("credentials-login") || t.contains("login_session");
    let sso = contains_word(&t, "sso") || t.contains("ssooidc") || t.contains("identity center");
    let expired = t.contains("refresh token has expired")
        || t.contains("your session has expired")
        || t.contains("tokenexpired")
        || t.contains("token has expired")
        || t.contains("session has expired");
    let head = if login_marker || (expired && !sso) {
        format!("Your AWS sign-in has expired. Run `aws login{profile_arg}` in a terminal, sign in, then connect again.")
    } else if sso {
        format!("Your AWS sign-in has expired. Run `aws sso login{profile_arg}` in a terminal, sign in, then connect again.")
    } else {
        let sentence = first_meaningful_sentence(text);
        match profile {
            Some(p) => format!("Could not load credentials for profile {p}: {sentence}"),
            None => format!("Could not load credentials: {sentence}"),
        }
    };
    let raw = text.trim();
    let details = if raw.chars().count() > CREDENTIALS_DETAILS_MAX {
        raw.chars().take(CREDENTIALS_DETAILS_MAX).collect::<String>() + "…"
    } else {
        raw.to_string()
    };
    format!("{head}\n\nDetails: {details}")
}

/// S3 error codes meaning "this server does not implement that operation": `NotImplemented` (501,
/// AWS, MinIO, R2) and `MethodNotAllowed` (405). `Unsupported`/`UnsupportedOperation`/`NotSupported`
/// and vendor-prefixed `X…NotImplemented` codes are treated the same (seen in the wild on
/// S3-compatible servers; none of them is sent by SeaweedFS for tagging, which it implements).
pub fn is_not_supported_code(code: &str) -> bool {
    matches!(code, "NotImplemented" | "MethodNotAllowed" | "Unsupported" | "UnsupportedOperation" | "NotSupported")
        || (code.starts_with('X') && code.ends_with("NotImplemented"))
}

fn code_from_service(code: Option<&str>, status: u16) -> ErrorCode {
    match code {
        Some("NoSuchBucket") => ErrorCode::NoSuchBucket,
        Some("NoSuchKey") | Some("NotFound") | Some("NoSuchVersion") => ErrorCode::NoSuchKey,
        Some("AccessDenied") | Some("AllAccessDisabled") | Some("AccountProblem") => ErrorCode::AccessDenied,
        Some("InvalidAccessKeyId")
        | Some("SignatureDoesNotMatch")
        | Some("ExpiredToken")
        | Some("InvalidToken")
        | Some("TokenRefreshRequired")
        | Some("InvalidSecurity")
        | Some("MissingSecurityHeader")
        | Some("AuthorizationHeaderMalformed") => ErrorCode::Auth,
        Some("RequestTimeout") | Some("SlowDown") | Some("ServiceUnavailable") | Some("InternalError") => {
            ErrorCode::Network
        }
        Some("InvalidArgument")
        | Some("InvalidBucketName")
        | Some("KeyTooLongError")
        | Some("InvalidRange")
        | Some("InvalidTag")
        | Some("InvalidObjectState") => {
            ErrorCode::InvalidInput
        }
        Some(c) if is_not_supported_code(c) => ErrorCode::NotSupported,
        _ => match status {
            401 => ErrorCode::Auth,
            403 => ErrorCode::AccessDenied,
            404 => ErrorCode::NoSuchKey,
            405 | 501 => ErrorCode::NotSupported,
            500..=599 => ErrorCode::Network,
            _ => ErrorCode::Unknown,
        },
    }
}

impl<E> From<SdkError<E, HttpResponse>> for AppError
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
{
    fn from(err: SdkError<E, HttpResponse>) -> Self {
        AppError::from_sdk(err, None)
    }
}

impl AppError {
    /// Maps an SDK error like `From` does; `profile` (the connection's profile name, when it has
    /// one) is named in credential messages so the user is told the exact command to run.
    pub fn from_sdk<E>(err: SdkError<E, HttpResponse>, profile: Option<&str>) -> Self
    where
        E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    {
        match &err {
            SdkError::ServiceError(se) => {
                let status = se.raw().status().as_u16();
                let inner = se.err();
                let code = code_from_service(inner.code(), status);
                let message = match (inner.code(), inner.message()) {
                    (Some("InvalidObjectState"), _) => ARCHIVED.to_string(),
                    (Some(c), Some(m)) => format!("{c}: {m}"),
                    (Some("NotFound"), None) => "Not found: the object does not exist".to_string(),
                    (Some(c), None) => match status {
                        403 => format!("{c}: access denied (HTTP 403)"),
                        _ => c.to_string(),
                    },
                    (None, Some(m)) => m.to_string(),
                    (None, None) => match status {
                        301 => "The bucket is in a different region (301 Moved Permanently)".to_string(),
                        403 => "Access denied (HTTP 403)".to_string(),
                        404 => "Not found (HTTP 404)".to_string(),
                        s => format!("S3 returned HTTP {s}"),
                    },
                };
                AppError::new(code, message)
            }
            SdkError::TimeoutError(_) => AppError::new(ErrorCode::Network, "The request timed out"),
            SdkError::DispatchFailure(df) => {
                let text = DisplayErrorContext(&err).to_string();
                if df.is_io() || df.is_timeout() {
                    AppError::new(ErrorCode::Network, format!("Network error: {text}"))
                } else if looks_like_credentials_problem(&text) {
                    AppError::new(ErrorCode::Auth, credentials_message(&text, profile))
                } else {
                    AppError::new(ErrorCode::Network, format!("Request failed: {text}"))
                }
            }
            SdkError::ResponseError(_) => {
                AppError::new(ErrorCode::Network, format!("Invalid response: {}", DisplayErrorContext(&err)))
            }
            SdkError::ConstructionFailure(_) => {
                let text = DisplayErrorContext(&err).to_string();
                if looks_like_credentials_problem(&text) {
                    AppError::new(ErrorCode::Auth, credentials_message(&text, profile))
                } else {
                    AppError::new(ErrorCode::InvalidInput, format!("Invalid request: {text}"))
                }
            }
            _ => {
                let text = DisplayErrorContext(&err).to_string();
                if looks_like_credentials_problem(&text) {
                    AppError::new(ErrorCode::Auth, credentials_message(&text, profile))
                } else {
                    AppError::new(ErrorCode::Unknown, text)
                }
            }
        }
    }
}

/// Status code + `x-amz-bucket-region` header of a failed request, if it reached the server.
pub fn raw_status_and_region<E>(err: &SdkError<E, HttpResponse>) -> Option<(u16, Option<String>)> {
    err.raw_response().map(|r| {
        (r.status().as_u16(), r.headers().get("x-amz-bucket-region").map(|s| s.to_string()))
    })
}

/// True when the error is S3's AccessDenied (used by `connect` to tolerate a denied ListBuckets).
pub fn is_access_denied(e: &AppError) -> bool {
    e.code == ErrorCode::AccessDenied
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_codes() {
        assert_eq!(code_from_service(Some("NotImplemented"), 501), ErrorCode::NotSupported);
        assert_eq!(code_from_service(Some("MethodNotAllowed"), 405), ErrorCode::NotSupported);
        assert_eq!(code_from_service(Some("XMinioNotImplemented"), 400), ErrorCode::NotSupported);
        assert_eq!(code_from_service(Some("UnsupportedOperation"), 400), ErrorCode::NotSupported);
        assert_eq!(code_from_service(None, 501), ErrorCode::NotSupported);
        assert_eq!(code_from_service(None, 405), ErrorCode::NotSupported);
        assert_eq!(code_from_service(Some("NoSuchBucket"), 404), ErrorCode::NoSuchBucket);
        assert_eq!(code_from_service(Some("AccessDenied"), 403), ErrorCode::AccessDenied);
        assert_eq!(code_from_service(Some("InvalidTag"), 400), ErrorCode::InvalidInput);
        assert_eq!(code_from_service(Some("InvalidObjectState"), 403), ErrorCode::InvalidInput, "not AccessDenied");
        assert_eq!(code_from_service(Some("SomethingElse"), 400), ErrorCode::Unknown);
    }

    const LOGIN_EXPIRED: &str = "Could not load credentials: dispatch failure: other: an error occurred while loading credentials: an error occurred while loading credentials: failed to refresh cached Login token: Your session has expired. Please reauthenticate.: AccessDeniedException: The refresh token has expired.: AccessDeniedException: The refresh token has expired. (DispatchFailure(...))";

    #[test]
    fn credentials_aws_login_expired() {
        assert!(looks_like_credentials_problem(LOGIN_EXPIRED));
        let m = credentials_message(LOGIN_EXPIRED, Some("work"));
        assert_eq!(
            m,
            format!(
                "Your AWS sign-in has expired. Run `aws login --profile work` in a terminal, sign in, then connect again.\n\nDetails: {LOGIN_EXPIRED}"
            )
        );
        // The same wording for "TokenExpired" without the login-token phrase.
        let m = credentials_message("ExpiredToken: TokenExpired", Some("work"));
        assert!(m.starts_with("Your AWS sign-in has expired. Run `aws login --profile work`"), "{m}");
    }

    #[test]
    fn credentials_details_truncated() {
        let long = format!("{LOGIN_EXPIRED} {}", "x".repeat(600));
        let m = credentials_message(&long, Some("work"));
        let details = m.split("\n\nDetails: ").nth(1).expect("details");
        assert_eq!(details.chars().count(), CREDENTIALS_DETAILS_MAX + 1, "500 chars plus an ellipsis");
        assert!(details.ends_with('…'));
    }

    #[test]
    fn credentials_sso_expired() {
        let text = "dispatch failure: other: an error occurred while loading credentials: the SSO session has expired or is invalid: failed to load SSO token: the token has expired (DispatchFailure(..))";
        let m = credentials_message(text, Some("dev-admin"));
        assert_eq!(
            m,
            format!(
                "Your AWS sign-in has expired. Run `aws sso login --profile dev-admin` in a terminal, sign in, then connect again.\n\nDetails: {text}"
            )
        );
        // "association" is not SSO context.
        assert!(!contains_word("credential association failed", "sso"));
        assert!(contains_word("sso_session missing", "sso"));
    }

    #[test]
    fn credentials_generic() {
        let text = "dispatch failure: other: an error occurred while loading credentials: the credentials provider was not enabled. Check your config.: no providers in chain provided credentials (DispatchFailure(DispatchFailure { .. }))";
        let m = credentials_message(text, Some("work"));
        assert_eq!(
            m,
            format!("Could not load credentials for profile work: the credentials provider was not enabled.\n\nDetails: {text}")
        );
        let m = credentials_message("no providers in chain provided credentials", Some("work"));
        assert!(m.starts_with("Could not load credentials for profile work: no providers in chain provided credentials.\n\n"), "{m}");
    }

    #[test]
    fn credentials_without_profile() {
        let m = credentials_message(LOGIN_EXPIRED, None);
        assert!(
            m.starts_with("Your AWS sign-in has expired. Run `aws login` in a terminal, sign in, then connect again.\n\nDetails: "),
            "{m}"
        );
        let m = credentials_message("the SSO session has expired or is invalid", None);
        assert!(m.starts_with("Your AWS sign-in has expired. Run `aws sso login` in a terminal"), "{m}");
        let m = credentials_message("other: no providers in chain provided credentials", Some("  "));
        assert!(m.starts_with("Could not load credentials: no providers in chain provided credentials.\n\n"), "{m}");
    }

    #[test]
    fn new_codes_serialize_verbatim() {
        let e = AppError::new(ErrorCode::Conflict, "x");
        assert_eq!(serde_json::to_value(&e).expect("json"), serde_json::json!({"code": "Conflict", "message": "x"}));
        let e = AppError::new(ErrorCode::NotSupported, "y");
        assert_eq!(serde_json::to_value(&e).expect("json")["code"], "NotSupported");
    }
}
