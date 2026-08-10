# ADR-0027: Project Workspaces And User-Approved Branch Publication

- **Status**: Accepted
- **Date**: 2026-08-10
- **Scope**: Project directory selection, persistent project repositories, Subtask worktrees, local-main synchronization, user-approved publication, and cleanup
- **Amends**: ADR-0024 and ADR-0025
- **Preserves**: ADR-0011, ADR-0020, ADR-0021 and ADR-0026

## Context

The existing Runtime derives one global source root from the process working
directory. A new Task may therefore import the launch directory as its Git
source. Launching AnyFusion from a home directory can recursively stage
unrelated repositories, configuration and private files. The source directory,
Runtime directory and Task workspace are not distinct product concepts.

The first product release needs a smaller, explicit model. A user selects one
project directory before Task execution. The project directory is the root of
one ordinary Git repository whose `main` branch is the durable project
baseline. Every Subtask receives one Runtime-created branch and one physical
worktree from that repository.

This phase prioritizes understandable behavior and low implementation risk. It
does not introduce a filesystem sandbox, remote Git synchronization,
file-selective publication or multi-Task scheduling.

## Decision

### Project binding

The Runtime accepts an explicit `--project <path>` startup option. When omitted,
the project defaults to `~/AnyFusionProjects/default`.

The selected path must not be inside another Git repository. If it is already a
Git repository, the selected path must equal its top-level directory, its
checked-out branch must be `main`, its worktree must be clean, and it must not
contain nested repositories or submodules. If it is not a Git repository, the
Runtime creates the directory, rejects nested repositories, initializes
`main`, configures a Runtime-local Git identity and commits the complete
initial directory contents.

Project identity and repository facts are persisted independently from Tasks.
Every Task is bound to exactly one Project and records the Project `main`
commit from which its graph begins. Task purge never deletes the Project
repository.

The process launch directory and Planner process directory are not project
authority. Runtime, Planner and Gateway receive the resolved Project root
explicitly.

### Subtask worktrees

Runtime, not Planner, generates every branch name and worktree path. The
canonical shapes are:

```text
anyfusion/task/<task-id>/subtask/<subtask-id>
$METACLAW_HOME/project-worktrees/<project-id>/workspaces/<task-id>/<generation-id>/<subtask-id>/files
```

One Subtask maps to one branch and one physical worktree. Retry, fallback,
continuation and user review preserve both until the Subtask is published,
cancelled or explicitly purged.

The Executor starts with the assigned worktree as `cwd`. Prompt instructions
forbid switching branches, modifying `main`, or using another worktree. This is
a behavioral constraint only. The native worktree backend continues to run as
the Runtime user and this phase makes no filesystem-isolation claim.

### Candidate preparation

The Executor owns ordinary Git operations inside its assigned branch. Before
reporting completion it must:

1. commit its complete result;
2. merge the current local `main` into its assigned branch;
3. resolve and commit conflicts itself;
4. leave the assigned worktree clean.

Remote fetch, pull, push and rebase are outside this phase.

Runtime validates that the worktree is clean, the assigned branch is checked
out, `main` has not been modified unexpectedly, and the current local `main`
is an ancestor of the candidate commit. Failure remains an Executor attempt
failure and preserves the worktree for recovery.

### User-approved publication

Successful completion leaves the Subtask in `awaiting_integration` and creates
a durable publication in `awaiting_approval`. Publication does not merge
automatically.

Runtime creates an exact `repository_promotion` authorization request and
projects it through the existing approval UI. The request identifies Project,
Task, Subtask, assigned branch, main base commit, candidate commit, changed
paths and diff statistics.

The existing permission-review presentation may be reused, but publication
application is Runtime-owned. Approval authorizes one exact candidate
promotion; denial blocks the Subtask and preserves its branch and worktree.

Approval application rechecks that the Project main worktree is clean and
still points to the approved base commit. If it changed, publication returns to
the Subtask for another local-main merge and a new approval. Otherwise Runtime
merges the complete candidate branch into `main`, publishes completion facts,
marks the Subtask done, and deletes the Subtask worktree and branch.

Independent Subtasks may execute concurrently, but promotions are serialized.
A dependent Subtask becomes runnable only after every direct dependency has
been approved and merged into `main`; its worktree is then created from the
new Project main commit.

### Whole-branch publication

The initial product merges the complete candidate branch. Planner describes
required delivery content but does not declare file paths or merge filters.
Runtime shows changed paths and diff statistics during review.

Selective artifact-only publication is explicitly deferred. It must not be
added as an implicit path heuristic or partial cherry-pick without a later
contract decision.

## Ownership

- Application Shell resolves the startup Project selection.
- Task Domain owns the Task-to-Project binding.
- Execution Runtime owns Project validation, worktree allocation, publication
  validation, approved merge and cleanup.
- Planner owns semantic Subtask planning only and never emits host paths,
  branch names or Git commands.
- ControlKernel owns approval and denial policy through the durable event and
  Decision path.
- Storage persists Projects, Task bindings, worktrees, publications and exact
  user authorization facts.

## Consequences

- Launching AnyFusion from `$HOME` can no longer import `$HOME`.
- Project history persists across Tasks while Subtask worktrees remain
  disposable after approved publication.
- Main is a user-reviewed completion boundary.
- Whole-branch approval exposes unrelated Executor changes to user review but
  intentionally keeps implementation simple.
- Native Executor processes can technically access other host paths. Prompt,
  `cwd` and validation reduce accidental misuse but are not a security
  boundary.
- Existing automatic integration and Runtime-owned conflict-repair publication
  are replaced for ordinary Subtask completion by Executor-owned local-main
  synchronization and user approval.
