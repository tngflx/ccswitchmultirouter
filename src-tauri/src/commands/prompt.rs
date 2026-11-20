use indexmap::IndexMap;
use std::str::FromStr;

use tauri::State;

use crate::app_config::AppType;
use crate::prompt::Prompt;
use crate::services::pi_prompt_files::{
    PiPromptFileKind, PiPromptFileService, PiPromptFileSnapshot, PiPromptTemplate,
    PiPromptTemplateService,
};
use crate::services::PromptService;
use crate::store::AppState;

#[tauri::command]
pub async fn get_prompts(
    app: String,
    state: State<'_, AppState>,
) -> Result<IndexMap<String, Prompt>, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    super::run_state_blocking(&state, move |state| {
        PromptService::get_prompts(state, app_type).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn upsert_prompt(
    app: String,
    id: String,
    prompt: Prompt,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    super::run_state_blocking(&state, move |state| {
        PromptService::upsert_prompt(state, app_type, &id, prompt).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn delete_prompt(
    app: String,
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    super::run_state_blocking(&state, move |state| {
        PromptService::delete_prompt(state, app_type, &id).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn enable_prompt(
    app: String,
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    super::run_state_blocking(&state, move |state| {
        PromptService::enable_prompt(state, app_type, &id).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn import_prompt_from_file(
    app: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    super::run_state_blocking(&state, move |state| {
        PromptService::import_from_file(state, app_type).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn get_current_prompt_file_content(app: String) -> Result<Option<String>, String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    super::run_command_blocking(move || {
        PromptService::get_current_file_content(app_type).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn get_pi_prompt_file(kind: PiPromptFileKind) -> Result<PiPromptFileSnapshot, String> {
    super::run_command_blocking(move || {
        PiPromptFileService::read(kind).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn replace_pi_prompt_file(
    kind: PiPromptFileKind,
    #[allow(non_snake_case)] expectedRevision: String,
    content: String,
) -> Result<PiPromptFileSnapshot, String> {
    super::run_command_blocking(move || {
        PiPromptFileService::replace(kind, &expectedRevision, &content)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn delete_pi_prompt_file(
    kind: PiPromptFileKind,
    #[allow(non_snake_case)] expectedRevision: String,
) -> Result<bool, String> {
    super::run_command_blocking(move || {
        PiPromptFileService::delete(kind, &expectedRevision).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn list_pi_prompt_templates() -> Result<Vec<PiPromptTemplate>, String> {
    super::run_command_blocking(|| {
        PiPromptTemplateService::list().map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn upsert_pi_prompt_template(
    slug: String,
    #[allow(non_snake_case)] originalSlug: Option<String>,
    #[allow(non_snake_case)] expectedRevision: String,
    content: String,
) -> Result<PiPromptTemplate, String> {
    super::run_command_blocking(move || {
        PiPromptTemplateService::upsert(&slug, originalSlug.as_deref(), &expectedRevision, &content)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn delete_pi_prompt_template(
    slug: String,
    #[allow(non_snake_case)] expectedRevision: String,
) -> Result<bool, String> {
    super::run_command_blocking(move || {
        PiPromptTemplateService::delete(&slug, &expectedRevision).map_err(|error| error.to_string())
    })
    .await
}

#[cfg(test)]
mod dispatch_tests {
    use super::{
        delete_pi_prompt_file, delete_pi_prompt_template, get_current_prompt_file_content,
        get_pi_prompt_file, list_pi_prompt_templates, replace_pi_prompt_file,
        upsert_pi_prompt_template,
    };
    use std::future::Future;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    fn assert_async_command<T, F>(_: impl FnOnce() -> F)
    where
        F: Future<Output = Result<T, String>> + Send,
    {
    }

    #[test]
    fn prompt_file_commands_use_async_dispatch() {
        assert_async_command(|| get_current_prompt_file_content(String::new()));
        assert_async_command(|| {
            get_pi_prompt_file(crate::services::pi_prompt_files::PiPromptFileKind::SystemOverride)
        });
        assert_async_command(|| {
            replace_pi_prompt_file(
                crate::services::pi_prompt_files::PiPromptFileKind::SystemOverride,
                String::new(),
                String::new(),
            )
        });
        assert_async_command(|| {
            delete_pi_prompt_file(
                crate::services::pi_prompt_files::PiPromptFileKind::SystemOverride,
                String::new(),
            )
        });
        assert_async_command(list_pi_prompt_templates);
        assert_async_command(|| {
            upsert_pi_prompt_template(String::new(), None, String::new(), String::new())
        });
        assert_async_command(|| delete_pi_prompt_template(String::new(), String::new()));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pi_prompt_file_read_does_not_block_async_executor() {
        let (ready_tx, ready_rx) = mpsc::channel();
        let holder =
            thread::spawn(
                move || match crate::services::pi_prompt_files::PiAgentsFileGuard::acquire() {
                    Ok(guard) => {
                        ready_tx.send(true).expect("signal Pi prompt lock");
                        thread::sleep(Duration::from_millis(100));
                        drop(guard);
                    }
                    Err(_) => ready_tx.send(false).expect("signal Pi prompt lock failure"),
                },
            );
        assert!(ready_rx.recv().expect("wait for Pi prompt lock"));

        let started = Instant::now();
        let mut command = Box::pin(get_pi_prompt_file(
            crate::services::pi_prompt_files::PiPromptFileKind::SystemOverride,
        ));
        let timed_out = tokio::time::timeout(Duration::from_millis(20), &mut command)
            .await
            .is_err();

        assert!(
            timed_out,
            "Pi prompt read blocked the async executor for {:?}",
            started.elapsed()
        );
        command.await.expect("Pi prompt read after lock release");
        holder.join().expect("join Pi prompt lock holder");
    }
}
