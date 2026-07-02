//! Wire protocol v1 for the remote-gateway WebSocket.
//!
//! One JSON text frame per message, discriminated by `t`. The client's
//! first frame must be `hello` (5s deadline, enforced in `ws.rs`);
//! everything after authentication is `invoke` (request/response by
//! client-chosen correlation id, mapping 1:1 onto Tauri commands plus
//! the `ui.*` forwards) and `sub`/`unsub` (topic = Tauri event name).
//! Server events carry the Tauri payload verbatim so a client parses it
//! exactly the way the desktop webview's `listen` callback would.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;

use crate::commands::host::HostInfo;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ClientFrame {
    Hello {
        protocol: u32,
        token: String,
        /// Informational — identity comes from the token.
        #[serde(default)]
        device_id: Option<String>,
        #[serde(default)]
        app_version: Option<String>,
    },
    Invoke {
        id: String,
        cmd: String,
        #[serde(default)]
        args: Value,
    },
    Sub {
        topics: Vec<String>,
    },
    Unsub {
        topics: Vec<String>,
    },
}

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ServerFrame {
    HelloOk {
        protocol: u32,
        host: HostInfo,
        device_id: String,
        app_version: String,
    },
    Result {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Event {
        topic: String,
        seq: u64,
        /// Raw JSON, embedded verbatim (no re-encode round trip).
        payload: Box<RawValue>,
    },
    Bye {
        reason: String,
    },
}

impl ServerFrame {
    pub fn result_ok(id: String, data: Value) -> Self {
        ServerFrame::Result {
            id,
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn result_err(id: String, error: String) -> Self {
        ServerFrame::Result {
            id,
            ok: false,
            data: None,
            error: Some(error),
        }
    }

    pub fn bye(reason: &str) -> Self {
        ServerFrame::Bye {
            reason: reason.to_string(),
        }
    }

    /// Serialize to the wire text. Infallible by construction (no maps
    /// with non-string keys, no NaN); a failure would be a programming
    /// error surfaced as a close.
    pub fn wire(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| format!("serialize frame: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_frames_parse_from_documented_shapes() {
        let hello: ClientFrame = serde_json::from_str(
            r#"{"t":"hello","protocol":1,"deviceId":"dev-1","token":"tok","appVersion":"0.1"}"#,
        )
        .unwrap();
        match hello {
            ClientFrame::Hello {
                protocol,
                token,
                device_id,
                app_version,
            } => {
                assert_eq!(protocol, 1);
                assert_eq!(token, "tok");
                assert_eq!(device_id.as_deref(), Some("dev-1"));
                assert_eq!(app_version.as_deref(), Some("0.1"));
            }
            _ => panic!("expected hello"),
        }

        let invoke: ClientFrame =
            serde_json::from_str(r#"{"t":"invoke","id":"i-1","cmd":"host_info"}"#).unwrap();
        match invoke {
            ClientFrame::Invoke { id, cmd, args } => {
                assert_eq!(id, "i-1");
                assert_eq!(cmd, "host_info");
                assert!(args.is_null());
            }
            _ => panic!("expected invoke"),
        }

        let sub: ClientFrame =
            serde_json::from_str(r#"{"t":"sub","topics":["agent-response"]}"#).unwrap();
        assert!(matches!(sub, ClientFrame::Sub { topics } if topics == ["agent-response"]));
    }

    #[test]
    fn server_frames_serialize_with_camel_case_tags() {
        let ok = ServerFrame::result_ok("i-1".into(), serde_json::json!({"a": 1}))
            .wire()
            .unwrap();
        assert_eq!(ok, r#"{"t":"result","id":"i-1","ok":true,"data":{"a":1}}"#);

        let err = ServerFrame::result_err("i-2".into(), "denied: nope".into())
            .wire()
            .unwrap();
        assert_eq!(
            err,
            r#"{"t":"result","id":"i-2","ok":false,"error":"denied: nope"}"#
        );

        let bye = ServerFrame::bye("revoked").wire().unwrap();
        assert_eq!(bye, r#"{"t":"bye","reason":"revoked"}"#);
    }

    #[test]
    fn event_frame_embeds_payload_verbatim() {
        let raw = RawValue::from_string(r#""{\"type\":\"ready\"}""#.to_string()).unwrap();
        let event = ServerFrame::Event {
            topic: "agent-response".into(),
            seq: 7,
            payload: raw,
        }
        .wire()
        .unwrap();
        assert_eq!(
            event,
            r#"{"t":"event","topic":"agent-response","seq":7,"payload":"{\"type\":\"ready\"}"}"#
        );
    }
}
