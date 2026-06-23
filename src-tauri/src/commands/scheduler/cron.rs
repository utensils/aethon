use std::collections::HashSet;

use chrono::{Datelike, Local, TimeZone, Timelike};

pub(super) fn cron_next_run(expression: &str, after_ms: i64) -> Option<i64> {
    let spec = CronSpec::parse(expression).ok()?;
    let base = Local.timestamp_millis_opt(after_ms).single()?;
    let mut cursor = base
        .with_second(0)?
        .with_nanosecond(0)?
        .checked_add_signed(chrono::Duration::minutes(1))?;
    for _ in 0..(7 * 24 * 60) {
        if spec.matches(cursor) {
            return Some(cursor.timestamp_millis());
        }
        cursor = cursor.checked_add_signed(chrono::Duration::minutes(1))?;
    }
    None
}

#[derive(Debug, PartialEq, Eq)]
struct CronSpec {
    minutes: HashSet<u32>,
    hours: HashSet<u32>,
    days: HashSet<u32>,
    months: HashSet<u32>,
    weekdays: HashSet<u32>,
}

impl CronSpec {
    fn parse(expression: &str) -> Result<Self, String> {
        let parts: Vec<_> = expression.split_whitespace().collect();
        if parts.len() != 5 {
            return Err("cron must have 5 fields".to_string());
        }
        Ok(Self {
            minutes: parse_cron_field(parts[0], 0, 59, false)?,
            hours: parse_cron_field(parts[1], 0, 23, false)?,
            days: parse_cron_field(parts[2], 1, 31, false)?,
            months: parse_cron_field(parts[3], 1, 12, false)?,
            weekdays: parse_cron_field(parts[4], 0, 7, true)?,
        })
    }

    fn matches<Tz: chrono::TimeZone>(&self, dt: chrono::DateTime<Tz>) -> bool {
        let weekday = dt.weekday().num_days_from_sunday();
        self.minutes.contains(&dt.minute())
            && self.hours.contains(&dt.hour())
            && self.days.contains(&dt.day())
            && self.months.contains(&dt.month())
            && self.weekdays.contains(&weekday)
    }
}

fn parse_cron_field(
    field: &str,
    min: u32,
    max: u32,
    weekday: bool,
) -> Result<HashSet<u32>, String> {
    let mut out = HashSet::new();
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err("empty cron field part".to_string());
        }
        let (range, step) = if let Some((range, step)) = part.split_once('/') {
            let step = step
                .parse::<u32>()
                .map_err(|_| "invalid cron step".to_string())?;
            if step == 0 {
                return Err("cron step must be positive".to_string());
            }
            (range, step)
        } else {
            (part, 1)
        };
        let (start, end) = if range == "*" {
            (min, max)
        } else if let Some((start, end)) = range.split_once('-') {
            (
                parse_cron_value(start, min, max)?,
                parse_cron_value(end, min, max)?,
            )
        } else {
            let value = parse_cron_value(range, min, max)?;
            (value, value)
        };
        if start > end {
            return Err("cron range start exceeds end".to_string());
        }
        let mut value = start;
        while value <= end {
            out.insert(if weekday && value == 7 { 0 } else { value });
            match value.checked_add(step) {
                Some(next) => value = next,
                None => break,
            }
        }
    }
    if out.is_empty() {
        return Err("cron field matched no values".to_string());
    }
    Ok(out)
}

fn parse_cron_value(value: &str, min: u32, max: u32) -> Result<u32, String> {
    let parsed = value
        .parse::<u32>()
        .map_err(|_| format!("invalid cron value: {value}"))?;
    if parsed < min || parsed > max {
        return Err(format!("cron value out of range: {parsed}"));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cron_field_parses_steps_ranges_and_sunday_alias() {
        let spec = CronSpec::parse("*/15 9-17 * * 0,7").unwrap();
        assert!(spec.minutes.contains(&0));
        assert!(spec.minutes.contains(&45));
        assert!(spec.hours.contains(&9));
        assert!(spec.hours.contains(&17));
        assert!(spec.weekdays.contains(&0));
    }

    #[test]
    fn cron_rejects_bad_expression() {
        assert!(CronSpec::parse("* * *").is_err());
        assert!(CronSpec::parse("*/0 * * * *").is_err());
        assert!(CronSpec::parse("61 * * * *").is_err());
    }
}
