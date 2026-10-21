import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "codex-history-tool"
    / "codex_history_tool.py"
)
SPEC = importlib.util.spec_from_file_location("codex_history_powershell_test_module", MODULE_PATH)
history_tool = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = history_tool
SPEC.loader.exec_module(history_tool)


class CodexHistoryPowerShellTests(unittest.TestCase):
    def test_windows_detection_uses_only_bounded_powershell_7(self):
        with patch.object(history_tool.platform, "system", return_value="Windows"):
            with patch.object(
                history_tool.subprocess,
                "check_output",
                return_value="42 Codex.exe\n99 unrelated.exe\n",
            ) as run:
                self.assertEqual(history_tool.detect_running_codex_processes(), ["42 Codex.exe"])
        command = run.call_args.args[0]
        self.assertEqual(command[0], "pwsh.exe")
        self.assertIn("-NonInteractive", command)
        self.assertIn("$PSVersionTable.PSVersion.Major -lt 7", command[-1])
        self.assertIn("Get-CimInstance Win32_Process -ErrorAction Stop", command[-1])
        self.assertEqual(run.call_args.kwargs["timeout"], 10)
        self.assertEqual(run.call_args.kwargs["encoding"], "utf-8")

    def test_windows_detection_failure_does_not_claim_no_running_codex(self):
        failures = [
            FileNotFoundError("[REDACTED_PROCESS_QUERY]"),
            subprocess.TimeoutExpired("[REDACTED_PROCESS_QUERY]", 10),
            subprocess.CalledProcessError(1, "[REDACTED_PROCESS_QUERY]"),
        ]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                with patch.object(history_tool.platform, "system", return_value="Windows"):
                    with patch.object(
                        history_tool.subprocess, "check_output", side_effect=failure
                    ) as run:
                        with self.assertRaises(RuntimeError) as error:
                            history_tool.detect_running_codex_processes()
                self.assertIn("PowerShell 7", str(error.exception))
                self.assertNotIn("REDACTED", str(error.exception))
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.args[0][0], "pwsh.exe")


if __name__ == "__main__":
    unittest.main()
