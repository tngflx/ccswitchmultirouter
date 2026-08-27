fn main() {
    // Windows 任务栏图标最终来自 build script 生成的 native resource。
    // Tauri 默认配置文件变化会触发构建，但 Cargo 不一定知道 icons/icon.ico
    // 已更新；显式声明依赖，避免复用旧 resource.lib 后 exe 仍嵌旧图标。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=../.git/HEAD");

    tauri_build::build();

    // Embed the source commit so the app can compare itself with the upstream fork.
    if let Ok(output) = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
    {
        if output.status.success() {
            let commit = String::from_utf8_lossy(&output.stdout).trim().to_string();
            println!("cargo:rustc-env=CCSWITCHMULTI_GIT_COMMIT={commit}");
            // Compare from the nearest upstream ancestor when local commits are
            // fork-only (GitHub cannot resolve those hashes in its repository).
            if let Ok(base_output) = std::process::Command::new("git")
                .args(["merge-base", "HEAD", "upstream/main"])
                .output()
            {
                if base_output.status.success() {
                    let base = String::from_utf8_lossy(&base_output.stdout)
                        .trim()
                        .to_string();
                    if !base.is_empty() {
                        println!("cargo:rustc-env=CCSWITCHMULTI_GIT_BASE={base}");
                    }
                }
            }
        }
    }

    // Windows: Embed Common Controls v6 manifest for test binaries
    //
    // When running `cargo test`, the generated test executables don't include
    // the standard Tauri application manifest. Without Common Controls v6,
    // `tauri::test` calls fail with STATUS_ENTRYPOINT_NOT_FOUND.
    //
    // This workaround:
    // 1. Embeds the manifest into test binaries via /MANIFEST:EMBED
    // 2. Uses /MANIFEST:NO for the main binary to avoid duplicate resources
    //    (Tauri already handles manifest embedding for the app binary)
    #[cfg(target_os = "windows")]
    {
        let manifest_path = std::path::PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"),
        )
        .join("common-controls.manifest");
        let manifest_arg = format!("/MANIFESTINPUT:{}", manifest_path.display());

        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg={}", manifest_arg);
        // Avoid duplicate manifest resources in binary builds.
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
        println!("cargo:rerun-if-changed={}", manifest_path.display());
    }
}
