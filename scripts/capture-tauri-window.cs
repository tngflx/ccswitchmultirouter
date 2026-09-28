using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

internal static class CaptureTauriWindow
{
    private static bool DebugGroup;
    private const uint PwRenderFullContent = 2;
    private const uint GwChild = 5;
    private const uint GwHwndNext = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;

        public int Width { get { return Right - Left; } }
        public int Height { get { return Bottom - Top; } }
    }

    private sealed class WindowInfo
    {
        public IntPtr Handle;
        public int ProcessId;
        public string ClassName = "";
        public string Title = "";
        public bool Visible;
        public bool Minimized;
        public Rect Bounds;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint command);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder title, int maxCount);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);

    private static int Main(string[] args)
    {
        string processName = GetOption(args, "--process") ?? "cc-switch";
        int? requestedPid = ParsePid(GetOption(args, "--pid"));
        string capturePath = GetOption(args, "--capture");
        string invokeName = GetOption(args, "--invoke-name");
        string selectName = GetOption(args, "--select-name");
        string invokeGroup = GetOption(args, "--invoke-group");
        DebugGroup = HasFlag(args, "--debug-group");
        bool readUia = HasFlag(args, "--uia") || (capturePath == null && !HasFlag(args, "--list"));
        bool listOnly = HasFlag(args, "--list");

        WindowInfo window = FindTargetWindow(processName, requestedPid);
        if (window == null)
        {
            Console.Error.WriteLine("No Tauri window found for process " + processName + ".");
            return 2;
        }

        PrintWindowInfo(window);
        if (listOnly)
        {
            return 0;
        }

        if (!string.IsNullOrWhiteSpace(invokeName) &&
            !InvokeNamedControl(window.Handle, invokeName, invokeGroup))
        {
            return 4;
        }

        if (!string.IsNullOrWhiteSpace(selectName) &&
            !SelectNamedControl(window.Handle, selectName))
        {
            return 5;
        }

        if (readUia)
        {
            ReadAutomationTree(window.Handle);
        }

        if (!string.IsNullOrWhiteSpace(capturePath))
        {
            return Capture(window, capturePath) ? 0 : 3;
        }

        return 0;
    }

    private static WindowInfo FindTargetWindow(string processName, int? requestedPid)
    {
        Process[] processes = Process.GetProcessesByName(processName);
        var candidates = new List<WindowInfo>();
        foreach (Process process in processes)
        {
            if (requestedPid.HasValue && process.Id != requestedPid.Value)
            {
                continue;
            }

            WindowInfo[] processWindows = EnumerateWindows(process.Id);
            foreach (WindowInfo candidate in processWindows)
            {
                if (candidate.ClassName == "Tauri Window" ||
                    candidate.Title.IndexOf("CCSwitchMulti", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    candidates.Add(candidate);
                }
            }
        }

        if (candidates.Count == 0)
        {
            return null;
        }

        candidates.Sort(delegate(WindowInfo left, WindowInfo right)
        {
            int leftArea = Math.Max(0, left.Bounds.Width) * Math.Max(0, left.Bounds.Height);
            int rightArea = Math.Max(0, right.Bounds.Width) * Math.Max(0, right.Bounds.Height);
            return rightArea.CompareTo(leftArea);
        });
        return candidates[0];
    }

    private static WindowInfo[] EnumerateWindows(int processId)
    {
        var result = new List<WindowInfo>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr unused)
        {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner == processId)
            {
                result.Add(ReadWindowInfo(hWnd, processId));
            }
            return true;
        }, IntPtr.Zero);

        return result.ToArray();
    }

    private static WindowInfo ReadWindowInfo(IntPtr hWnd, int processId)
    {
        var className = new StringBuilder(256);
        var title = new StringBuilder(512);
        GetClassName(hWnd, className, className.Capacity);
        GetWindowText(hWnd, title, title.Capacity);
        Rect bounds;
        GetWindowRect(hWnd, out bounds);
        return new WindowInfo
        {
            Handle = hWnd,
            ProcessId = processId,
            ClassName = className.ToString(),
            Title = title.ToString(),
            Visible = IsWindowVisible(hWnd),
            Minimized = IsIconic(hWnd),
            Bounds = bounds,
        };
    }

    private static void PrintWindowInfo(WindowInfo window)
    {
        Console.WriteLine("ProcessId: " + window.ProcessId);
        Console.WriteLine("WindowHandle: 0x" + window.Handle.ToInt64().ToString("X"));
        Console.WriteLine("WindowClass: " + window.ClassName);
        Console.WriteLine("WindowTitle: " + window.Title);
        Console.WriteLine("Visible: " + window.Visible);
        Console.WriteLine("Minimized: " + window.Minimized);
        Console.WriteLine("Bounds: " + window.Bounds.Width + "x" + window.Bounds.Height +
            " at " + window.Bounds.Left + "," + window.Bounds.Top);
    }

    private static void ReadAutomationTree(IntPtr hWnd)
    {
        AutomationElement root;
        try
        {
            root = AutomationElement.FromHandle(hWnd);
        }
        catch (Exception error)
        {
            Console.WriteLine("UIA error: " + error.Message);
            return;
        }

        if (root == null)
        {
            Console.WriteLine("UIA root: unavailable");
            return;
        }

        Console.WriteLine("UIA root: " + Describe(root));
        AutomationElement webRoot = null;
        try
        {
            webRoot = root.FindFirst(
                TreeScope.Descendants,
                new PropertyCondition(AutomationElement.AutomationIdProperty, "RootWebArea"));
        }
        catch (Exception error)
        {
            Console.WriteLine("UIA descendant query error: " + error.Message);
        }

        Console.WriteLine("RootWebArea: " + (webRoot == null ? "unavailable" : Describe(webRoot)));
        AutomationElement start = webRoot ?? root;
        DumpDescendants(start, 0, 250);
    }

    private static bool InvokeNamedControl(IntPtr hWnd, string name, string groupName)
    {
        AutomationElement root;
        try
        {
            root = AutomationElement.FromHandle(hWnd);
            if (root == null)
            {
                Console.Error.WriteLine("UIA root unavailable before invoke.");
                return false;
            }

            AutomationElementCollection matches = string.IsNullOrWhiteSpace(groupName)
                ? root.FindAll(
                    TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.NameProperty, name))
                : null;
            int matchCount = matches == null ? 1 : matches.Count;
            for (int index = 0; index < matchCount; index++)
            {
                AutomationElement candidate = matches == null
                    ? FindControlInNamedGroup(root, groupName, name)
                    : matches[index];
                if (candidate == null)
                {
                    break;
                }
                if (candidate.Current.ControlType != ControlType.Button ||
                    !candidate.Current.IsEnabled)
                {
                    continue;
                }

                InvokePattern pattern = candidate.GetCurrentPattern(InvokePattern.Pattern) as InvokePattern;
                if (pattern == null)
                {
                    continue;
                }

                Console.WriteLine("Invoking: " + Describe(candidate));
                pattern.Invoke();
                System.Threading.Thread.Sleep(500);
                return true;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("UIA invoke error: " + error.Message);
            return false;
        }

        Console.Error.WriteLine("Enabled button not found: " + name);
        return false;
    }

    private static bool SelectNamedControl(IntPtr hWnd, string name)
    {
        try
        {
            AutomationElement root = AutomationElement.FromHandle(hWnd);
            if (root == null)
            {
                Console.Error.WriteLine("UIA root unavailable before selection.");
                return false;
            }

            AutomationElementCollection matches = root.FindAll(
                TreeScope.Descendants,
                new AndCondition(
                    new PropertyCondition(AutomationElement.NameProperty, name),
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem)));
            for (int index = 0; index < matches.Count; index++)
            {
                AutomationElement candidate = matches[index];
                if (!candidate.Current.IsEnabled)
                {
                    continue;
                }

                SelectionItemPattern pattern = candidate.GetCurrentPattern(
                    SelectionItemPattern.Pattern) as SelectionItemPattern;
                if (pattern != null)
                {
                    Console.WriteLine("Selecting: " + Describe(candidate));
                    pattern.Select();
                    System.Threading.Thread.Sleep(500);
                    return true;
                }

                // Chromium's WebView2 accessibility provider often exposes tab
                // items with InvokePattern only. Keep navigation semantic and
                // background-safe while supporting both provider shapes.
                InvokePattern invoke = candidate.GetCurrentPattern(
                    InvokePattern.Pattern) as InvokePattern;
                if (invoke == null)
                {
                    continue;
                }

                Console.WriteLine("Invoking tab: " + Describe(candidate));
                invoke.Invoke();
                System.Threading.Thread.Sleep(500);
                return true;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("UIA selection error: " + error.Message);
            return false;
        }

        Console.Error.WriteLine("Enabled tab item not found: " + name);
        return false;
    }

    private static AutomationElement FindControlInNamedGroup(
        AutomationElement root,
        string groupName,
        string controlName)
    {
        AutomationElementCollection controls = root.FindAll(
            TreeScope.Descendants,
            new AndCondition(
                new PropertyCondition(AutomationElement.NameProperty, controlName),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)));
        for (int index = 0; index < controls.Count; index++)
        {
            AutomationElement candidate = controls[index];
            AutomationElement container = TreeWalker.RawViewWalker.GetParent(candidate);
            for (int level = 0; level < 10; level++)
            {
                if (container == null)
                {
                    break;
                }
                AutomationElementCollection groupMembers = container.FindAll(
                    TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.NameProperty, groupName));
                AutomationElementCollection localControls = container.FindAll(
                    TreeScope.Descendants,
                    new AndCondition(
                        new PropertyCondition(AutomationElement.NameProperty, controlName),
                        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)));
                if (DebugGroup)
                {
                    Console.WriteLine("Group probe candidate=" + index + " level=" + level +
                        " control=" + Describe(candidate) +
                        " container=" + Describe(container) +
                        " matchingNames=" + groupMembers.Count +
                        " controls=" + localControls.Count);
                }
                // The closest ancestor with exactly one Edit button is the
                // provider card. It must also contain the requested provider name.
                if (groupMembers.Count > 0 && localControls.Count == 1)
                {
                    return candidate;
                }

                AutomationElement parent = TreeWalker.RawViewWalker.GetParent(container);
                if (parent == null)
                {
                    break;
                }
                container = parent;
            }
        }

        return null;
    }

    private static void DumpDescendants(AutomationElement root, int depth, int limit)
    {
        var walker = TreeWalker.RawViewWalker;
        int count = 0;
        AutomationElement current = walker.GetFirstChild(root);
        while (current != null && count < limit)
        {
            Console.WriteLine(new string(' ', Math.Min(depth + 1, 12) * 2) + Describe(current));
            count++;
            DumpDescendants(current, depth + 1, limit - count);
            current = walker.GetNextSibling(current);
        }
    }

    private static string Describe(AutomationElement element)
    {
        AutomationElement.AutomationElementInformation info = element.Current;
        string value = "";
        try
        {
            object raw = element.GetCurrentPropertyValue(ValuePattern.ValueProperty);
            if (raw != AutomationElement.NotSupported && raw != null)
            {
                value = raw.ToString();
            }
        }
        catch
        {
        }

        return "name=\"" + info.Name + "\" aid=\"" + info.AutomationId +
            "\" type=" + info.ControlType.ProgrammaticName +
            (string.IsNullOrEmpty(value) ? "" : " value=\"" + value + "\"");
    }

    private static bool Capture(WindowInfo window, string outputPath)
    {
        if (window.Bounds.Width <= 0 || window.Bounds.Height <= 0)
        {
            Console.Error.WriteLine("Window has an empty rectangle.");
            return false;
        }

        using (var bitmap = new Bitmap(window.Bounds.Width, window.Bounds.Height, PixelFormat.Format24bppRgb))
        using (Graphics graphics = Graphics.FromImage(bitmap))
        {
            IntPtr hdc = graphics.GetHdc();
            bool printed;
            try
            {
                printed = PrintWindow(window.Handle, hdc, PwRenderFullContent);
            }
            finally
            {
                graphics.ReleaseHdc(hdc);
            }

            bitmap.Save(outputPath, ImageFormat.Png);
            var colors = new HashSet<int>();
            long nonBlank = 0;
            long sampled = 0;
            for (int y = 0; y < bitmap.Height; y += 4)
            {
                for (int x = 0; x < bitmap.Width; x += 4)
                {
                    int argb = bitmap.GetPixel(x, y).ToArgb();
                    colors.Add(argb);
                    if ((argb & 0xFFFFFF) != 0xFFFFFF)
                    {
                        nonBlank++;
                    }
                    sampled++;
                }
            }

            double ratio = sampled == 0 ? 0 : (double)nonBlank / sampled;
            Console.WriteLine("PrintWindow: " + printed);
            Console.WriteLine("UniqueSampledColors: " + colors.Count);
            Console.WriteLine("NonBlankRatio: " + ratio.ToString("0.0000"));
            Console.WriteLine("OutputPath: " + outputPath);
            return printed && colors.Count >= 2 && ratio >= 0.02;
        }
    }

    private static string GetOption(string[] args, string name)
    {
        for (int index = 0; index + 1 < args.Length; index++)
        {
            if (string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
            {
                return args[index + 1];
            }
        }
        return null;
    }

    private static bool HasFlag(string[] args, string name)
    {
        foreach (string arg in args)
        {
            if (string.Equals(arg, name, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    private static int? ParsePid(string value)
    {
        int pid;
        return Int32.TryParse(value, out pid) ? (int?)pid : null;
    }
}
