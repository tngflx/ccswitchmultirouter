"""Guard required check identities and execute the workflow's prerequisite gates."""

import os
from pathlib import Path
import re
import shutil
import subprocess
import unittest


WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"
DOCS_CONDITION = "needs.scope.outputs.scope != 'docs'"


def job_block(source, name):
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  \S|\Z)", source, re.M | re.S)
    if not match:
        raise AssertionError(f"Missing CI job: {name}")
    return match.group(1)


def step_blocks(job):
    return re.split(r"^      - name: ", job, flags=re.M)[1:]


def prerequisite_gate(job):
    step = step_blocks(job)[0]
    match = re.search(r"^        run: \|\n((?:          .*\n)+)", step, re.M)
    if not match:
        raise AssertionError("The first step must explicitly check its prerequisites")
    return "\n".join(line[10:] for line in match.group(1).splitlines())


def bash_path():
    if os.name == "nt":
        git = shutil.which("git")
        if git:
            candidate = Path(git).resolve().parents[1] / "bin/bash.exe"
            if candidate.is_file():
                return str(candidate)
    bash = shutil.which("bash")
    if not bash:
        raise RuntimeError("Bash is required to exercise GitHub Actions result gates")
    return bash


class WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = WORKFLOW.read_text(encoding="utf-8")

    def test_scope_fetches_complete_history_and_tests_classifier(self):
        scope = job_block(self.source, "scope")
        self.assertIn("fetch-depth: 0", scope)
        self.assertIn("python3 -B -m unittest discover -s scripts/ci -p 'test_*.py'", scope)
        self.assertIn("python3 -B scripts/ci/changed_files.py", scope)
        self.assertIn("scope: ${{ steps.changes.outputs.scope }}", scope)

    def test_windows_javascript_lifecycle_suite_remains_gated(self):
        backend = job_block(self.source, "backend")
        step = next(block for block in step_blocks(backend) if "npm run test:lifecycle" in block)
        self.assertIn(f"if: {DOCS_CONDITION} && runner.os == 'Windows'", step)
        self.assertIn("actions/setup-node@", backend)

    def test_frontend_retains_every_existing_gate(self):
        frontend = job_block(self.source, "frontend")
        self.assertIn("name: Frontend Checks", frontend)
        self.assertIn("needs: scope", frontend)
        self.assertIn("if: ${{ always() }}", frontend)
        for command in (
            "pnpm install --frozen-lockfile",
            "pnpm typecheck",
            "pnpm catalog:verify",
            "pnpm format:check",
            "pnpm test:runner",
            "pnpm test:unit",
            "pnpm contract:check",
            "pnpm contract:test",
            "python -m unittest discover -s scripts/tests -p test_hosted_web_search_canary.py",
        ):
            with self.subTest(command=command):
                step = next(block for block in step_blocks(frontend) if command in block)
                self.assertIn(f"if: {DOCS_CONDITION}", step)

    def test_rustfmt_is_a_standalone_gate(self):
        rustfmt = job_block(self.source, "rustfmt")
        self.assertIn("needs: scope", rustfmt)
        self.assertIn("if: ${{ always() }}", rustfmt)
        step = next(block for block in step_blocks(rustfmt) if "cargo fmt --check" in block)
        self.assertIn(f"if: {DOCS_CONDITION}", step)
        self.assertIn("cargo fmt --check --manifest-path src-tauri/Cargo.toml", step)

    def test_backend_retains_names_matrix_and_heavy_checks(self):
        backend = job_block(self.source, "backend")
        self.assertIn("name: Backend Checks (${{ matrix.os }})", backend)
        self.assertIn("needs: [scope, frontend, rustfmt]", backend)
        self.assertIn("if: ${{ always() }}", backend)
        self.assertIn("os: [ubuntu-22.04, windows-latest, macos-latest]", backend)
        runner = re.search(r"    runs-on: >-\n(.*?)    strategy:", backend, re.S).group(1)
        for condition in (
            "needs.scope.result == 'success'",
            DOCS_CONDITION,
            "needs.frontend.result == 'success'",
            "needs.rustfmt.result == 'success'",
            "matrix.os || 'ubuntu-latest'",
        ):
            self.assertIn(condition, runner)
        steps = step_blocks(backend)
        self.assertNotIn("cargo fmt", backend)
        self.assertTrue(any("cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings" in step for step in steps))
        self.assertTrue(any("cargo test --manifest-path src-tauri/Cargo.toml" in step for step in steps))
        for step in steps[1:]:
            with self.subTest(step=step.splitlines()[0]):
                self.assertIn(f"if: {DOCS_CONDITION}", step)

    def test_prerequisite_gates_fail_closed_and_docs_stay_green(self):
        statuses = ("success", "failure", "cancelled", "skipped")
        shell = bash_path()
        for job_name in ("frontend", "rustfmt", "backend"):
            script = prerequisite_gate(job_block(self.source, job_name))
            cases = [
                ("success", "docs", "success", "success", True),
                ("success", "full", "success", "success", True),
                ("success", "", "success", "success", True),
                ("success", "unknown", "success", "success", True),
            ]
            cases.extend((state, "docs", "success", "success", False) for state in statuses[1:])
            if job_name == "backend":
                for change_scope in ("docs", "full", ""):
                    cases.extend(("success", change_scope, state, "success", False) for state in statuses[1:])
                    cases.extend(("success", change_scope, "success", state, False) for state in statuses[1:])
            for scope, change, frontend, rustfmt, succeeds in cases:
                with self.subTest(job=job_name, scope=scope, change=change, frontend=frontend, rustfmt=rustfmt):
                    env = dict(os.environ, SCOPE_RESULT=scope, CHANGE_SCOPE=change, FRONTEND_RESULT=frontend, RUSTFMT_RESULT=rustfmt)
                    result = subprocess.run([shell, "--noprofile", "--norc", "-e", "-c", script], env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode == 0, succeeds, result.stderr)


if __name__ == "__main__":
    unittest.main()
