mod config;
mod store;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{
        OriginalUri, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use config::Config;
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{future::IntoFuture, sync::Arc, time::Duration};
use store::SessionStore;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};
use tracing::{error, info};

const COOKIE: &str = "cormier_session";
const PROTOCOL: &str = "cormier.realtime.v1";

#[derive(Clone)]
struct AppState {
    config: Config,
    store: SessionStore,
    http: Client,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_ansi(false)
        .without_time()
        .compact()
        .init();
    if run().await.is_err() {
        error!(event = "startup_failed");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| "failed to install the TLS crypto provider")?;
    let config = Config::load()?;
    let store = SessionStore::connect(&config.redis_url).await?;
    let http = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()?;
    let state = Arc::new(AppState {
        config: config.clone(),
        store,
        http,
    });
    let app = Router::new()
        .route_service("/", ServeFile::new(config.shared_asset_root.join("index.html")))
        .route_service("/app.css", ServeFile::new(config.shared_asset_root.join("app.css")))
        .route_service("/app.js", ServeFile::new(config.shared_asset_root.join("app.js")))
        .nest_service("/_content/Cormier.Realtime.Browser", ServeDir::new(config.sdk_asset_root.clone()))
        .route("/health", get(health))
        .route("/api/diagnostics", get(diagnostics))
        .route("/api/login", post(login))
        .route("/api/session", get(session))
        .route("/api/logout", post(logout))
        .route("/realtime/tickets", post(ticket))
        .route("/realtime/ws", get(websocket))
        .layer(SetResponseHeaderLayer::if_not_present(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::if_not_present(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY")))
        .layer(SetResponseHeaderLayer::if_not_present(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")))
        .layer(SetResponseHeaderLayer::if_not_present(header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'self'; connect-src 'self' ws: wss:; img-src 'self'; style-src 'self'; script-src 'self'")))
        .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, HeaderValue::from_static("no-store")))
        .with_state(state);
    let listener = TcpListener::bind((config.listen_host.as_str(), config.port)).await?;
    let (stopping, stopped) = tokio::sync::oneshot::channel();
    let signal = async move {
        shutdown().await;
        let _ = stopping.send(());
    };
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(signal)
        .into_future();
    tokio::pin!(server);
    info!(event = "application_started");
    tokio::select! {
        result = &mut server => result?,
        _ = stopped => {
            tokio::time::timeout(Duration::from_secs(15), &mut server).await
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "shutdown timeout"))??;
        }
    }
    info!(event = "application_stopped");
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate()).expect("signal handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let ready = state.store.ready().await;
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(serde_json::json!({
            "status": if ready { "healthy" } else { "unavailable" }
        })),
    )
}

async fn diagnostics(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(serde_json::json!({
        "stack": "Rust / Axum", "topology": state.config.topology, "instance": state.config.instance_name,
        "redis": if state.store.ready().await { "ready" } else { "unavailable" },
        "timestamp": OffsetDateTime::now_utc().format(&Rfc3339).map_err(|_| AppError::unavailable())?
    })))
}

#[derive(Deserialize)]
struct LoginRequest {
    #[serde(rename = "tenantId")]
    tenant_id: String,
    #[serde(rename = "userId")]
    user_id: String,
}
#[derive(Serialize, Deserialize)]
struct SessionRecord {
    #[serde(rename = "tenantId")]
    tenant_id: String,
    #[serde(rename = "userId")]
    user_id: String,
    #[serde(rename = "allowedTopics")]
    allowed_topics: Vec<String>,
    #[serde(rename = "expiresAt", with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
    revoked: bool,
}

async fn login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<LoginRequest>,
) -> Result<Response, AppError> {
    require_origin(&headers, &state.config)?;
    if !state.config.allows(&request.tenant_id, &request.user_id) {
        return Err(AppError::invalid_identity());
    }
    let mut bytes = [0_u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    let id = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let record = SessionRecord {
        tenant_id: request.tenant_id,
        user_id: request.user_id,
        allowed_topics: vec!["orders".into(), "notifications".into()],
        expires_at: OffsetDateTime::now_utc()
            + time::Duration::seconds(state.config.session_lifetime_seconds as i64),
        revoked: false,
    };
    let encoded = serde_json::to_string(&record).map_err(|_| AppError::unavailable())?;
    state
        .store
        .put(
            &state.config.session_key(&id),
            &encoded,
            state.config.session_lifetime_seconds,
        )
        .await
        .map_err(|_| AppError::unavailable())?;
    let body = Json(
        serde_json::json!({ "tenantId": record.tenant_id, "userId": record.user_id,
        "expiresAt": record.expires_at.format(&Rfc3339).map_err(|_| AppError::unavailable())? }),
    );
    let mut response = body.into_response();
    let secure = if state.config.public_origin.scheme() == "https" {
        "; Secure"
    } else {
        ""
    };
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{COOKIE}={id}; Path=/; Max-Age={}; HttpOnly; SameSite=Strict{secure}",
            state.config.session_lifetime_seconds
        ))
        .map_err(|_| AppError::unavailable())?,
    );
    Ok(response)
}

async fn session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let id = cookie(&headers)
        .filter(|value| valid_session_id(value))
        .ok_or_else(AppError::unauthorized)?;
    let value = state
        .store
        .get(&state.config.session_key(id))
        .await
        .map_err(|_| AppError::unavailable())?
        .ok_or_else(AppError::unauthorized)?;
    let record: SessionRecord =
        serde_json::from_str(&value).map_err(|_| AppError::unavailable())?;
    if record.revoked || record.expires_at <= OffsetDateTime::now_utc() {
        return Err(AppError::unauthorized());
    }
    Ok(Json(
        serde_json::json!({ "authenticated": true, "tenantId": record.tenant_id, "userId": record.user_id,
        "allowedTopics": record.allowed_topics, "expiresAt": record.expires_at.format(&Rfc3339).map_err(|_| AppError::unavailable())? }),
    ))
}

