//! Read-only diagnostics for Codex plugin and browser integration health.
//!
//! Plugin registration remains owned by `codex_plugin_registry`. This module
//! only assembles that detector's result with checks performed by the bundled
//! Browser plugin scripts; it never edits Codex configuration or installs an
//! extension/native host.

use crate::codex_config::codex_cli_candidates;
use crate::config::get_home_dir;
use crate::services::codex_plugin_registry::{
    detect_codex_plugin_registration, RepairableCodexPlugin,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const BROWSER_PLUGIN_ID: &str = "browser@openai-bundled";

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexBrowserIntegrationHealth {
    pub plugin_installed: bool,
    pub plugin_enabled: bool,
    pub browser_family: Option<String>,
    pub browser_name: Option<String>,
    pub browser_installed: bool,
    pub browser_running: bool,
    pub extension_installed: bool,
    pub extension_enabled: bool,
    pub native_host_correct: bool,
    pub store_url: Option<String>,
    pub extension_management_url: Option<String>,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginHealthReport {
    pub repairable_plugins: Vec<RepairableCodexPlugin>,
    pub browser: CodexBrowserIntegrationHealth,
    pub diagnostics_error: Option<String>,
}

fn browser_cache_root() -> PathBuf {
    get_home_dir().join(".codex").join("plugins").join("cache")
}

fn run_command(mut command: Command) -> Result<Output, String> {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .output()
        .map_err(|error| format!("Failed to start diagnostic command: {error}"))
}

fn command_error(label: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("{label} failed with status {}", output.status)
    } else {
        format!("{label} failed: {stderr}")
    }
}

fn codex_plugin_list() -> Result<String, String> {
    let mut errors = Vec::new();
    for executable in codex_cli_candidates() {
        let mut command = Command::new(&executable);
        command.args(["plugin", "list"]);
        match run_command(command) {
            Ok(output) if output.status.success() => {
                return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
            }
            Ok(output) => errors.push(format!(
                "{}: {}",
                executable.display(),
                command_error("codex plugin list", &output)
            )),
            Err(error) => errors.push(format!("{}: {error}", executable.display())),
        }
    }
    Err(format!(
        "Codex plugin list could not be executed. {}",
        errors.join(" | ")
    ))
}

fn browser_plugin_status(text: &str) -> (bool, bool) {
    text.lines()
        .find(|line| line.trim_start().starts_with(BROWSER_PLUGIN_ID))
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            (lower.contains("installed"), lower.contains("enabled"))
        })
        .unwrap_or((false, false))
}

fn find_browser_plugin_root() -> Option<PathBuf> {
    let root = browser_cache_root().join("openai-bundled").join("browser");
    let mut versions = fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    versions.sort();
    versions.into_iter().rev().find(|path| {
        path.join("scripts").join("installed-browsers.js").is_file()
            && path
                .join("scripts")
                .join("check-extension-installed.js")
                .is_file()
    })
}

fn run_browser_script(root: &Path, script: &str, args: &[&str]) -> Result<Value, String> {
    let script_path = root.join("scripts").join(script);
    let mut command = Command::new("node");
    command.arg(&script_path).args(args).current_dir(root);
    let output = run_command(command)?;
    serde_json::from_slice(&output.stdout).map_err(|error| {
        if output.status.success() {
            format!("{script} returned invalid JSON: {error}")
        } else {
            command_error(script, &output)
        }
    })
}

fn browser_family_from_name(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    if lower.contains("brave") {
        Some("brave")
    } else if lower.contains("edge") {
        Some("edge")
    } else if lower.contains("chrome") || lower.contains("chromium") {
        Some("chrome")
    } else if lower.contains("vivaldi") {
        Some("vivaldi")
    } else if lower.contains("opera") {
        Some("opera")
    } else {
        None
    }
}

