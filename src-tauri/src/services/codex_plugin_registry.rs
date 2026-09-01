//! Diagnose Codex plugin registration and Chromium browser integration.
//!
//! Personal plugin repairs use the public Codex CLI marketplace commands. The
//! browser integration path is intentionally diagnostic-only: the Browser
//! plugin owns its extension and native-host installer.

use crate::codex_config::get_codex_config_path;
use crate::config::{atomic_write, get_home_dir, path_is_within};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use toml_edit::{DocumentMut, Item};
use uuid::Uuid;

const PERSONAL_MARKETPLACE: &str = "personal";
const BROWSER_PLUGIN_ID: &str = "browser@openai-bundled";
#[cfg(test)]
const BROWSER_EXTENSION_IDS: [&str; 2] = [
    "hehggadaopoacecdllhhajmbjkdcmajg",
    "odlomjlbamekndcpllcnffbgeohgkmjh",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexPluginRepairAction {
    RegisterMarketplace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairableCodexPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub manifest_path: String,
    pub source_path: String,
    pub repair_action: CodexPluginRepairAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

impl Default for CodexBrowserIntegrationHealth {
    fn default() -> Self {
        Self {
            plugin_installed: false,
            plugin_enabled: false,
            browser_family: None,
            browser_name: None,
            browser_installed: false,
            browser_running: false,
            extension_installed: false,
            extension_enabled: false,
            native_host_correct: false,
            store_url: None,
            extension_management_url: None,
            problems: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginHealthReport {
    pub repairable_plugins: Vec<RepairableCodexPlugin>,
    pub browser: CodexBrowserIntegrationHealth,
    pub diagnostics_error: Option<String>,
}

#[derive(Debug, Clone)]
struct PluginManifest {
    name: String,
    version: String,
    manifest_path: PathBuf,
    source_path: PathBuf,
}

fn codex_plugin_cache_root() -> PathBuf {
    get_home_dir().join(".codex").join("plugins").join("cache")
}

fn managed_marketplace_root() -> PathBuf {
    get_home_dir()
        .join(".cc-switch")
        .join("codex-plugin-marketplaces")
        .join(PERSONAL_MARKETPLACE)
}

fn read_codex_config() -> Result<DocumentMut, String> {
    let path = get_codex_config_path();
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(format!("Failed to read Codex config.toml: {error}")),
    };
    if bytes.is_empty() {
        return Ok(DocumentMut::new());
    }
    String::from_utf8(bytes)
        .map_err(|error| format!("Codex config.toml is not UTF-8: {error}"))?
        .parse::<DocumentMut>()
        .map_err(|error| format!("Failed to parse Codex config.toml: {error}"))
}

fn enabled_personal_plugins(document: &DocumentMut) -> Result<Vec<(String, String)>, String> {
    let Some(plugins) = document.get("plugins") else {
        return Ok(Vec::new());
    };
    let Some(plugins) = plugins.as_table_like() else {
        return Err("Codex [plugins] must be a table".to_string());
    };
    let mut enabled = Vec::new();
    for (id, entry) in plugins.iter() {
        let Some(table) = entry.as_table_like() else {
            continue;
        };
        if table.get("enabled").and_then(Item::as_bool) != Some(true) {
            continue;
        }
        let Some((name, marketplace)) = id.rsplit_once('@') else {
            continue;
        };
        if marketplace == PERSONAL_MARKETPLACE && !name.trim().is_empty() {
            enabled.push((id.to_string(), name.trim().to_string()));
        }
    }
    Ok(enabled)
}

fn discover_manifest_paths(root: &Path, depth: usize, output: &mut Vec<PathBuf>) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            discover_manifest_paths(&path, depth + 1, output);
        } else if path.file_name().and_then(|name| name.to_str()) == Some("plugin.json") {
            output.push(path);
        }
    }
}

fn manifest_source_path(manifest_path: &Path) -> Option<PathBuf> {
    let parent = manifest_path.parent()?;
    match parent.file_name().and_then(|name| name.to_str()) {
        Some(".codex-plugin" | ".claude-plugin") => parent.parent().map(Path::to_path_buf),
        _ => Some(parent.to_path_buf()),
    }
}

fn read_manifest(path: &Path) -> Option<PluginManifest> {
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let name = value.get("name")?.as_str()?.trim().to_string();
    let version = value
        .get("version")
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    if name.is_empty() || version.is_empty() {
        return None;
    }
    Some(PluginManifest {
        name,
        version,
        manifest_path: path.to_path_buf(),
        source_path: manifest_source_path(path)?,
    })
}

fn latest_personal_manifest(name: &str) -> Option<PluginManifest> {
    let personal_root = codex_plugin_cache_root().join(PERSONAL_MARKETPLACE);
    let mut paths = Vec::new();
    discover_manifest_paths(&personal_root, 0, &mut paths);
    paths
        .iter()
        .filter_map(|path| read_manifest(path))
        .filter(|manifest| manifest.name == name)
        .max_by(|left, right| left.version.cmp(&right.version))
}

fn configure_background_command(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn run_command(mut command: Command) -> Result<Output, String> {
    configure_background_command(&mut command);
    command.output().map_err(|error| {
        format!(
            "Failed to start {}: {error}",
            command.get_program().to_string_lossy()
        )
    })
}

fn command_error(label: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = stderr.trim();
    if message.is_empty() {
        format!("{label} exited with status {}", output.status)
    } else {
        format!("{label} failed: {message}")
    }
}

fn codex_command(args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("codex");
    command.args(args);
    run_command(command)
}

fn codex_marketplaces() -> Result<Vec<(String, PathBuf)>, String> {
    let output = codex_command(&["plugin", "marketplace", "list", "--json"])?;
    if !output.status.success() {
        return Err(command_error("codex plugin marketplace list", &output));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("codex plugin marketplace list returned invalid JSON: {error}"))?;
    Ok(value
        .get("marketplaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some((
                item.get("name")?.as_str()?.to_string(),
                PathBuf::from(item.get("root")?.as_str()?),
            ))
        })
        .collect())
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