async fn logout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    require_origin(&headers, &state.config)?;
    if let Some(id) = cookie(&headers).filter(|value| valid_session_id(value)) {
        state
            .store
            .remove(&state.config.session_key(id))
            .await
            .map_err(|_| AppError::unavailable())?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("cormier_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"),
    );
    Ok(response)
}

async fn ticket(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    require_origin(&headers, &state.config)?;
    let url = state
        .config
        .gateway_url
        .join("realtime/tickets")
        .map_err(|_| AppError::unavailable())?;
    let mut request = state.http.post(url).body(body);
    request = request.header("x-forwarded-proto", state.config.public_scheme());
    for name in [
        header::ORIGIN,
        header::COOKIE,
        header::HOST,
        header::CONTENT_TYPE,
    ] {
        if let Some(value) = headers.get(&name) {
            request = request.header(name, value);
        }
    }
    let upstream = request.send().await.map_err(|_| AppError::unavailable())?;
    let status = upstream.status();
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let bytes = upstream
        .bytes()
        .await
        .map_err(|_| AppError::unavailable())?;
    let mut response = (status, bytes).into_response();
    if let Some(value) = content_type {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    Ok(response)
}

async fn websocket(
    State(state): State<Arc<AppState>>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response, AppError> {
    require_origin(&headers, &state.config)?;
    let cookie = headers.get(header::COOKIE).cloned();
    let host = headers.get(header::HOST).cloned();
    let query = uri.query().map(str::to_owned);
    Ok(upgrade
        .protocols([PROTOCOL])
        .on_upgrade(move |browser| relay(browser, state, cookie, host, query)))
}

async fn relay(
    browser: WebSocket,
    state: Arc<AppState>,
    cookie: Option<HeaderValue>,
    host: Option<HeaderValue>,
    query: Option<String>,
) {
    if let Err(error) = relay_inner(browser, state, cookie, host, query).await {
        error!(event="websocket_proxy_failed", kind=%error.code);
    }
}

async fn relay_inner(
    browser: WebSocket,
    state: Arc<AppState>,
    cookie: Option<HeaderValue>,
    host: Option<HeaderValue>,
    query: Option<String>,
) -> Result<(), AppError> {
    let mut url = state
        .config
        .gateway_url
        .join("realtime/ws")
        .map_err(|_| AppError::unavailable())?;
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| AppError::unavailable())?;
    url.set_query(query.as_deref());
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| AppError::unavailable())?;
    request.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_str(state.config.public_origin.as_str())
            .map_err(|_| AppError::unavailable())?,
    );
    request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(PROTOCOL),
    );
    request.headers_mut().insert(
        "x-forwarded-proto",
        HeaderValue::from_str(state.config.public_scheme()).map_err(|_| AppError::unavailable())?,
    );
    if let Some(value) = cookie {
        request.headers_mut().insert(header::COOKIE, value);
    }
    if let Some(value) = host {
        request.headers_mut().insert(header::HOST, value);
    }
    let (gateway, _) = tokio::time::timeout(Duration::from_secs(15), connect_async(request))
        .await
        .map_err(|_| AppError::unavailable())?
        .map_err(|_| AppError::unavailable())?;
    let (mut browser_tx, mut browser_rx) = browser.split();
    let (mut gateway_tx, mut gateway_rx) = gateway.split();
    let to_gateway = async {
        while let Some(Ok(message)) = browser_rx.next().await {
            let converted = match message {
                Message::Text(value) => {
                    tokio_tungstenite::tungstenite::Message::Text(value.as_str().into())
                }
                Message::Binary(value) => tokio_tungstenite::tungstenite::Message::Binary(value),
                Message::Close(_) => break,
                _ => continue,
            };
            if gateway_tx.send(converted).await.is_err() {
                break;
            }
        }
    };
    let to_browser = async {
        while let Some(Ok(message)) = gateway_rx.next().await {
            let converted = match message {
                tokio_tungstenite::tungstenite::Message::Text(value) => {
                    Message::Text(value.as_str().into())
                }
                tokio_tungstenite::tungstenite::Message::Binary(value) => Message::Binary(value),
                tokio_tungstenite::tungstenite::Message::Close(_) => break,
                _ => continue,
            };
            if browser_tx.send(converted).await.is_err() {
                break;
            }
        }
    };
    tokio::select! { _ = to_gateway => {}, _ = to_browser => {} }
    Ok(())
}

fn require_origin(headers: &HeaderMap, config: &Config) -> Result<(), AppError> {
    if headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        != Some(config.public_origin.as_str().trim_end_matches('/'))
    {
        return Err(AppError::origin());
    }
    Ok(())
}
fn cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| part.trim().strip_prefix(&format!("{COOKIE}=")))
}
fn valid_session_id(value: &str) -> bool {
    (16..=256).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}
impl AppError {
    fn origin() -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "origin_rejected",
            message: "The request Origin is not allowed.",
        }
    }
    fn invalid_identity() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_identity",
            message: "Select a configured test tenant and user.",
        }
    }
    fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "authentication_required",
            message: "Authentication is required.",
        }
    }
    fn unavailable() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "service_unavailable",
            message: "The reference application dependency is unavailable.",
        }
    }
}
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({"code": self.code, "message": self.message})),
        )
            .into_response()
    }
}
