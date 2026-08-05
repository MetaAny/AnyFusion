---
status: completed
plan_date: 2026-08-05
completion_date: 2026-08-05
---

# Node 22 Single Runtime Image Migration

## Goal

Unify MetaClaw and the sibling AnyFusion-Pi Planner on one Node.js 22.19+
runtime environment while preserving their existing process seam. Windows and
Linux builds produce one final runtime image containing both applications, two
independent dependency trees, and exactly one Node installation.

## Runtime Contract

```text
one Node 22.19+ runtime image
  -> MetaClaw control process (/app)
  -> AnyFusion Planner process (/opt/anyfusion-planner/app)
  -> JSONL / Unix socket process seam remains unchanged
```

- MetaClaw and Planner do not share source modules, in-process objects, or
  `node_modules` directories.
- The Planner launcher and Planner MCP both resolve the final image's absolute
  Node executable. The Planner does not carry a private Node binary.
- The runtime build consumes the sibling AnyFusion-Pi repository through a
  required BuildKit named context. It does not consume a prebuilt Planner image.
- There is no Node 20 runtime, `ANYFUSION_PI_IMAGE` build argument, embedded
  `/opt/anyfusion-planner/node`, or fallback build path.
- Executor attempts remain separate canonical sandbox images. Their isolation
  is a security and resource contract, not a Node-version workaround.

## Ownership And Dependency Direction

- AnyFusion-Pi owns Planner source, offline build, assets, and Planner runtime
  dependencies.
- MetaClaw owns the final runtime image composition, Planner process launch,
  Planner MCP command injection, Kernel handoff, and Executor sandbox launch.
- The existing Planner host protocol and PlanningAgent interfaces remain the
  only process seams; this migration adds no application interface.
- The image composition may copy the two applications into one filesystem, but
  it must not link their dependency graphs or move Planner authority into the
  MetaClaw process.

## Delivery

1. Raise MetaClaw package, compiler, CI, builder, and runtime baselines to
   Node.js 22.19+.
2. Convert the AnyFusion-Pi Planner artifact to use the image Node executable
   and remove its embedded Node tree.
3. Replace the prebuilt Planner image flow with one BuildKit named-context
   build in `docker/Dockerfile.runtime`, the Windows shell workflow, and smoke.
4. Add image-level assertions for the Node version, shared executable, isolated
   dependency trees, missing embedded runtime, and both process entry points.
5. Update ADR-0015, `CONTEXT.md`, current technical docs, CI declarations,
   repository guides, and public READMEs together.
6. Run both repositories' full checks/tests, MetaClaw's complete Linux suite,
   Planner MCP smoke, two-turn Planner session smoke, artifact smoke, and
   Python artifact smoke.
7. Only after all gates pass, remove the superseded standalone Planner image
   and the old runtime/SSH image IDs captured before rebuilding.

## Validation Gates

- AnyFusion-Pi: `npm run check`, `./test.sh`, and `npm run build:offline`.
- MetaClaw host: `npm run lint`, `npm run build`.
- MetaClaw Docker: full `npm test` from `Dockerfile.test`.
- Unified runtime: exact Node 22.19+ version, no embedded Planner Node or
  standalone Planner image path, both dependency roots present, Planner
  `--help`, and Planner MCP smoke.
- Behavioral smoke: `planner-session`, `artifact`, and `python-hello` scenarios.
- Cleanup: legacy Planner and superseded runtime/SSH images are removed only
  after every preceding gate passes.

## Completion Record

Delivered one Node 22.19.0 runtime image built directly from the MetaClaw and
AnyFusion-Pi repository contexts. MetaClaw and Planner retain separate
processes and dependency trees while sharing `/usr/local/bin/node`. The
prebuilt Planner image input, embedded Planner Node tree, Node 20 baseline, and
separate SSH image layer were removed without a fallback path.

Validation completed on 2026-08-05:

- AnyFusion-Pi `npm run check` and `npm run build:offline` passed.
- AnyFusion-Pi Linux non-E2E suite passed in its Node 22.19.0 test image.
- MetaClaw `npm run lint` and Node 22 target build passed.
- MetaClaw Linux suite passed: 186 files and 737 tests passed; 4 files and 15
  tests were skipped by their existing conditions.
- Unified-image assertions passed for Node `v22.19.0`, `/usr/local/bin/node`,
  separate application dependency roots, missing embedded Planner Node, and
  Planner CLI startup.
- Planner MCP smoke passed with all 8 registered tools.
- `planner-session`, `artifact`, and `python-hello` behavior smokes passed.
- Superseded Planner, runtime, and SSH image tags were removed only after all
  preceding gates passed.

Closing commit: the delivery commit containing this completion record.
