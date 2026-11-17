# Sub-Agent governance: guidance is not a sandbox

## What this feature controls

CCSwitchMulti generates Sub-Agent role instructions and parent delegation
instructions from the current routing plan. This is a behavioral governance
layer: it makes task scope, resource ownership, repository restrictions, and
explicit user authorization and repository requirements visible to the model.

**It is not an operating-system sandbox, a tool lock, or a guarantee that a model
will obey prose.** A Sub-Agent with an unrestricted shell or another privileged
tool can still attempt operations that its instructions prohibit. Real execution
permissions must be enforced by the host or by a trusted restricted executor.

## The controls are separate

| Setting or mechanism                                 | What it does                                                                                                                                    | What it does not do                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Write scope (instruction guidance)                   | Describes the permitted editing behavior in generated role instructions.                                                                        | Does not make the filesystem read-only, restrict shell commands, or remove tools.        |
| Custom developer instructions                        | Adds role-specific text while retaining the generated baseline scope, ownership, and repository restrictions.                                   | Cannot remove the generated baseline text; does not guarantee the model will follow it.  |
| All Sub-Agent reasoning effort: Profile / High / Max | Applies a reversible effort override where the model supports it, without replacing saved profile policies or changing the main agent's effort. | Does not restrict operational access, grant lifecycle authority, or establish a sandbox. |
| Inherited host sandbox and tool permissions          | Determines the execution access actually granted by the host.                                                                                   | Is not configured or narrowed by the Write scope dropdown.                               |
| Projection readback                                  | Checks that current managed parent guidance and owned role files were written as intended.                                                      | Does not prove that a running session loaded them or that any model complied.            |

The existing questionnaire and custom text remain the canonical profile data.
There is no additional persisted per-role permission state, fake tool lock, or
unsupported per-role sandbox configuration behind these labels.

## What the governance hardening fixes

In an updated build, when the app projects Codex configuration:

- Managed parent guidance carries the baseline delegation boundaries across V1,
  V2, native/built-in, and no-custom-profile configurations. It does not assume a
  child sees the parent's full conversation history.
- Generated roles retain canonical scope and ownership guidance even when a
  profile has custom developer instructions. Custom text supplements that
  baseline rather than replacing it.
- Delegation must carry the relevant user and repository restrictions, the
  assigned scope and resource owner, and the exact permitted and prohibited
  side effects. Workers must report side effects back to the parent.
- Parent and worker guidance both distinguish a delegated objective from
  authorization for image/release builds, shared-process or container lifecycle
  changes, installation, publishing, or release. Those actions require explicit
  user authorization and compliance with repository rules. Being the main agent
  or a built-in role does not grant that authority either.
- Managed projection verification checks current guidance and owned generated
  role content, rather than treating an empty configured-role list as evidence
  that all governance is present. User-owned text and unrelated host security
  configuration must remain intact.

These fixes close instruction-generation and projection-verification gaps. They
**do not** turn prompts into an execution authorization boundary.

## Editable prose and full generated output

The Description and Developer instructions controls edit only authored role
prose. The backend derives `editableDescription` and
`editableDeveloperInstructions` from the current canonical profile; these are
preview fields, not additional persisted settings. The full description,
developer instructions, and TOML remain read-only generated output, including
current modality and mandatory scope/governance guidance.

Editing automatic prose does not copy those generated suffixes into a saved
custom override. A later Write scope change regenerates the current boundary
from the questionnaire rather than reusing text copied from an earlier scope.
If an older backend does not return the clean editable fields, the automatic
authoring controls stay empty instead of falling back to full generated policy;
update the backend to obtain the clean automatic defaults.

Existing saved custom text is preserved, including any generated text that an
older editor may already have copied into an override. The app does not
heuristically strip saved user prose. Review and remove copied text deliberately,
or use Restore automatic role description / Restore automatic developer
instructions to remove the corresponding override and regenerate it from the
current canonical settings.

## Interpreting Write scope

All three choices are instructions, not different host permission modes:

- **Read-only:** inspect and report without editing files. The dropdown does not
  technically prevent writes, network calls, process execution, or daemon access.
- **Bounded changes:** edit only the files explicitly assigned to the role. Do
  not expand ownership without approval.
- **Complex changes:** cross-module work may be appropriate within the delegated
  objective, but final integration, merging, and release are not implicitly
  delegated.

Task strengths such as Testing or Complex implementation also do not authorize
arbitrary operational commands. An explicitly permitted focused test may compile
code and start its expected test-runner processes within the authorized scope;
that is not permission to start unrelated services, rebuild applications or
images, stop shared processes, or publish a release.

For example, permission to run a specific frontend test does not by itself permit
`pnpm build`, application startup, container recreation, or image builds. Keep
repository build gates and verification requirements intact; never bypass them
to make a delegated action succeed.

## Delegation and shared resources

Use one explicitly designated owner for each shared side-effecting resource,
such as a development server, container stack, image identity, or release lane.
A worker should receive a bounded source/test task rather than assuming it may
manage those resources.

A useful delegation contract states:

1. The objective and the files or resources owned by this worker.
2. Applicable user instructions and repository rules, including rules that the
   child may not otherwise see.
3. The exact side-effecting commands or actions already authorized, if any.
4. Actions explicitly prohibited, such as image/release builds, image tags,
   shared-service lifecycle changes, installation, or release.
5. What to do when the task needs additional authority: stop that action, report
   the requirement, and obtain explicit user authorization consistent with
   repository rules rather than treating parent coordination as permission.
6. The required evidence and side-effect report on completion.

The parent coordinates work but cannot manufacture authority that the user or
repository has not granted. Cooperative operation locks prevent overlapping
cooperating actions; they are not authorization controls and do not block raw
commands that bypass the lock.

## What a real hard boundary requires

If workers must be unable to mutate containers or releases, enforce that outside
the model's instructions:

- Give workers a restricted identity or executor with the filesystem, process,
  network, and credential access actually needed for their assigned task.
- Remove worker access to the Docker/container daemon and other privileged
  lifecycle endpoints. Hiding the CLI alone is insufficient if a socket, named
  pipe, remote endpoint, credential, or another connector still grants access.
- Route privileged actions through a trusted executor that validates the exact
  allowed operation and resource independently of the model's prose.
- Keep lifecycle/release authority in a separate, explicitly authorized lane.
  Scope or remove alternative shell, MCP, connector, and remote-execution routes
  that would bypass that lane.

This codebase's role instructions do not implement that executor or prove that
all such access has been removed. Do not describe workers as sandboxed solely
because Write scope says Read-only or reasoning effort says High.

## Applying and verifying changes

Save the plan and inspect the backend's persistence and projection result. An
inactive plan may be saved without changing live files; a pending projection is
not a completed activation. After the appropriate configuration has been
projected, restart Codex Desktop/app-server and start a new session. Existing
sessions are not guaranteed to reload the new instructions.

Source regression tests and file readback prove only the covered source and
projection behavior. They do not prove that an installed application was rebuilt
or installed, that a running session loaded the new policy, or that a live model
followed it. A live runtime audit must use the repository's configured monitoring
and scoped evidence; do not substitute an unrequested broad UI or Docker audit.

Relevant implementation areas are
`src/components/codex/CodexSubagentProfileEditor.tsx`,
`src-tauri/src/codex_subagent_profiles.rs`, and
`src-tauri/src/codex_config.rs`. Frontend and backend regression tests cover the
clarified labels, retained profile choices, baseline generation, and managed
projection verification; actual execution isolation remains a host concern.
