use crate::argos;
use crate::constants::{DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, JSON_BODY_LIMIT, OCR_BODY_LIMIT};
use crate::history::{self, NewMessage};
use crate::llm::{self, ChatOptions};
use crate::log;
use crate::ocr;
use crate::search;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::SystemTime;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

#[derive(Debug, Default, Deserialize)]
pub struct HealthRequest {
    #[serde(default, rename = "llmBaseUrl")]
    pub llm_base_url: String,
    #[serde(default, rename = "llmApiKey")]
    pub llm_api_key: String,
    #[serde(default, rename = "searxngUrl")]
    pub searxng_url: String,
    #[serde(default, rename = "argosBaseUrl")]
    pub argos_base_url: String,
    #[serde(default, rename = "argosApiKey")]
    pub argos_api_key: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct ChatRequest {
    #[serde(default, rename = "llmBaseUrl")]
    pub llm_base_url: String,
    #[serde(default, rename = "llmApiKey")]
    pub llm_api_key: String,
    #[serde(default)]
    pub model: String,
    /// OpenAI chat messages, forwarded as-is so tool turns keep their shape.
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub tools: Vec<Value>,
    #[serde(default, rename = "thinkingLevel")]
    pub thinking_level: Option<String>,
    #[serde(default, rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub stream: bool,
}

#[derive(Debug, Default, Deserialize)]
pub struct SearchRequest {
    #[serde(default, rename = "searxngUrl")]
    pub searxng_url: String,
    #[serde(default)]
    pub q: String,
}

#[derive(Clone)]
struct AppState {
    connection_file: PathBuf,
}

fn note_connection(line: &str) {
    log::info(line, None);
}

fn active_connection(file: &std::path::Path, base_url: &str, api_key: &str, searxng_url: &str) -> crate::connection::Connection {
    let read = crate::connection::read_connection(file, &mut note_connection);
    crate::connection::resolve_connection(
        &read,
        &crate::connection::Connection {
            llm_base_url: base_url.to_string(),
            llm_api_key: api_key.to_string(),
            searxng_url: searxng_url.to_string(),
        },
    )
}

fn json_error(status: StatusCode, error: &str, hint: Option<&str>) -> Response {
    let body = if let Some(hint) = hint {
        json!({ "error": error, "hint": hint })
    } else {
        json!({ "error": error })
    };
    (status, Json(body)).into_response()
}

async fn get_health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "LexCrew Doc" }))
}

async fn get_connection(State(state): State<AppState>) -> Json<Value> {
    let file = crate::connection::read_connection(&state.connection_file, &mut note_connection);
    Json(crate::connection::connection_payload(&file))
}

async fn post_connection(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    let incoming = crate::connection::connection_from_value(&body);
    match crate::connection::adopt_connection(&state.connection_file, &incoming, &mut note_connection) {
        Ok(file) => Json(crate::connection::connection_payload(&file)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error, None),
    }
}

async fn put_connection(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    let incoming = crate::connection::connection_from_value(&body);
    match crate::connection::save_connection(&state.connection_file, &incoming) {
        Ok(()) => Json(json!({
            "kind": "ready",
            "llmBaseUrl": incoming.llm_base_url,
            "llmApiKey": incoming.llm_api_key,
            "searxngUrl": incoming.searxng_url,
        }))
        .into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error, None),
    }
}

async fn post_health(State(state): State<AppState>, Json(body): Json<HealthRequest>) -> Response {
    log::info_status("POST /api/health", "start");
    let connection = active_connection(
        &state.connection_file,
        &body.llm_base_url,
        &body.llm_api_key,
        &body.searxng_url,
    );
    let llm = llm::check_llm_health(&connection.llm_base_url, &connection.llm_api_key).await;
    let searxng = if connection.searxng_url.trim().is_empty() {
        None
    } else {
        let (ok, error) = search::check_searxng(&connection.searxng_url).await;
        let mut payload = json!({ "ok": ok });
        if let Some(error) = error {
            payload["error"] = json!(error);
        }
        Some(payload)
    };

    let status = if llm.ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    log::info_status("POST /api/health", status.as_u16());
    let mut payload = json!({
        "sidecar": { "ok": true },
        "llm": llm,
    });
    if let Some(searxng) = searxng {
        payload["searxng"] = searxng;
    }
    if !body.argos_base_url.trim().is_empty() {
        let (ok, error) = argos::check_argos(&body.argos_base_url, &body.argos_api_key).await;
        let mut row = json!({ "ok": ok });
        if let Some(error) = error {
            row["error"] = json!(error);
        }
        payload["argos"] = row;
    }
    (status, Json(payload)).into_response()
}

