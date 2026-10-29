//! User configuration stored at `$XDG_CONFIG_HOME/hyde-ai/config.toml`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub ai: AiConfig,
    pub ui: UiConfig,
    pub code: CodeConfig,
}

/// Settings for the Hyde Code bridge.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct CodeConfig {
    /// Hyde Code project id used when a request doesn't name one.
    pub default_project: String,
    /// Desktop notifications when an agent asks something, needs approval or opens a PR.
    pub notify: bool,
}

impl Default for CodeConfig {
    fn default() -> Self {
        Self {
            default_project: String::new(),
            notify: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AiConfig {
    /// When true, requests the rules engine cannot handle are sent to the AI engine.
    pub enabled: bool,
    /// Preset id from `llm::PROVIDERS`, or `custom`.
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct UiConfig {
    pub port: u16,
    pub open_browser: bool,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "omniroute".into(),
            base_url: "http://localhost:20128/v1".into(),
            api_key: String::new(),
            model: String::new(),
        }
    }
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            port: 7878,
            open_browser: true,
        }
    }
}

impl AiConfig {
    /// The engine is usable once it has an endpoint and a model.
    pub fn is_ready(&self) -> bool {
        self.enabled && !self.base_url.trim().is_empty() && !self.model.trim().is_empty()
    }
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home_dir().join(".config"))
        .join("hyde-ai")
}

pub fn state_dir() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home_dir().join(".local/state"))
        .join("hyde-ai")
}

fn config_path() -> PathBuf {
    config_dir().join("config.toml")
}

impl Config {
    pub fn load() -> Self {
        match fs::read_to_string(config_path()) {
            Ok(text) => toml::from_str(&text).unwrap_or_else(|error| {
                eprintln!("hyde: ignoring invalid config ({error}); using defaults");
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let dir = config_dir();
        fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
        let text = toml::to_string_pretty(self).map_err(|error| error.to_string())?;
        let path = config_path();
        let tmp = path.with_extension("toml.tmp");
        fs::write(&tmp, text).map_err(|error| format!("{}: {error}", tmp.display()))?;
        // The file can hold an API key, so keep it private to the user.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        fs::rename(&tmp, &path).map_err(|error| format!("{}: {error}", path.display()))
    }
}
