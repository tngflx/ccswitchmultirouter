use std::process::Command;

/// The supported Windows PowerShell runtime. Do not fall back to Windows
/// PowerShell 5.1: process and JSON behavior must use the same host everywhere.
pub(crate) const POWERSHELL7_EXECUTABLE: &str = "pwsh.exe";

pub(crate) fn command() -> Command {
    Command::new(POWERSHELL7_EXECUTABLE)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    #[test]
    fn supported_host_runs_powershell7_with_utf8_output() {
        use std::os::windows::process::CommandExt;

        let output = super::command()
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required' }; [pscustomobject]@{Major=$PSVersionTable.PSVersion.Major; Label=([char]0x4e2d).ToString()} | ConvertTo-Json -Compress",
            ])
            .creation_flags(0x08000000)
            .output()
            .expect("PowerShell 7 (pwsh.exe) must be installed for Windows runtime probes");
        assert!(
            output.status.success(),
            "PowerShell 7 fixture should succeed"
        );
        let value: serde_json::Value = serde_json::from_slice(&output.stdout)
            .expect("PowerShell 7 output should be UTF-8 JSON");
        assert!(value["Major"].as_u64().is_some_and(|major| major >= 7));
        assert_eq!(value["Label"], "\u{4e2d}");
    }
}
