use super::super::{send_codex_request_with_rate_limit_retry, ProxyResponse};
use super::safe_test_codex_traffic_policy;
use crate::proxy::error::ProxyError;
use crate::proxy::providers::streaming_retry::{
    create_resilient_responses_sse_stream, ByteStream, StreamReconnector,
    CAPACITY_RETRY_LONG_DELAY, STREAM_MAX_RETRIES,
};
use bytes::Bytes;
use futures::{stream, StreamExt};
use http::{HeaderMap, StatusCode};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

fn created_response_event() -> Bytes {
    Bytes::from_static(
        b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_retry\"}}\n\n",
    )
}

fn one_chunk(chunk: Bytes) -> ByteStream {
    Box::pin(stream::iter(vec![Ok::<Bytes, std::io::Error>(chunk)]))
}

fn one_chunk_then_error(chunk: Bytes) -> ByteStream {
    Box::pin(stream::iter(vec![
        Ok::<Bytes, std::io::Error>(chunk),
        Err(std::io::Error::other("mock transport drop")),
    ]))
}

fn capacity_failure_response() -> ProxyResponse {
    ProxyResponse::streamed(
        StatusCode::OK,
        HeaderMap::new(),
        stream::iter(vec![Ok::<Bytes, std::io::Error>(Bytes::from_static(
            b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_retry\"}}\n\nevent: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"type\":\"server_error\",\"message\":\"We're currently experiencing high demand\"}}}\n\n",
        ))]),
    )
}

fn empty_success_response() -> ProxyResponse {
    ProxyResponse::streamed(
        StatusCode::OK,
        HeaderMap::new(),
        stream::empty::<Result<Bytes, std::io::Error>>(),
    )
}

#[tokio::test(start_paused = true)]
async fn stream_retry_budget_clamps_callers_to_five_attempts() {
    let reconnect_calls = Arc::new(AtomicUsize::new(0));
    let reconnect_calls_for_factory = reconnect_calls.clone();
    let reconnector = StreamReconnector::new(
        Box::new(move || {
            reconnect_calls_for_factory.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok::<ProxyResponse, ProxyError>(empty_success_response()) })
        }),
        Duration::ZERO,
    )
    .with_max_retries(10);

    let output = create_resilient_responses_sse_stream(
        one_chunk(created_response_event()),
        Some(reconnector),
    )
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .filter_map(Result::ok)
    .fold(String::new(), |mut output, chunk| {
        output.push_str(&String::from_utf8_lossy(&chunk));
        output
    });

    assert_eq!(
        STREAM_MAX_RETRIES, 5,
        "ordinary stream retry budget must remain five"
    );
    assert_eq!(
        STREAM_MAX_RETRIES, 5,
        "capacity retries must share the ordinary stream budget"
    );
    assert_eq!(
        reconnect_calls.load(Ordering::SeqCst),
        5,
        "a caller-provided ten-retry budget must be clamped to five"
    );
    assert!(
        output.contains("\"code\":\"stream_error\""),
        "the sixth failure must surface a terminal stream error: {output}"
    );
}

#[tokio::test(start_paused = true)]
async fn mixed_transport_and_capacity_failures_share_one_five_retry_budget() {
    let reconnect_calls = Arc::new(AtomicUsize::new(0));
    let reconnect_calls_for_factory = reconnect_calls.clone();
    let reconnector = StreamReconnector::new(
        Box::new(move || {
            reconnect_calls_for_factory.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok::<ProxyResponse, ProxyError>(capacity_failure_response()) })
        }),
        Duration::ZERO,
    )
    .with_max_retries(10)
    .with_capacity_retry(true);

    let output = create_resilient_responses_sse_stream(
        one_chunk_then_error(created_response_event()),
        Some(reconnector),
    )
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .filter_map(Result::ok)
    .fold(String::new(), |mut output, chunk| {
        output.push_str(&String::from_utf8_lossy(&chunk));
        output
    });

    assert_eq!(
        reconnect_calls.load(Ordering::SeqCst),
        usize::try_from(STREAM_MAX_RETRIES).unwrap(),
        "the initial transport retry and later capacity retries must share one budget"
    );
    assert!(
        output.contains("\"code\":\"capacity_retry_exhausted\""),
        "the sixth total retry must not be attempted: {output}"
    );
}

#[tokio::test(start_paused = true)]
async fn capacity_api_retries_high_demand_at_most_five_times() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let attempts_for_send = attempts.clone();
    let started_at = tokio::time::Instant::now();

    let result = send_codex_request_with_rate_limit_retry(
        "retry-policy-test",
        true,
        safe_test_codex_traffic_policy(),
        move || {
            let attempts = attempts_for_send.clone();
            async move {
                attempts.fetch_add(1, Ordering::SeqCst);
                Ok(ProxyResponse::buffered(
                    StatusCode::SERVICE_UNAVAILABLE,
                    HeaderMap::new(),
                    Bytes::from_static(
                        br#"{"error":{"type":"server_error","message":"We're currently experiencing high demand"}}"#,
                    ),
                ))
            }
        },
    )
    .await
    .expect("capacity exhaustion should be returned as the final upstream response");

    assert_eq!(result.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        attempts.load(Ordering::SeqCst),
        usize::try_from(STREAM_MAX_RETRIES).unwrap() + 1,
        "five retries means six total mocked API calls"
    );
    assert_eq!(
        tokio::time::Instant::now() - started_at,
        CAPACITY_RETRY_LONG_DELAY * STREAM_MAX_RETRIES,
        "each explicit high-demand retry must wait ten minutes"
    );
}

#[tokio::test(start_paused = true)]
async fn capacity_api_retries_concurrent_limit_then_recovers_after_ten_minutes() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let attempts_for_send = attempts.clone();
    let started_at = tokio::time::Instant::now();

    let result = send_codex_request_with_rate_limit_retry(
        "retry-policy-test",
        true,
        safe_test_codex_traffic_policy(),
        move || {
            let attempts = attempts_for_send.clone();
            async move {
                if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    Ok(ProxyResponse::buffered(
                        StatusCode::TOO_MANY_REQUESTS,
                        HeaderMap::new(),
                        Bytes::from_static(
                            br#"{"error":{"type":"rate_limit_exceeded","message":"concurrent limit reached"}}"#,
                        ),
                    ))
                } else {
                    Ok(ProxyResponse::buffered(
                        StatusCode::OK,
                        HeaderMap::new(),
                        Bytes::new(),
                    ))
                }
            }
        },
    )
    .await
    .expect("concurrent-limit retry should recover");

    assert_eq!(result.status(), StatusCode::OK);
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    assert_eq!(
        tokio::time::Instant::now() - started_at,
        CAPACITY_RETRY_LONG_DELAY,
        "explicit concurrent-limit responses use the ten-minute tier"
    );
}
