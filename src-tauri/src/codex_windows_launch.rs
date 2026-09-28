use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RegisteredApplication {
    executable: String,
    app_id: String,
}

fn normalized_path(path: &str) -> String {
    path.replace('/', "\\")
        .trim_start_matches(r"\\?\")
        .to_lowercase()
}

fn matching_app_id(applications: &[RegisteredApplication], executable: &Path) -> Option<String> {
    let executable = normalized_path(&executable.to_string_lossy());
    applications
        .iter()
        .find(|app| normalized_path(&app.executable) == executable)
        .map(|app| app.app_id.clone())
}

pub(crate) fn is_packaged_codex(executable: &Path) -> bool {
    normalized_path(&executable.to_string_lossy())
        .split('\\')
        .any(|part| part.starts_with("openai.codex_") || part.starts_with("openai.codex.preview_"))
}

pub(crate) fn resolve_app_id(executable: &Path) -> Result<Option<String>, String> {
    if !is_packaged_codex(executable) {
        return Ok(None);
    }
    // Match the registered manifest entry, not the first Start-menu shortcut:
    // stable and Preview can coexist, and Application Id is not always "App".
    let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$items = @(Get-AppxPackage -Name 'OpenAI.Codex*' |
  Where-Object { $_.Name -eq 'OpenAI.Codex' -or $_.Name -eq 'OpenAI.Codex.Preview' } |
  ForEach-Object {
    $package = $_
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
    foreach ($app in $manifest.Package.Applications.Application) {
      if ($app.Executable -and $app.Id) {
        [PSCustomObject]@{
          Executable = Join-Path $package.InstallLocation $app.Executable
          AppId = $package.PackageFamilyName + '!' + $app.Id
        }
      }
    }
  })
ConvertTo-Json -InputObject $items -Compress
"#;
    let value = super::powershell_json_value(script)
        .ok_or_else(|| "codex_package_registration_query_failed".to_string())?;
    let applications: Vec<RegisteredApplication> = serde_json::from_value(value)
        .map_err(|error| format!("codex_package_registration_invalid: {error}"))?;
    matching_app_id(&applications, executable)
        .map(Some)
        .ok_or_else(|| {
            format!(
                "codex_package_application_not_registered: {}",
                executable.display()
            )
        })
}

pub(crate) fn activate(aumid: &str, debug_port: Option<u16>) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_LOCAL_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        ApplicationActivationManager, IApplicationActivationManager, AO_NONE,
    };

    let initialization = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    const RPC_E_CHANGED_MODE: windows::core::HRESULT =
        windows::core::HRESULT(0x80010106_u32 as i32);
    if initialization.is_err() && initialization != RPC_E_CHANGED_MODE {
        return Err(format!(
            "codex_aumid_com_initialization_failed: {initialization}"
        ));
    }
    let result = (|| -> Result<(), String> {
        let manager: IApplicationActivationManager =
            unsafe { CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER) }
                .map_err(|error| format!("codex_aumid_activation_manager_failed: {error}"))?;
        let arguments = debug_port.map(|port| {
            format!("--remote-debugging-port={port} --remote-allow-origins=http://127.0.0.1:{port}")
        });
        let arguments = HSTRING::from(arguments.as_deref().unwrap_or_default());
        unsafe { manager.ActivateApplication(&HSTRING::from(aumid), &arguments, AO_NONE) }
            .map(|_| ())
            .map_err(|error| format!("codex_aumid_activation_failed ({aumid}): {error}"))
    })();
    if initialization.is_ok() {
        unsafe { CoUninitialize() };
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_matches_selected_package_and_manifest_application() {
        let applications = vec![
            RegisteredApplication {
                executable: r"C:\Program Files\WindowsApps\OpenAI.Codex.Preview_2_x64__publisher\app\ChatGPT.exe".into(),
                app_id: "OpenAI.Codex.Preview_publisher!App".into(),
            },
            RegisteredApplication {
                executable: r"C:\Program Files\WindowsApps\OpenAI.Codex_1_x64__publisher\app\ChatGPT.exe".into(),
                app_id: "OpenAI.Codex_publisher!UnifiedApp".into(),
            },
        ];
        let selected = Path::new(
            r"\\?\c:\program files\windowsapps\OpenAI.Codex_1_x64__publisher\app\ChatGPT.exe",
        );
        assert_eq!(
            matching_app_id(&applications, selected).as_deref(),
            Some("OpenAI.Codex_publisher!UnifiedApp")
        );
        assert!(matching_app_id(&applications, Path::new(r"C:\Other\ChatGPT.exe")).is_none());
    }

    #[test]
    fn standalone_installations_do_not_require_package_registration() {
        assert_eq!(
            resolve_app_id(Path::new(r"C:\Users\Test\Apps\Codex.exe")),
            Ok(None)
        );
        assert!(!is_packaged_codex(Path::new(
            r"C:\OpenAI.Codex.Tools\Codex.exe"
        )));
        assert!(is_packaged_codex(Path::new(
            r"D:/WindowsApps/OpenAI.Codex_1_x64__publisher/app/ChatGPT.exe"
        )));
    }
}
