# Syncing `main` into `v2/main`

This skill does not describe the synchronization workflow. The workflow lives in one place: the
companion file `references/plan.md`, beside this skill. That file is a complete VIPER plan and is the
**canonical source of truth**. This skill only explains how to materialize it and run it.

Load `viper-execution-rules` before executing anything.

## Prerequisites

The `viper-plans` facet must be installed in the project. It supplies the execution rules and the
plan tools. If neither the plan tools nor `.opencode/plans/` are available, say so and stop — do not
improvise a substitute workflow.

## Plan tools

The `viper-plans` MCP server provides `viper-write-plan`, `viper-read-plan`, `viper-edit-plan`,
`viper-list-plans`, and `viper-delete-plan`. A client may expose them under a prefixed name such as
`viper-plans_viper-write-plan`, so treat any tool whose name ends with one of those canonical names
as that tool. Prefer them whenever they are available; otherwise use the file-tool fallback noted
below.

## Procedure

1. **Read the canonical plan.** Read `references/plan.md` relative to this skill's own directory, as
   reported when the skill was loaded. Read it in full.

2. **Materialize it as the runtime plan.** Persist that exact content under the plan name
   `main-to-v2-sync`, using `viper-write-plan` if available; otherwise write
   `.opencode/plans/main-to-v2-sync/plan.md` with your file tools, creating the directory if needed.

   Overwrite any existing plan of that name without asking. The plan store holds a **generated copy**,
   not the source. Never edit `references/plan.md` to reflect a runtime decision, and never merge a
   stale runtime copy back into it.

3. **Execute it immediately.** Count the `### Step` headings, state the plan name and step count in
   one line, then follow the `viper-execution-rules` protocol: one TODO per step heading, steps in
   document order, Propose and Review steps gated on the user, and a stop on any Verify failure.

   Do not add an outer approval cycle around the plan. The plan carries its own Propose and Review
   gates, and an invocation of the command is authorization to begin it.

4. **Do not delete the runtime plan** at the end of the run unless the user asks. It is cheap to
   regenerate and useful to inspect.

## Authority

The plan is authoritative over this skill and over the command that loads it. If the plan and any
prose here appear to disagree, the plan wins, and the disagreement is a bug in this facet worth
reporting to the user.

Beginning the run authorizes only what the plan authorizes: it prepares and verifies a **local**
branch. Pushing that branch or opening a pull request happens only through the plan's own explicit
user gate. Nothing in this facet ever merges a pull request or publishes a package.
