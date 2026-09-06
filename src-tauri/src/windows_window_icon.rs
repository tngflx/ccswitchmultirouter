use std::ptr::null;

use tauri::plugin::{Builder, TauriPlugin};
use windows_sys::Win32::{
    Foundation::HWND,
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::{LoadIconW, SendMessageW, HICON, ICON_BIG, WM_SETICON},
};

// tauri-build embeds the configured Windows icon with this resource ID.
const TAURI_ICON_RESOURCE: *const u16 = 32512usize as *const u16;

pub fn init<R: tauri::Runtime>() -> TauriPlugin<R> {
    Builder::new("windows-window-icon")
        .on_window_ready(|window| {
            let result = window
                .hwnd()
                .map_err(|error| error.to_string())
                .and_then(|hwnd| install_taskbar_icon(hwnd.0));
            if let Err(error) = result {
                log::warn!("Failed to set Windows taskbar icon: {error}");
            }
        })
        .build()
}

fn install_taskbar_icon(hwnd: HWND) -> Result<(), String> {
    let module = unsafe { GetModuleHandleW(null()) };
    if module.is_null() {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // LoadIconW returns a shared resource: Windows owns its lifetime. Do not
    // destroy it after WM_SETICON, which keeps the handle rather than a copy.
    let icon = unsafe { LoadIconW(module, TAURI_ICON_RESOURCE) };
    if icon.is_null() {
        return Err(std::io::Error::last_os_error().to_string());
    }
    set_large_icon(hwnd, icon);
    Ok(())
}

fn set_large_icon(hwnd: HWND, icon: HICON) {
    // Tauri's icon API sets ICON_SMALL only. Explicitly supply ICON_BIG so the
    // shell does not have to infer an icon from a shortcut or cached app ID.
    unsafe { SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, icon as isize) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr::null_mut;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, IsWindowVisible, ICON_SMALL, IDI_APPLICATION, WM_GETICON,
    };

    #[test]
    fn large_icon_is_assigned_without_showing_window_or_replacing_small_icon() {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        unsafe {
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                null(),
                0,
                0,
                0,
                1,
                1,
                null_mut(),
                null_mut(),
                GetModuleHandleW(null()),
                null(),
            );
            assert!(!hwnd.is_null());
            let icon = LoadIconW(null_mut(), IDI_APPLICATION);
            assert!(!icon.is_null());
            SendMessageW(hwnd, WM_SETICON, ICON_SMALL as usize, icon as isize);
            let before = SendMessageW(hwnd, WM_GETICON, ICON_BIG as usize, 0);
            set_large_icon(hwnd, icon);
            let large = SendMessageW(hwnd, WM_GETICON, ICON_BIG as usize, 0);
            let small = SendMessageW(hwnd, WM_GETICON, ICON_SMALL as usize, 0);
            let visible = IsWindowVisible(hwnd);
            DestroyWindow(hwnd);
            assert_eq!(before, 0);
            assert_eq!(large, icon as isize);
            assert_eq!(small, icon as isize);
            assert_eq!(visible, 0);
        }
    }
}
