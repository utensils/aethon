use super::*;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct VoiceSettingsData {
    settings: std::collections::BTreeMap<String, String>,
}

pub struct VoiceSettings {
    path: PathBuf,
    data: Mutex<VoiceSettingsData>,
}

impl VoiceSettings {
    pub fn open(path: &Path) -> Result<Self, String> {
        let data = match std::fs::read_to_string(path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => VoiceSettingsData::default(),
            Err(err) => return Err(format!("read {}: {err}", path.display())),
        };
        Ok(Self {
            path: path.to_path_buf(),
            data: Mutex::new(data),
        })
    }

    pub fn get_app_setting(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.data.lock().settings.get(key).cloned())
    }

    pub fn set_app_setting(&self, key: &str, value: &str) -> Result<(), String> {
        {
            let mut data = self.data.lock();
            data.settings.insert(key.to_string(), value.to_string());
            self.persist_locked(&data)?;
        }
        Ok(())
    }

    pub fn delete_app_setting(&self, key: &str) -> Result<(), String> {
        {
            let mut data = self.data.lock();
            data.settings.remove(key);
            self.persist_locked(&data)?;
        }
        Ok(())
    }

    fn persist_locked(&self, data: &VoiceSettingsData) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let raw = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, raw).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path)
            .map_err(|e| format!("rename {}: {e}", self.path.display()))
    }
}