async fn forward_mtplx_stream(upstream: reqwest::Response) -> Response {
    let content_type = upstream
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if !content_type.contains("json") || content_type.contains("event-stream") {
        let stream = upstream.bytes_stream().map(|chunk| {
            chunk.map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error.to_string()))
        });
        return Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "text/event-stream; charset=utf-8")
            .header(CACHE_CONTROL, "no-cache")
            .header("x-accel-buffering", "no")
            .body(Body::from_stream(stream))
            .unwrap_or_else(|_| {
                json_error(
                    StatusCode::BAD_GATEWAY,
                    "ストリームの開始に失敗しました。",
                    None,
                )
            });
    }

    match upstream.json::<Value>().await {
        Ok(payload) => {
            let body = format!("data: {payload}\n\ndata: [DONE]\n\n");
            Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "text/event-stream; charset=utf-8")
                .header(CACHE_CONTROL, "no-cache")
                .header("x-accel-buffering", "no")
                .body(Body::from(body))
                .unwrap_or_else(|_| {
                    json_error(
                        StatusCode::BAD_GATEWAY,
                        "ストリームの開始に失敗しました。",
                        None,
                    )
                })
        }
        Err(_) => json_error(
            StatusCode::BAD_GATEWAY,
            "MTPLX への問い合わせに失敗しました。",
            None,
        ),
    }
}

async fn post_chat(State(state): State<AppState>, Json(body): Json<ChatRequest>) -> Response {
    let connection = active_connection(
        &state.connection_file,
        &body.llm_base_url,
        &body.llm_api_key,
        "",
    );
    let model = if body.model.trim().is_empty() {
        DEFAULT_MODEL
    } else {
        body.model.trim()
    };
    let thinking_level = body
        .thinking_level
        .clone()
        .unwrap_or_else(|| "medium".into());
    let options = ChatOptions {
        base_url: &connection.llm_base_url,
        api_key: &connection.llm_api_key,
        model,
        messages: &body.messages,
        tools: &body.tools,
        thinking_level: &thinking_level,
        timeout_ms: body.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
    };

    if body.stream {
        return match llm::post_chat(options, true).await {
            Ok(upstream) => forward_mtplx_stream(upstream).await,
            Err(error) => {
                let status = if error.cancelled {
                    StatusCode::from_u16(499).unwrap_or(StatusCode::BAD_REQUEST)
                } else {
                    StatusCode::BAD_GATEWAY
                };
                json_error(status, &error.message, error.hint.as_deref())
            }
        };
    }

    match llm::chat_completions(options).await {
        Ok(completion) => Json(completion).into_response(),
        Err(error) => {
            let status = if error.cancelled {
                StatusCode::from_u16(499).unwrap_or(StatusCode::BAD_REQUEST)
            } else {
                StatusCode::BAD_GATEWAY
            };
            json_error(status, &error.message, error.hint.as_deref())
        }
    }
}

