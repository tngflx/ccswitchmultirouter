<#
.SYNOPSIS
    Read-only, non-disruptive capture of the running CCSwitchMulti Tauri window.

.DESCRIPTION
    Locates the cc-switch process and its Tauri window, prefers the WebView2
    renderer child when one is exposed, then captures with PrintWindow using
    PW_RENDERFULLCONTENT. The script never activates, moves, restores, or
    resizes the window. It verifies the capture is not a uniform blank surface
    and reports the selected window handle, class, rectangle, and sample stats.

    A hidden/minimized-to-tray window normally produces a uniform black capture
    because WebView2 is not compositing. The script exits non-zero in that
    case; do NOT treat it as a successful audit.

.PARAMETER ProcessName
    Executable base name to locate. Defaults to cc-switch.

.PARAMETER OutputPath
    Destination PNG. Defaults to $env:USERPROFILE\.cc-switch\inspection\capture-<timestamp>.png.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\capture-tauri-window.ps1
#>
param(
    [string]$ProcessName = "cc-switch",
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Drawing

$native = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TauriCaptureNative {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
"@
Add-Type -TypeDefinition $native

function Get-ProcessWindows {
    param([int]$ProcessId)

    $matches = [System.Collections.Generic.List[object]]::new()
    $callback = {
        param([IntPtr]$hwnd, [IntPtr]$lparam)
        $owner = 0
        [TauriCaptureNative]::GetWindowThreadProcessId($hwnd, [ref]$owner) | Out-Null
        if ($owner -eq $ProcessId) {
            $classBuilder = [System.Text.StringBuilder]::new(256)
            [TauriCaptureNative]::GetClassName($hwnd, $classBuilder, 256) | Out-Null
            $rect = New-Object TauriCaptureNative+RECT
            [TauriCaptureNative]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
            $matches.Add([pscustomobject]@{
                Handle = $hwnd
                Class = $classBuilder.ToString()
                Visible = [TauriCaptureNative]::IsWindowVisible($hwnd)
                Width = $rect.Right - $rect.Left
                Height = $rect.Bottom - $rect.Top
                Left = $rect.Left
                Top = $rect.Top
            })
        }
        return $true
    }

    $delegate = [TauriCaptureNative+EnumWindowsProc]$callback
    [TauriCaptureNative]::EnumWindows($delegate, [IntPtr]::Zero) | Out-Null
    return $matches
}

function Find-RendererChild {
    param([IntPtr]$ParentHandle)

    $child = [TauriCaptureNative]::GetWindow($ParentHandle, 5)
    while ($child -ne [IntPtr]::Zero) {
        $classBuilder = [System.Text.StringBuilder]::new(256)
        [TauriCaptureNative]::GetClassName($child, $classBuilder, 256) | Out-Null
        $className = $classBuilder.ToString()
        if ($className -match "Chrome_WidgetWin|WebView|Windows.UI.Core") {
            return $child
        }
        $deep = Find-RendererChild -ParentHandle $child
        if ($deep -ne [IntPtr]::Zero) {
            return $deep
        }
        $child = [TauriCaptureNative]::GetWindow($child, 2)
    }
    return [IntPtr]::Zero
}

$process = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
if ($null -eq $process) {
    throw "No $ProcessName process with a main window was found."
}

$mainHandle = $process.MainWindowHandle
if ($mainHandle -ne [IntPtr]::Zero -and -not [TauriCaptureNative]::IsWindowVisible($mainHandle) -and [TauriCaptureNative]::IsIconic($mainHandle)) {
    throw "$ProcessName (pid $($process.Id)) is minimized. Ask the user to restore the window before capturing; the helper must not call ShowWindow."
}

$windows = @(Get-ProcessWindows -ProcessId $process.Id)
$toplevel = @($windows | Where-Object { $_.Class -match "^Tauri Window$" -and $_.Visible -and $_.Width -gt 100 -and $_.Height -gt 100 } |
    Sort-Object -Property @{ Expression = { $_.Width * $_.Height }; Descending = $true })
if ($toplevel.Count -eq 0) {
    $toplevel = @($windows | Where-Object { $_.Class -like "Chrome_WidgetWin*" -and $_.Visible -and $_.Width -gt 100 -and $_.Height -gt 100 } |
        Sort-Object -Property @{ Expression = { $_.Width * $_.Height }; Descending = $true })
}
if ($toplevel.Count -eq 0) {
    $toplevel = @($windows | Where-Object { $_.Visible -and $_.Width -gt 100 -and $_.Height -gt 100 } |
        Sort-Object -Property @{ Expression = { $_.Width * $_.Height }; Descending = $true })
}
if ($toplevel.Count -eq 0) {
    throw "No visible candidate window was found for $ProcessName (pid $($process.Id)). The app may be hidden to tray."
}

$selected = $toplevel[0]
$webviewChild = [IntPtr]::Zero
$childCandidates = @($windows | Where-Object { $_.Class -match "Chrome_WidgetWin|WebView|Windows.UI.Core" -and $_.Width -gt 100 -and $_.Height -gt 100 })
if ($childCandidates.Count -gt 0) {
    $webviewChild = $childCandidates[0].Handle
} else {
    $found = Find-RendererChild -ParentHandle $selected.Handle
    if ($found -ne [IntPtr]::Zero) {
        $webviewChild = $found
    }
}

$captureHandle = $selected.Handle
$captureClass = $selected.Class
$rect = New-Object TauriCaptureNative+RECT
[TauriCaptureNative]::GetWindowRect($captureHandle, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
    throw "Window $captureHandle has an empty rectangle."
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $dir = Join-Path $env:USERPROFILE ".cc-switch\inspection"
    [System.IO.Directory]::CreateDirectory($dir) | Out-Null
    $OutputPath = Join-Path $dir ("capture-{0}.png" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
}
$dir = Split-Path -Parent $OutputPath
if ($dir) {
    [System.IO.Directory]::CreateDirectory($dir) | Out-Null
}

$bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
try {
    $printResult = [TauriCaptureNative]::PrintWindow($captureHandle, $hdc, 2)
} finally {
    $graphics.ReleaseHdc($hdc)
    $graphics.Dispose()
}
$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$colors = [System.Collections.Generic.HashSet[int]]::new()
$nonBlank = 0L
$sampled = 0L
for ($y = 0; $y -lt $height; $y += 4) {
    for ($x = 0; $x -lt $width; $x += 4) {
        $argb = $bitmap.GetPixel($x, $y).ToArgb()
        [void]$colors.Add($argb)
        if (($argb -band 0xFFFFFF) -ne 0xFFFFFF) {
            $nonBlank++
        }
        $sampled++
    }
}
$bitmap.Dispose()

$ratio = if ($sampled -gt 0) { [math]::Round($nonBlank / $sampled, 4) } else { 0 }
$summary = [pscustomobject]@{
    ProcessId = $process.Id
    WindowHandle = ("0x{0:X}" -f $captureHandle.ToInt64())
    WindowClass = $captureClass
    WebViewHandle = if ($webviewChild -ne [IntPtr]::Zero) { ("0x{0:X}" -f $webviewChild.ToInt64()) } else { "" }
    Width = $width
    Height = $height
    PrintWindow = $printResult
    UniqueSampledColors = $colors.Count
    NonBlankRatio = $ratio
    OutputPath = $OutputPath
}
$summary | Format-List | Out-String | Write-Output

if (-not $printResult -or $colors.Count -lt 2 -or $ratio -lt 0.02) {
    throw "Capture appears blank (unique colors=$($colors.Count), nonBlankRatio=$ratio). The window is likely hidden or not compositing; ask the user to open the app before retrying."
}