fn inspect_browser_integration(
    plugin_installed: bool,
    plugin_enabled: bool,
) -> Result<CodexBrowserIntegrationHealth, String> {
    let mut health = CodexBrowserIntegrationHealth {
        plugin_installed,
        plugin_enabled,
        ..Default::default()
    };
    if !plugin_installed {
        health.problems.push("browserPluginMissing".to_string());
    } else if !plugin_enabled {
        health.problems.push("browserPluginDisabled".to_string());
    }

    let root = find_browser_plugin_root()
        .ok_or_else(|| "Browser plugin diagnostic scripts are unavailable".to_string())?;
    let installed = run_browser_script(&root, "installed-browsers.js", &["--json"])?;
    let default_name = installed
        .pointer("/default_browser/schemes/https/name")
        .or_else(|| installed.pointer("/default_browser/schemes/http/name"))
        .and_then(Value::as_str);
    let selected = default_name
        .and_then(browser_family_from_name)
        .and_then(|family| {
            installed
                .get("installed_browsers")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().find(|item| {
                        item.get("name")
                            .and_then(Value::as_str)
                            .and_then(browser_family_from_name)
                            == Some(family)
                    })
                })
                .map(|item| (family, item))
        })
        .or_else(|| {
            installed
                .get("installed_browsers")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().find_map(|item| {
                        let name = item.get("name")?.as_str()?;
                        Some((browser_family_from_name(name)?, item))
                    })
                })
        });

    let Some((family, browser)) = selected else {
        health.problems.push("browserNotDetected".to_string());
        return Ok(health);
    };
    health.browser_family = Some(family.to_string());
    health.browser_name = browser
        .get("name")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    health.browser_installed = true;

    let running = run_browser_script(
        &root,
        "chrome-is-running.js",
        &["--browser", family, "--json"],
    )?;
    health.browser_running = running
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !health.browser_running {
        health.problems.push("browserNotRunning".to_string());
    }

    let extension = run_browser_script(
        &root,
        "check-extension-installed.js",
        &["--browser", family, "--json"],
    )?;
    health.extension_installed = extension
        .get("installed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    health.extension_enabled = extension
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !health.extension_installed {
        health.problems.push("browserExtensionMissing".to_string());
    } else if !health.extension_enabled {
        health.problems.push("browserExtensionDisabled".to_string());
    }

    let native_host = run_browser_script(
        &root,
        "check-native-host-manifest.js",
        &["--browser", family, "--json"],
    )?;
    health.native_host_correct = native_host
        .get("correct")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !health.native_host_correct {
        health.problems.push("nativeHostMissing".to_string());
    }

    let extension_config: Value = serde_json::from_slice(
        &fs::read(root.join("scripts").join("extension-ids.json"))
            .map_err(|error| format!("Failed to read browser extension metadata: {error}"))?,
    )
    .map_err(|error| format!("Failed to parse browser extension metadata: {error}"))?;
    if let Some(config) = extension_config
        .get("browserDiagnostics")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("browserFamily").and_then(Value::as_str) == Some(family))
        })
    {
        health.store_url = config
            .get("storeUrl")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        health.extension_management_url = config
            .get("extensionManagementUrl")
            .and_then(Value::as_str)
            .map(ToString::to_string);
    }

    Ok(health)
}

pub fn inspect_codex_plugin_health() -> CodexPluginHealthReport {
    let mut diagnostics_error = None;
    let repairable_plugins = match detect_codex_plugin_registration() {
        Ok(plugins) => plugins,
        Err(error) => {
            diagnostics_error = Some(error);
            Vec::new()
        }
    };

    let browser = match codex_plugin_list()
        .map(|output| browser_plugin_status(&output))
        .and_then(|(installed, enabled)| inspect_browser_integration(installed, enabled))
    {
        Ok(browser) => browser,
        Err(error) => {
            diagnostics_error = Some(match diagnostics_error {
                Some(existing) => format!("{existing}; {error}"),
                None => error,
            });
            CodexBrowserIntegrationHealth {
                problems: vec!["diagnosticsFailed".to_string()],
                ..Default::default()
            }
        }
    };

    CodexPluginHealthReport {
        repairable_plugins,
        browser,
        diagnostics_error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_installed_enabled_browser_plugin() {
        let output = "browser@openai-bundled  installed, enabled  1.2.3";
        assert_eq!(browser_plugin_status(output), (true, true));
        assert_eq!(
            browser_plugin_status("chrome@openai-bundled not installed"),
            (false, false)
        );
    }

    #[test]
    fn maps_supported_chromium_browser_names() {
        assert_eq!(browser_family_from_name("Brave Browser"), Some("brave"));
        assert_eq!(browser_family_from_name("Microsoft Edge"), Some("edge"));
        assert_eq!(browser_family_from_name("Google Chrome"), Some("chrome"));
        assert_eq!(browser_family_from_name("Firefox"), None);
    }
}
