use chrono::{DateTime, Duration, Local, LocalResult, TimeZone, Utc};
use serde_json::Value;

const CHATGPT_SOURCE: &str = "chatgpt-web";

pub fn number_field(value: &Value, key: &str) -> f64 {
    match value.get(key) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

pub fn computed_total(bucket: &Value, include_cache: bool) -> f64 {
    let base = number_field(bucket, "inputTokens")
        + number_field(bucket, "outputTokens")
        + number_field(bucket, "reasoningOutputTokens");
    if include_cache {
        base + number_field(bucket, "cachedInputTokens")
    } else {
        base
    }
}

pub fn tray_tokens(bucket: &Value, include_cache: bool) -> f64 {
    computed_total(bucket, include_cache)
}

pub fn include_source(source: &str, include_chatgpt: bool) -> bool {
    if source == CHATGPT_SOURCE {
        include_chatgpt
    } else {
        true
    }
}

pub fn format_compact_tokens(n: f64) -> String {
    let value = if n.is_finite() { n.max(0.0) } else { 0.0 };
    if value >= 1_000_000.0 {
        format!("{:.1}M", value / 1_000_000.0)
    } else if value >= 1_000.0 {
        format!("{:.0}K", value / 1_000.0)
    } else {
        format!("{}", value.round() as i64)
    }
}

pub fn today_window(now: DateTime<Local>) -> (DateTime<Local>, DateTime<Local>) {
    let start_naive = now.date_naive().and_hms_opt(0, 0, 0).unwrap_or(now.naive_local());
    let start = match Local.from_local_datetime(&start_naive) {
        LocalResult::Single(dt) => dt,
        LocalResult::Ambiguous(a, _) => a,
        LocalResult::None => now,
    };
    (start, start + Duration::days(1))
}

fn parse_instant(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

pub fn in_today(bucket_start: &str, now: DateTime<Local>) -> bool {
    let Some(instant) = parse_instant(bucket_start) else {
        return false;
    };
    let (start, end) = today_window(now);
    let start_utc = start.with_timezone(&Utc);
    let end_utc = end.with_timezone(&Utc);
    instant >= start_utc && instant < end_utc
}

pub fn tray_label(
    buckets: &[Value],
    include_chatgpt: bool,
    include_cache: bool,
    now: DateTime<Local>,
) -> String {
    let total: f64 = buckets
        .iter()
        .filter(|bucket| {
            let source = bucket.get("source").and_then(Value::as_str).unwrap_or("");
            let hostname = bucket.get("hostname").and_then(Value::as_str).unwrap_or("");
            hostname != "cursor-cloud"
                && include_source(source, include_chatgpt)
                && bucket
                    .get("bucketStart")
                    .and_then(Value::as_str)
                    .map(|start| in_today(start, now))
                    .unwrap_or(false)
        })
        .map(|bucket| tray_tokens(bucket, include_cache))
        .sum();
    format_compact_tokens(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    #[test]
    fn compact_tokens_matches_tray_example() {
        assert_eq!(format_compact_tokens(1_200_000.0), "1.2M");
        assert_eq!(format_compact_tokens(12_400.0), "12K");
        assert_eq!(format_compact_tokens(0.0), "0");
    }

    #[test]
    fn tray_label_uses_today_and_toggle() {
        let now = Local.with_ymd_and_hms(2026, 9, 9, 15, 30, 0).unwrap();
        let (start, _) = today_window(now);
        let today = start.with_timezone(&Utc).to_rfc3339();
        let yesterday = (start - Duration::days(1))
            .with_timezone(&Utc)
            .to_rfc3339();
        let buckets = vec![
            json!({
                "source": "cursor",
                "bucketStart": today,
                "inputTokens": 1_000_000,
                "outputTokens": 200_000,
                "cachedInputTokens": 0,
                "reasoningOutputTokens": 0
            }),
            json!({
                "source": "chatgpt-web",
                "bucketStart": today,
                "inputTokens": 800_000,
                "outputTokens": 0,
                "cachedInputTokens": 0,
                "reasoningOutputTokens": 0
            }),
            json!({
                "source": "cursor",
                "bucketStart": yesterday,
                "inputTokens": 9_000_000,
                "outputTokens": 0,
                "cachedInputTokens": 0,
                "reasoningOutputTokens": 0
            }),
        ];
        assert_eq!(tray_label(&buckets, true, false, now), "2.0M");
        assert_eq!(tray_label(&buckets, false, false, now), "1.2M");
    }

    #[test]
    fn tray_label_includes_cache_when_asked() {
        let now = Local.with_ymd_and_hms(2026, 9, 9, 15, 30, 0).unwrap();
        let (start, _) = today_window(now);
        let today = start.with_timezone(&Utc).to_rfc3339();
        let buckets = vec![json!({
            "source": "cursor",
            "bucketStart": today,
            "inputTokens": 1_000_000,
            "outputTokens": 200_000,
            "cachedInputTokens": 800_000,
            "reasoningOutputTokens": 0
        })];
        assert_eq!(tray_label(&buckets, true, false, now), "1.2M");
        assert_eq!(tray_label(&buckets, true, true, now), "2.0M");
    }

    #[test]
    fn tray_label_drops_cursor_cloud_rows() {
        let now = Local.with_ymd_and_hms(2026, 9, 9, 15, 30, 0).unwrap();
        let (start, _) = today_window(now);
        let today = start.with_timezone(&Utc).to_rfc3339();
        let buckets = vec![
            json!({
                "source": "cursor",
                "hostname": "Huffies-Mac-mini",
                "bucketStart": today,
                "inputTokens": 1_200_000,
                "outputTokens": 0,
                "cachedInputTokens": 0,
                "reasoningOutputTokens": 0
            }),
            json!({
                "source": "cursor",
                "hostname": "cursor-cloud",
                "bucketStart": today,
                "inputTokens": 9_000_000,
                "outputTokens": 0,
                "cachedInputTokens": 0,
                "reasoningOutputTokens": 0
            }),
        ];
        assert_eq!(tray_label(&buckets, true, false, now), "1.2M");
    }
}