async fn post_search(State(state): State<AppState>, Json(body): Json<SearchRequest>) -> Response {
    let connection = active_connection(&state.connection_file, "", "", &body.searxng_url);
    match search::search(&body.q, &connection.searxng_url).await {
        Ok(results) => Json(json!({
            "provider": "searxng",
            "results": results,
        }))
        .into_response(),
        Err(error) => {
            let status = if error.cancelled {
                StatusCode::from_u16(499).unwrap_or(StatusCode::BAD_REQUEST)
            } else {
                StatusCode::BAD_GATEWAY
            };
            json_error(status, &error.message, None)
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct ArgosScopesQuery {
    #[serde(default, rename = "argosBaseUrl")]
    argos_base_url: String,
    #[serde(default, rename = "argosApiKey")]
    argos_api_key: String,
    #[serde(default)]
    query: String,
}

#[derive(Debug, Default, Deserialize)]
struct ArgosSearchBody {
    #[serde(default, rename = "argosBaseUrl")]
    argos_base_url: String,
    #[serde(default, rename = "argosApiKey")]
    argos_api_key: String,
    #[serde(default)]
    q: String,
    #[serde(default, rename = "pathPrefixes")]
    path_prefixes: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ArgosScopeBody {
    #[serde(default, rename = "pathPrefixes")]
    path_prefixes: Vec<String>,
}

async fn argos_scopes_response(base_url: &str, api_key: &str, query: &str) -> Response {
    match argos::list_scopes(base_url, api_key, query).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => {
            let status = if error.cancelled {
                StatusCode::from_u16(499).unwrap_or(StatusCode::BAD_REQUEST)
            } else {
                StatusCode::BAD_GATEWAY
            };
            json_error(status, &error.message, error.hint.as_deref())
        }
    }
}

async fn get_argos_scopes(Query(query): Query<ArgosScopesQuery>) -> Response {
    argos_scopes_response(&query.argos_base_url, &query.argos_api_key, &query.query).await
}

async fn post_argos_scopes(Json(body): Json<ArgosScopesQuery>) -> Response {
    argos_scopes_response(&body.argos_base_url, &body.argos_api_key, &body.query).await
}

async fn post_argos_search(Json(body): Json<ArgosSearchBody>) -> Response {
    match argos::search(
        &body.argos_base_url,
        &body.argos_api_key,
        &body.q,
        &body.path_prefixes,
    )
    .await
    {
        Ok(results) => {
            crate::indexed::note_hits(results.iter().map(|hit| hit.url.as_str()));
            Json(json!({
                "provider": "argos",
                "results": results,
            }))
            .into_response()
        }
        Err(error) => {
            let status = if error.cancelled {
                StatusCode::from_u16(499).unwrap_or(StatusCode::BAD_REQUEST)
            } else {
                StatusCode::BAD_GATEWAY
            };
            json_error(status, &error.message, error.hint.as_deref())
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct IndexedFileBody {
    #[serde(default)]
    path: String,
}

async fn post_argos_file(Json(body): Json<IndexedFileBody>) -> Response {
    match crate::indexed::read_file(&body.path) {
        Ok((name, data)) => Json(json!({ "name": name, "data": data })).into_response(),
        Err(crate::indexed::ReadError::Forbidden) => json_error(
            StatusCode::FORBIDDEN,
            "検索結果に無いパスは読めません。search_index の url をそのまま渡してください。",
            None,
        ),
        Err(crate::indexed::ReadError::BadRequest(reason)) => {
            json_error(StatusCode::BAD_REQUEST, &reason, None)
        }
        Err(crate::indexed::ReadError::NotFound) => {
            json_error(StatusCode::NOT_FOUND, "ファイルが見つかりません。", None)
        }
        Err(crate::indexed::ReadError::Failed) => {
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "失敗しました。", None)
        }
    }
}

async fn put_argos_scope(Path(id): Path<String>, Json(body): Json<ArgosScopeBody>) -> Response {
    match history::with_db(|db| history::set_argos_path_prefix(db, &id, &body.path_prefixes)) {
        Ok(Some(conversation)) => Json(conversation).into_response(),
        Ok(None) => not_found(),
        Err(_) => history_error(),
    }
}

/// One page image to read. The three connection fields on the body are the
/// fallback when `connection.json` is missing or unreadable.
#[derive(Debug, Default, Deserialize)]
pub struct OcrRequest {
    #[serde(default, rename = "llmBaseUrl")]
    pub llm_base_url: String,
    #[serde(default, rename = "llmApiKey")]
    pub llm_api_key: String,
    #[serde(default)]
    pub model: String,
    /// A `data:image/...;base64,` URL.
    #[serde(default)]
    pub image: String,
    #[serde(default, rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
}

async fn post_ocr(State(state): State<AppState>, Json(body): Json<OcrRequest>) -> Response {
    let image = body.image.trim();
    if !image.starts_with("data:image/") {
        return json_error(
            StatusCode::BAD_REQUEST,
            "読み取る画像が渡されていません。",
            None,
        );
    }
    let model = if body.model.trim().is_empty() {
        DEFAULT_MODEL
    } else {
        body.model.trim()
    };
    let messages = vec![json!({
        "role": "user",
        "content": [
            { "type": "text", "text": ocr::OCR_PROMPT },
            { "type": "image_url", "image_url": { "url": image } }
        ]
    })];
    log::info_status("POST /api/ocr", "start");
    let connection = active_connection(
        &state.connection_file,
        &body.llm_base_url,
        &body.llm_api_key,
        "",
    );
    // Thinking is off: transcription is not a reasoning task, and a long
    // deliberation per page makes a 20-page scan crawl.
    let options = ChatOptions {
        base_url: &connection.llm_base_url,
        api_key: &connection.llm_api_key,
        model,
        messages: &messages,
        tools: &[],
        thinking_level: "off",
        timeout_ms: body.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
    };
    match llm::chat_completions(options).await {
        Ok(completion) => {
            log::info_status("POST /api/ocr", 200);
            Json(json!({ "text": ocr::clip_page(&completion.content) })).into_response()
        }
        Err(error) => {
            if error.cancelled {
                return json_error(
                    StatusCode::from_u16(499).unwrap_or(StatusCode::BAD_REQUEST),
                    "キャンセルしました。",
                    None,
                );
            }
            match ocr::vision_unsupported_message(&error.message) {
                Some(message) => json_error(StatusCode::BAD_GATEWAY, message, None),
                None => json_error(StatusCode::BAD_GATEWAY, &error.message, error.hint.as_deref()),
            }
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct FilesBody {
    #[serde(default)]
    files: Vec<Value>,
}

async fn put_conversation_files(Path(id): Path<String>, Json(body): Json<FilesBody>) -> Response {
    match history::with_db(|db| history::set_files(db, &id, &body.files)) {
        Ok(Some(files)) => Json(json!({ "files": files })).into_response(),
        Ok(None) => not_found(),
        Err(_) => history_error(),
    }
}

async fn redirect_root() -> Redirect {
    Redirect::temporary("/taskpane.html")
}

#[derive(Debug, Default, Deserialize)]
pub struct ConversationQuery {
    #[serde(default, rename = "documentKey")]
    pub document_key: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct NewConversation {
    #[serde(default, rename = "documentKey")]
    pub document_key: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, rename = "documentPath")]
    pub document_path: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct DocumentPathBody {
    #[serde(default, rename = "documentKey")]
    pub document_key: String,
    #[serde(default, rename = "documentPath")]
    pub document_path: String,
}

fn history_error() -> Response {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "会話の保存に失敗しました。",
        None,
    )
}

fn not_found() -> Response {
    json_error(
        StatusCode::NOT_FOUND,
        "その会話は見つかりませんでした。",
        None,
    )
}

// Conversations live only in the local database. Bodies are never logged.
async fn get_conversations(Query(query): Query<ConversationQuery>) -> Response {
    let key = query.document_key.clone();
    match history::with_db(|db| history::list_conversations(db, Some(key.as_str()))) {
        Ok(conversations) => Json(json!({ "conversations": conversations })).into_response(),
        Err(_) => history_error(),
    }
}

async fn post_conversations(Json(body): Json<NewConversation>) -> Response {
    match history::with_db(|db| {
        history::create_conversation(db, &body.document_key, &body.title, &body.document_path)
    }) {
        Ok(conversation) => Json(conversation).into_response(),
        Err(_) => history_error(),
    }
}

async fn put_document_path(Json(body): Json<DocumentPathBody>) -> Response {
    match history::with_db(|db| {
        history::set_document_path(db, &body.document_key, &body.document_path)
    }) {
        Ok(updated) => Json(json!({ "ok": true, "updated": updated })).into_response(),
        Err(_) => history_error(),
    }
}

async fn get_conversation(Path(id): Path<String>) -> Response {
    match history::with_db(|db| history::get_conversation(db, &id)) {
        Ok(Some(detail)) => Json(detail).into_response(),
        Ok(None) => not_found(),
        Err(_) => history_error(),
    }
}

async fn post_conversation_messages(
    Path(id): Path<String>,
    Json(body): Json<NewMessage>,
) -> Response {
    match history::with_db(|db| history::append_message(db, &id, &body)) {
        Ok(Some(message)) => Json(message).into_response(),
        Ok(None) => not_found(),
        Err(_) => history_error(),
    }
}

async fn delete_conversation(Path(id): Path<String>) -> Response {
    match history::with_db(|db| history::delete_conversation(db, &id)) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => not_found(),
        Err(_) => history_error(),
    }
}

fn default_connection_file() -> PathBuf {
    #[cfg(test)]
    {
        std::env::temp_dir()
            .join("guri-test-connection-absent")
            .join("connection.json")
    }
    #[cfg(not(test))]
    {
        crate::connection::connection_path()
    }
}

pub fn create_router(static_dir: Option<PathBuf>) -> Router {
    create_router_at(static_dir, default_connection_file())
}

fn create_router_at(static_dir: Option<PathBuf>, connection_file: PathBuf) -> Router {
    if let Some(dir) = connection_file.parent() {
        crate::connection::sweep_connection_temps(dir, SystemTime::now());
    }
    let state = AppState { connection_file };
    let router = Router::new()
        .route("/api/health", get(get_health).post(post_health))
        .route("/api/connection", get(get_connection).post(post_connection).put(put_connection))
        .route("/api/chat", post(post_chat))
        // A page image is base64, which grows it by 4/3, so this one route
        // takes more than the limit that guards every other body.
        .route(
            "/api/ocr",
            post(post_ocr).layer(DefaultBodyLimit::max(OCR_BODY_LIMIT)),
        )
        .route("/api/search", post(post_search))
        .route(
            "/api/argos/scopes",
            get(get_argos_scopes).post(post_argos_scopes),
        )
        .route("/api/argos/search", post(post_argos_search))
        .route("/api/argos/file", post(post_argos_file))
        .route(
            "/api/conversations",
            get(get_conversations).post(post_conversations),
        )
        .route("/api/conversations/document-path", put(put_document_path))
        .route("/api/conversations/{id}", get(get_conversation))
        .route("/api/conversations/{id}", delete(delete_conversation))
        .route(
            "/api/conversations/{id}/messages",
            post(post_conversation_messages),
        )
        .route("/api/conversations/{id}/argos-scope", put(put_argos_scope))
        .route("/api/conversations/{id}/files", put(put_conversation_files))
        .route("/", get(redirect_root))
        .layer(DefaultBodyLimit::max(JSON_BODY_LIMIT));

    let router = if let Some(dir) = static_dir {
        router.fallback_service(ServeDir::new(dir))
    } else {
        router
    };
    router
        .layer(SetResponseHeaderLayer::overriding(
            CACHE_CONTROL,
            // Office refuses to use ribbon images it may not store, so revalidate
            // instead of sending no-store.
            HeaderValue::from_static("no-cache, must-revalidate"),
        ))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log as glog;
    use axum::body::Body;
    use axum::http::{header::CONTENT_TYPE, Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use tower::ServiceExt;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, Request as MockRequest, ResponseTemplate};

    async fn json_request(
        app: Router,
        method: &str,
        uri: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let response = app
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, json)
    }

    async fn sse_request(app: Router, body: Value) -> (StatusCode, String, String) {
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/chat")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            content_type,
            String::from_utf8_lossy(&bytes).into_owned(),
        )
    }

    #[tokio::test]
    async fn get_health_reports_local_process() {
        let (status, body) = {
            let response = create_router(None)
                .oneshot(
                    Request::builder()
                        .uri("/api/health")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let json: Value = serde_json::from_slice(&bytes).unwrap();
            (status, json)
        };
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        assert_eq!(body["service"], "LexCrew Doc");
    }

    #[tokio::test]
    async fn health_prefers_a_ready_connection_file() {
        let mtplx = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .and(wiremock::matchers::header("authorization", "Bearer file-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": [{ "id": "qwen3.8-flash-next" }]
            })))
            .expect(1)
            .mount(&mtplx)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .and(wiremock::matchers::header("authorization", "Bearer body-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": [{ "id": "qwen3.8-flash-next" }]
            })))
            .expect(1)
            .mount(&mtplx)
            .await;
        let searx = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/search"))
            .and(query_param("format", "json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [{ "title": "民法", "url": "https://example.jp/m", "content": "抜粋" }]
            })))
            .expect(2)
            .mount(&searx)
            .await;

        let dir = std::env::temp_dir().join(format!("guri-api-conn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("connection.json");
        std::fs::write(
            &file,
            format!(
                "{{\n  \"llmBaseUrl\": \"{}/v1\",\n  \"llmApiKey\": \"file-key\",\n  \"searxngUrl\": \"{}\"\n}}\n",
                mtplx.uri(),
                searx.uri()
            ),
        )
        .unwrap();

        let (status, body) = json_request(
            create_router_at(None, file.clone()),
            "POST",
            "/api/health",
            json!({
                "llmBaseUrl": "http://127.0.0.1:9/v1",
                "llmApiKey": "body-key",
                "searxngUrl": "http://127.0.0.1:9",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["llm"]["ok"], true);
        assert_eq!(body["searxng"]["ok"], true);

        std::fs::write(&file, "{").unwrap();
        let (status, body) = json_request(
            create_router_at(None, file),
            "POST",
            "/api/health",
            json!({
                "llmBaseUrl": format!("{}/v1", mtplx.uri()),
                "llmApiKey": "body-key",
                "searxngUrl": searx.uri(),
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["llm"]["ok"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn health_checks_models_then_searxng() {
        let mtplx = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": [{ "id": "qwen3.8-flash-next" }]
            })))
            .mount(&mtplx)
            .await;

        let searx = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/search"))
            .and(query_param("format", "json"))
            .and(query_param("language", "ja"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [{ "title": "民法", "url": "https://example.jp/m", "content": "抜粋" }]
            })))
            .mount(&searx)
            .await;

        let (status, body) = json_request(
            create_router(None),
            "POST",
            "/api/health",
            json!({
                "llmBaseUrl": format!("{}/v1", mtplx.uri()),
                "llmApiKey": "test-key",
                "searxngUrl": searx.uri(),
            }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["llm"]["ok"], true);
        let models = body["llm"]["models"].as_array().unwrap();
        assert!(models.iter().any(|m| m == "qwen3.8-flash-next"));
        assert_eq!(body["searxng"]["ok"], true);
    }

    #[tokio::test]
    async fn health_falls_back_to_get_health() {
        let mtplx = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(500).set_body_string("no models"))
            .mount(&mtplx)
            .await;
        Mock::given(method("GET"))
            .and(path("/health"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "status": "ok" })))
            .mount(&mtplx)
            .await;

        let (status, body) = json_request(
            create_router(None),
            "POST",
            "/api/health",
            json!({
                "llmBaseUrl": mtplx.uri(),
                "llmApiKey": "test-key",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["llm"]["ok"], true);
    }

    struct ToolCallResponder;

    impl wiremock::Respond for ToolCallResponder {
        fn respond(&self, request: &MockRequest) -> ResponseTemplate {
            let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
            assert_eq!(body["tools"][0]["function"]["name"], "search");
            assert_eq!(body["tool_choice"], "auto");
            assert_eq!(body["reasoning_effort"], "medium");
            assert_eq!(body["chat_template_kwargs"]["enable_thinking"], true);
            assert!(body.get("thinking_budget").is_none());
            ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "reasoning_content": "どの条文か確かめる",
                        "tool_calls": [{
                            "id": "c1",
                            "type": "function",
                            "function": { "name": "search", "arguments": "{\"q\":\"民法\"}" }
                        }]
                    }
                }],
                "usage": {
                    "prompt_tokens": 400,
                    "completion_tokens": 60,
                    "total_tokens": 460,
                    "completion_tokens_details": { "reasoning_tokens": 30 }
                }
            }))
        }
    }

    #[tokio::test]
    async fn chat_forwards_tools_and_thinking_then_returns_tool_calls() {
        let mtplx = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ToolCallResponder)
            .mount(&mtplx)
            .await;

        glog::capture_start();
        let (status, body) = json_request(
            create_router(None),
            "POST",
            "/api/chat",
            json!({
                "llmBaseUrl": format!("{}/v1", mtplx.uri()),
                "llmApiKey": "test-key",
                "model": "qwen3.8-flash-next",
                "messages": [{ "role": "user", "content": "SECRET_PROMPT 本文そのもの" }],
                "tools": [{
                    "type": "function",
                    "function": { "name": "search", "parameters": { "type": "object" } }
                }],
                "thinkingLevel": "medium",
                "thinkingBudget": 2048,
            }),
        )
        .await;
        let dumped = glog::capture_stop().join("\n");

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["finishReason"], "tool_calls");
        assert_eq!(body["toolCalls"][0]["function"]["name"], "search");
        assert_eq!(body["reasoningContent"], "どの条文か確かめる");
        assert_eq!(body["usage"]["totalTokens"], 460);
        assert_eq!(body["usage"]["reasoningTokens"], 30);
        assert!(!dumped.contains("SECRET_PROMPT"));
        assert!(!dumped.contains("本文そのもの"));
        assert!(!dumped.contains("test-key"));
        assert!(!dumped.contains("どの条文か確かめる"));
    }

    struct ThinkingUnsupportedResponder;

    impl wiremock::Respond for ThinkingUnsupportedResponder {
        fn respond(&self, request: &MockRequest) -> ResponseTemplate {
            let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
            if body.get("chat_template_kwargs").is_some() {
                return ResponseTemplate::new(400)
                    .set_body_json(json!({ "error": { "message": "unknown field" } }));
            }
            ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{
                    "finish_reason": "stop",
                    "message": { "content": "<think>hidden</think>コメントを付けました。" }
                }]
            }))
        }
    }

    #[tokio::test]
    async fn chat_retries_without_thinking_fields_and_strips_think() {
        let mtplx = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ThinkingUnsupportedResponder)
            .mount(&mtplx)
            .await;

        let (status, body) = json_request(
            create_router(None),
            "POST",
            "/api/chat",
            json!({
                "llmBaseUrl": format!("{}/v1", mtplx.uri()),
                "llmApiKey": "test-key",
                "messages": [{ "role": "user", "content": "点検して" }],
                "thinkingLevel": "medium",
            }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        let content = body["content"].as_str().unwrap();
        assert!(!content.contains("hidden"));
        assert_eq!(content, "コメントを付けました。");
        assert_eq!(body["toolCalls"].as_array().unwrap().len(), 0);
    }

    struct JsonAsSseResponder;

    impl wiremock::Respond for JsonAsSseResponder {
        fn respond(&self, request: &MockRequest) -> ResponseTemplate {
            let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
            assert_eq!(body["stream"], true);
            ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{
                    "finish_reason": "stop",
                    "message": { "content": "コメントを付けました。" }
                }]
            }))
        }
    }

    struct SsePipeResponder;

    impl wiremock::Respond for SsePipeResponder {
        fn respond(&self, request: &MockRequest) -> ResponseTemplate {
            let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
            assert_eq!(body["stream"], true);
            let chunk = json!({
                "choices": [{ "delta": { "content": "こんにちは" } }]
            });
            ResponseTemplate::new(200).set_body_raw(
                format!("data: {chunk}\n\ndata: [DONE]\n\n"),
                "text/event-stream",
            )
        }
    }

    #[tokio::test]
    async fn chat_wraps_json_reply_as_sse_when_stream_requested() {
        let mtplx = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(JsonAsSseResponder)
            .mount(&mtplx)
            .await;

        let (status, content_type, text) = sse_request(
            create_router(None),
            json!({
                "llmBaseUrl": format!("{}/v1", mtplx.uri()),
                "llmApiKey": "test-key",
                "messages": [{ "role": "user", "content": "点検して" }],
                "stream": true,
            }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert!(content_type.contains("event-stream"));
        assert!(text.contains("[DONE]"));
        assert!(text.contains("コメントを付けました。"));
    }

    #[tokio::test]
    async fn chat_pipes_mtplx_sse_when_stream_requested() {
        let mtplx = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(SsePipeResponder)
            .mount(&mtplx)
            .await;

        let (status, content_type, text) = sse_request(
            create_router(None),
            json!({
                "llmBaseUrl": format!("{}/v1", mtplx.uri()),
                "llmApiKey": "test-key",
                "messages": [{ "role": "user", "content": "こんにちは" }],
                "stream": true,
            }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert!(content_type.contains("event-stream"));
        assert!(text.contains("こんにちは"));
        assert!(text.contains("[DONE]"));
    }

    #[tokio::test]
    async fn search_maps_hits() {
        let searx = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/search"))
            .and(query_param("q", "民法"))
            .and(query_param("format", "json"))
            .and(query_param("language", "ja"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [{
                    "title": "e-Gov 民法",
                    "url": "https://laws.e-gov.go.jp/",
                    "content": "第415条"
                }]
            })))
            .mount(&searx)
            .await;

        let (status, body) = json_request(
            create_router(None),
            "POST",
            "/api/search",
            json!({
                "searxngUrl": searx.uri(),
                "q": "民法",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["provider"], "searxng");
        assert_eq!(body["results"][0]["title"], "e-Gov 民法");
    }

    #[tokio::test]
    async fn search_explains_json_disabled_403() {
        let searx = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/search"))
            .respond_with(ResponseTemplate::new(403).set_body_string("forbidden"))
            .mount(&searx)
            .await;

        let (status, body) = json_request(
            create_router(None),
            "POST",
            "/api/search",
            json!({
                "searxngUrl": searx.uri(),
                "q": "テスト",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        let error = body["error"].as_str().unwrap_or("");
        assert!(error.to_ascii_lowercase().contains("json"));
    }

    async fn json_get(app: Router, uri: &str) -> (StatusCode, Value) {
        let response = app
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, json)
    }

    fn argos_query(base: &str, extra: &[(&str, &str)]) -> String {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        serializer.append_pair("argosBaseUrl", base);
        for (key, value) in extra {
            serializer.append_pair(key, value);
        }
        format!("/api/argos/scopes?{}", serializer.finish())
    }

    struct ArgosSearchResponder;

    impl wiremock::Respond for ArgosSearchResponder {
        fn respond(&self, request: &MockRequest) -> ResponseTemplate {
            let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
            assert_eq!(body["query"], "民法 555条");
            assert_eq!(body["limit"], 8);
            assert_eq!(body["pathPrefixes"][0], "C:\\案件A");
            assert!(request.headers.get("authorization").is_none());
            ResponseTemplate::new(200).set_body_json(json!({
                "hits": [{
                    "title": "契約.md",
                    "path": "C:\\案件A\\契約.md",
                    "snippet": "民法第555条",
                    "previewText": "…"
                }]
            }))
        }
    }

    #[tokio::test]
    async fn health_checks_argos_loopback() {
        let mtplx = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": [{ "id": "qwen3.8-flash-next" }]
            })))
            .mount(&mtplx)
            .await;

        let argos = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/health"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "ok": true,
                "name": "argos"
            })))
            .mount(&argos)
            .await;

        let (status, body) = json_request(
            create_router(None),
            "POST",
            "/api/health",
            json!({
                "llmBaseUrl": format!("{}/v1", mtplx.uri()),
                "llmApiKey": "test-key",
                "argosBaseUrl": argos.uri(),
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["argos"]["ok"], true);
    }

    #[tokio::test]
    async fn argos_scopes_rewrites_localhost_and_maps_rows() {
        let argos = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/scopes"))
            .and(query_param("query", "受信"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "recent": [{ "path": "C:\\案件A", "label": "案件A", "isRoot": false }],
                "scopes": [{
                    "path": "mailfolder:user@firm / 受信トレイ",
                    "label": "受信トレイ（user@firm）",
                    "isRoot": true
                }]
            })))
            .mount(&argos)
            .await;

        let localhost = argos.uri().replace("127.0.0.1", "localhost");
        let (get_status, get_body) = json_get(
            create_router(None),
            &argos_query(&localhost, &[("query", "受信")]),
        )
        .await;
        assert_eq!(get_status, StatusCode::OK);
        assert_eq!(get_body["recent"][0]["path"], "C:\\案件A");

        let (status, body) = json_request(
            create_router(None),
            "POST",
            "/api/argos/scopes",
            json!({
                "argosBaseUrl": localhost,
                "query": "受信",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["recent"][0]["path"], "C:\\案件A");
        assert_eq!(body["recent"][0]["isRoot"], false);
        assert_eq!(
            body["scopes"][0]["path"],
            "mailfolder:user@firm / 受信トレイ"
        );
    }

    #[tokio::test]
    async fn argos_search_maps_path_and_snippet() {
        let argos = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/search"))
            .respond_with(ArgosSearchResponder)
            .mount(&argos)
            .await;

        let (status, body) = json_request(
            create_router(None),
            "POST",
            "/api/argos/search",
            json!({
                "argosBaseUrl": argos.uri(),
                "q": "民法 555条",
                "pathPrefixes": ["C:\\案件A"]
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["provider"], "argos");
        assert_eq!(body["results"][0]["title"], "契約.md");
        assert_eq!(body["results"][0]["url"], "C:\\案件A\\契約.md");
        assert_eq!(body["results"][0]["content"], "民法第555条");
    }

    #[tokio::test]
    async fn argos_file_returns_bytes_only_for_a_search_hit() {
        crate::indexed::clear();
        let dir = std::env::temp_dir().join(format!("guri-indexed-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("委託.txt");
        std::fs::write(&file_path, "ok").unwrap();
        let file_string = file_path.to_string_lossy().to_string();

        let (denied, denied_body) = json_request(
            create_router(None),
            "POST",
            "/api/argos/file",
            json!({ "path": file_string }),
        )
        .await;
        assert_eq!(denied, StatusCode::FORBIDDEN);
        assert!(denied_body["error"]
            .as_str()
            .unwrap_or("")
            .contains("検索結果に無い"));

        let argos = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "hits": [{ "title": "委託.txt", "path": file_string, "snippet": "ok" }]
            })))
            .mount(&argos)
            .await;
        let (search_status, _) = json_request(
            create_router(None),
            "POST",
            "/api/argos/search",
            json!({ "argosBaseUrl": argos.uri(), "q": "みなし" }),
        )
        .await;
        assert_eq!(search_status, StatusCode::OK);

        let (status, body) = json_request(
            create_router(None),
            "POST",
            "/api/argos/file",
            json!({ "path": file_string }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["name"], "委託.txt");
        assert_eq!(body["data"], "b2s=");

        let other = dir.join("..").join("秘密.txt");
        let (other_status, _) = json_request(
            create_router(None),
            "POST",
            "/api/argos/file",
            json!({ "path": other.to_string_lossy().to_string() }),
        )
        .await;
        assert_eq!(other_status, StatusCode::FORBIDDEN);
        crate::indexed::clear();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
