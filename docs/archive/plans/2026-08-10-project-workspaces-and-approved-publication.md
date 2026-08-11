# Project Workspaces And Approved Publication

- Status: Completed
- Plan date: 2026-08-10
- Completion date: 2026-08-10

## Goal

Replace process-cwd workspace inference with one explicit Project repository.
Create one Runtime-owned branch and physical worktree per Subtask, require the
Executor to synchronize its branch with local `main`, and publish the complete
branch only after exact user approval.

## Product Decisions

- `anyfusion --project <path>` selects the Project; omission uses
  `~/AnyFusionProjects/default`.
- The selected path is one top-level Git repository and may not be nested in a
  higher repository.
- A non-Git directory is initialized on `main` and committed as the Project
  baseline.
- Existing repositories must be clean, on `main`, and contain no nested Git
  repositories or submodules.
- Runtime creates branch names and worktree paths.
- One Subtask owns one branch and one worktree across every attempt.
- Native worktree execution remains trusted and does not claim filesystem
  isolation.
- Executor commits its result and merges local `main` into its branch.
- Runtime validates the assigned branch, clean state and main ancestry.
- Publication waits for user approval and merges the complete candidate
  branch.
- Approval denial blocks the Subtask and preserves its branch/worktree.
- Approved publication deletes the Subtask worktree and branch.
- Downstream work starts only after dependencies are merged to `main`.
- Remote Git and file-selective publication are deferred.

## Ownership And Interfaces

- Add a Project domain/application service for path validation,
  initialization, lookup and main-head checks.
- Add schema 33 `projects` and Task `project_id` facts.
- Pass one resolved Project binding through the composition root and Session;
  remove production fallback to `process.cwd()`.
- Refactor managed Git workspaces to use the Project repository directly
  instead of cloning/importing one repository per Task generation.
- Extend publication persistence with approval facts and exact main/candidate
  commits.
- Reuse permission-review presentation for Runtime-created
  `repository_promotion` requests; approval applies publication rather than
  recovering an Executor attempt.

## Delivery Stages

1. Add ADR, Project types/service/repository, schema 33 and CLI project
   resolution.
2. Bind new Tasks to the active Project and expose the Project root to Planner,
   Gateway and Session without using launch cwd.
3. Create deterministic per-Subtask branches/worktrees from Project `main`;
   preserve them across attempts.
4. Update Executor instructions and completion landing so the Executor leaves
   one clean candidate branch containing current local `main`.
5. Persist a pending promotion request and project it through existing user
   approval UI.
6. On approval, validate the exact base, merge the whole branch into Project
   `main`, publish completion facts, and delete worktree/branch.
7. On denial or stale main, block/preserve the Subtask for explicit recovery.
8. Remove plain-directory source import and process-cwd workspace inference.
9. Purge only the failed World Cup Task's Runtime-managed empty workspace
   residue before the next real validation.

## Validation

- Project path tests: default path, exact Git root, ancestor repository
  rejection, nested repository rejection, dirty main rejection and non-Git
  initialization.
- Storage tests for schema 33, Project persistence and Task binding.
- Managed worktree tests for deterministic Project branches, one-to-one
  identity, retry persistence and cleanup.
- Attempt tests for assigned-branch, clean-worktree and main-ancestor
  validation.
- Publication tests for pending approval, denial preservation, stale-main
  rejection, approved whole-branch merge and cleanup.
- Dependency tests proving downstream worktree creation occurs only after
  dependency promotion.
- Launcher/CLI tests for `--project` and default Project resolution.
- `npm run lint`
- `npm run build`
- Focused Vitest suites at Project, Session, Execution, Storage and CLI seams.

## Completion Record

Delivered:

- Added explicit `--project` startup selection with
  `~/AnyFusionProjects/default` fallback, exact top-level repository validation,
  non-Git initialization and durable Project-to-Task binding.
- Replaced Task-private imported repositories with one persistent branch and
  physical worktree per Subtask from Project `main`.
- Required Executors to commit all changes, merge local `main`, resolve
  conflicts and leave the assigned branch clean.
- Added exact `repository_promotion` user review. Approval merges the complete
  branch into Project `main` and removes the worktree/branch; denial blocks and
  preserves them.
- Added stale-main resynchronization for concurrent independent Subtasks and
  prevented orphan approval requests when cancellation or terminal sealing
  wins before publication becomes durable.
- Rebased published artifact and artifact-handoff paths from the deleted
  Subtask worktree to their durable Project `main` locations.
- Enabled the registered Codex and Pi adapters to perform the one
  Kernel-authorized response-only completion correction. The correction runs
  without tools in an isolated temporary home and cannot touch the Subtask
  worktree.
- Updated real-task smoke to use an isolated temporary Project and approve the
  exact pending `repository_promotion` through the existing Session permission
  channel.
- Added fresh-only schema 33 Project and approval facts, updated current
  authority documents, and aligned the Docker development data volume.
- Backed up the failed schema 32 World Cup Task database, removed only that
  Task's old Runtime-managed workspace/repository residue, and initialized a
  clean schema 33 database plus default Project repository.

Validation:

- `npm test -- --run`: 192 test files passed, 770 tests passed and 15
  tests skipped.
- `npm run lint`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- Real startup: `anyfusion --no-build --project /root/AnyFusionProjects/default`
  reached the connected Planner TUI with schema 33, a clean Project `main`, and
  zero Tasks.
- The first real Codex artifact smoke reached approved publication but exposed
  an artifact path that still referenced the deleted Subtask worktree. Artifact
  and handoff paths were rebased to Project `main`, then the smoke passed:
  `anyfusion --no-build smoke --scenario artifact --timeout 300`.
- Real Pi research smoke passed:
  `anyfusion --no-build smoke --executor pi --scenario pi-research --timeout 300`.
- A real no-tool Pi response-only invocation returned the required literal
  completion marker followed by strict JSON, confirming the production
  correction command and prompt shape.
- Runtime verification reports both `codex-cli` and `pi-agent` as
  `enabled / verified`; successful smoke audits are durable and no Tasks or
  test worktrees remain.

Closing commit: not created; the completed change set remains in the working
tree for user review.