fn codex_browser_plugin_status() -> Result<(bool, bool), String> {
    let output = codex_command(&["plugin", "list"])?;
    if !output.status.success() {
        return Err(command_error("codex plugin list", &output));
    }
    Ok(browser_plugin_status(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

fn find_browser_plugin_root() -> Option<PathBuf> {
    let root = codex_plugin_cache_root()
        .join("openai-bundled")
        .join("browser");
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

fn detect_repairable_personal_plugins(
    enabled: Vec<(String, String)>,
    marketplaces: &[(String, PathBuf)],
) -> Vec<RepairableCodexPlugin> {
    let registered = marketplaces
        .iter()
        .find(|(name, _)| name == PERSONAL_MARKETPLACE);
    enabled
        .into_iter()
        .filter_map(|(id, name)| {
            let manifest = latest_personal_manifest(&name)?;
            if let Some((_, root)) = registered {
                let marketplace_path = root
                    .join(".agents")
                    .join("plugins")
                    .join("marketplace.json");
                let value = fs::read(&marketplace_path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                let contains_plugin = value
                    .as_ref()
                    .and_then(|value| value.get("plugins"))
                    .and_then(Value::as_array)
                    .is_some_and(|plugins| {
                        plugins.iter().any(|plugin| {
                            plugin.get("name").and_then(Value::as_str) == Some(name.as_str())
                        })
                    });
                if contains_plugin {
                    return None;
                }
            }
            Some(RepairableCodexPlugin {
                id,
                name: manifest.name,
                version: manifest.version,
                manifest_path: manifest.manifest_path.to_string_lossy().to_string(),
                source_path: manifest.source_path.to_string_lossy().to_string(),
                repair_action: CodexPluginRepairAction::RegisterMarketplace,
            })
        })
        .collect()
}

pub fn inspect_codex_plugin_health() -> CodexPluginHealthReport {
    let mut diagnostics_error = None;
    let repairable_plugins = match (read_codex_config(), codex_marketplaces()) {
        (Ok(config), Ok(marketplaces)) => enabled_personal_plugins(&config)
            .map(|enabled| detect_repairable_personal_plugins(enabled, &marketplaces))
            .unwrap_or_else(|error| {
                diagnostics_error = Some(error);
                Vec::new()
            }),
        (Err(error), _) | (_, Err(error)) => {
            diagnostics_error = Some(error);
            Vec::new()
        }
    };

    let browser = match codex_browser_plugin_status()
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

fn copy_plugin_tree(source: &Path, destination: &Path, cache_root: &Path) -> Result<(), String> {
    let canonical_source = fs::canonicalize(source)
        .map_err(|error| format!("Plugin source is unavailable: {error}"))?;
    let canonical_cache = fs::canonicalize(cache_root)
        .map_err(|error| format!("Codex plugin cache is unavailable: {error}"))?;
    if !path_is_within(&canonical_cache, &canonical_source) {
        return Err("Plugin source must stay inside the Codex plugin cache".to_string());
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("Failed to create managed plugin directory: {error}"))?;
    for entry in fs::read_dir(&canonical_source)
        .map_err(|error| format!("Failed to read cached plugin: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Failed to read cached plugin entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect cached plugin entry: {error}"))?;
        let target = destination.join(entry.file_name());
        if file_type.is_symlink() {
            return Err("Cached plugins containing symbolic links cannot be repaired".to_string());
        }
        if file_type.is_dir() {
            copy_plugin_tree(&entry.path(), &target, &canonical_cache)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)
                .map_err(|error| format!("Failed to copy cached plugin file: {error}"))?;
        }
    }
    Ok(())
}

fn marketplace_entry(name: &str, relative_path: &str) -> Value {
    json!({
        "name": name,
        "source": {
            "source": "local",
            "path": relative_path
        },
        "policy": {
            "installation": "AVAILABLE",
            "authentication": "ON_INSTALL"
        },
        "category": "Developer Tools"
    })
}

fn write_managed_marketplace(manifest: &PluginManifest) -> Result<PathBuf, String> {
    let root = managed_marketplace_root();
    let relative = format!("./plugins/{}/{}", manifest.name, manifest.version);
    let destination = root
        .join("plugins")
        .join(&manifest.name)
        .join(&manifest.version);
    if !destination.exists() {
        let staging = root
            .join("plugins")
            .join(&manifest.name)
            .join(format!(".staging-{}", Uuid::new_v4()));
        copy_plugin_tree(&manifest.source_path, &staging, &codex_plugin_cache_root())?;
        fs::rename(&staging, &destination)
            .map_err(|error| format!("Failed to publish managed plugin copy: {error}"))?;
    }

    let marketplace_path = root
        .join(".agents")
        .join("plugins")
        .join("marketplace.json");
    let mut value = if marketplace_path.exists() {
        serde_json::from_slice::<Value>(
            &fs::read(&marketplace_path)
                .map_err(|error| format!("Failed to read managed marketplace: {error}"))?,
        )
        .map_err(|error| format!("Failed to parse managed marketplace: {error}"))?
    } else {
        json!({
            "name": PERSONAL_MARKETPLACE,
            "interface": { "displayName": "Personal" },
            "plugins": []
        })
    };
    let plugins = value
        .get_mut("plugins")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Managed marketplace plugins must be an array".to_string())?;
    plugins.retain(|entry| entry.get("name").and_then(Value::as_str) != Some(&manifest.name));
    plugins.push(marketplace_entry(&manifest.name, &relative));
    let bytes = serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("Failed to serialize managed marketplace: {error}"))?;
    atomic_write(&marketplace_path, &bytes)
        .map_err(|error| format!("Failed to write managed marketplace: {error}"))?;
    Ok(root)
}

pub fn repair_codex_plugin_registration(plugin_id: &str) -> Result<RepairableCodexPlugin, String> {
    let config = read_codex_config()?;
    let candidate = enabled_personal_plugins(&config)?
        .into_iter()
        .find(|(id, name)| id == plugin_id || name == plugin_id)
        .ok_or_else(|| format!("Enabled personal Codex plugin not found: {plugin_id}"))?;
    let manifest = latest_personal_manifest(&candidate.1)
        .ok_or_else(|| format!("Cached plugin manifest not found: {}", candidate.1))?;
    let root = write_managed_marketplace(&manifest)?;

    let marketplaces = codex_marketplaces()?;
    match marketplaces
        .iter()
        .find(|(name, _)| name == PERSONAL_MARKETPLACE)
    {
        Some((_, registered_root)) => {
            let expected = fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
            let actual =
                fs::canonicalize(registered_root).unwrap_or_else(|_| registered_root.clone());
            if actual != expected {
                return Err(
                    "A different Codex marketplace named personal is already registered"
                        .to_string(),
                );
            }
        }
        None => {
            let root_text = root.to_string_lossy().to_string();
            let output = codex_command(&["plugin", "marketplace", "add", &root_text, "--json"])?;
            if !output.status.success() {
                return Err(command_error("codex plugin marketplace add", &output));
            }
        }
    }

    let selector = format!("{}@{}", manifest.name, PERSONAL_MARKETPLACE);
    let output = codex_command(&["plugin", "add", &selector, "--json"])?;
    if !output.status.success() {
        return Err(command_error("codex plugin add", &output));
    }

    Ok(RepairableCodexPlugin {
        id: candidate.0,
        name: manifest.name,
        version: manifest.version,
        manifest_path: manifest.manifest_path.to_string_lossy().to_string(),
        source_path: manifest.source_path.to_string_lossy().to_string(),
        repair_action: CodexPluginRepairAction::RegisterMarketplace,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_installed_enabled_browser_plugin() {
        let output = "browser@openai-bundled  installed, enabled  1.2.3  C:\\cache\\browser";
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

    #[test]
    fn marketplace_entry_uses_current_local_source_schema() {
        let entry = marketplace_entry("sample", "./plugins/sample/1.0.0");
        assert_eq!(entry["source"]["source"], "local");
        assert_eq!(entry["source"]["path"], "./plugins/sample/1.0.0");
        assert_eq!(entry["policy"]["installation"], "AVAILABLE");
        assert_eq!(entry["policy"]["authentication"], "ON_INSTALL");
    }

    #[test]
    fn registered_personal_marketplace_suppresses_repair_candidates() {
        let result = detect_repairable_personal_plugins(
            vec![("sample@personal".to_string(), "sample".to_string())],
            &[("personal".to_string(), PathBuf::from("C:/personal"))],
        );
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn browser_extension_ids_match_generated_plugin_contract() {
        assert_eq!(BROWSER_EXTENSION_IDS.len(), 2);
        assert!(BROWSER_EXTENSION_IDS
            .iter()
            .all(|id| id.len() == 32 && id.chars().all(|ch| ch.is_ascii_lowercase())));
    }
}
