---
layout: ../layouts/BaseLayout.astro
title: "stack · wire — an implementable agent runtime"
description: "A source-backed proposal for isolated execution, durable coordination, bounded authority, and evidence-driven improvement."
markdownHref: /stack.md
---

# The agent-native stack

**A design proposal, not an implemented operating system.** Revised 2026-10-18. [Clean Markdown](/stack.md) · [Hardware sketch](/substrate) · [Corpus](/)

Build on commodity hardware and Linux first. Use Wasmtime for bounded WebAssembly components, Firecracker for workloads that need a Linux guest, and Temporal for durable orchestration. Put a small authority-and-effects broker between agents and the outside world. Keep policy outside the model.

The useful novelty is the contract between these pieces: a task has explicit authority, a finite budget, a durable history, attributable evidence, and a known policy for uncertain outcomes. These are recommendations to test, not claims of superiority over existing systems.

## 1. What current systems already demonstrate

- **Wasmtime provides an execution boundary.** Wasm code interacts with its host through explicitly linked imports; WASI filesystem access follows a capability model. Host functions remain trusted code. This is instance isolation, not a proof that the application has no bugs or that arbitrary native code is safe. [Security documentation](https://docs.wasmtime.dev/security.html).
- **Determinism is configurable, not automatic.** Wasmtime documents nondeterministic imports, NaN payloads, relaxed SIMD, memory/table growth, and interruption as sources of variation. Replay must constrain or record them. [Deterministic execution](https://docs.wasmtime.dev/examples-deterministic-wasm-execution.html).
- **Execution can be bounded.** Wasmtime distinguishes deterministic fuel accounting from wall-time-driven epoch interruption. Neither replaces limits on blocking host calls, memory, network traffic, or storage. [Interruption documentation](https://docs.wasmtime.dev/examples-interrupting-wasm.html).
- **Firecracker isolates Linux guests.** Its design combines KVM with process-level defense in depth and recommends the jailer in production. It explicitly does not filter guest egress; the host must enforce that. A microVM is not an authorization policy. [Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md).
- **Temporal separates durable decisions from effects.** Workflow replay checks generated commands against event history; Activities communicate with the environment and have retries and timeouts. Retrying an Activity does not make an arbitrary external write exactly once. [Workflow execution](https://docs.temporal.io/workflow-execution), [Activity execution](https://docs.temporal.io/activity-execution).
- **Restate is a concrete alternative to evaluate.** It journals results of operations wrapped in durable steps and provides persistent state, timers, and service communication. Journaling a result still leaves an external effect/receipt crash boundary to analyze. [Context actions](https://docs.restate.dev/foundations/actions).

These primary pages were retrieved on 2026-10-18. They establish documented mechanisms, not independent benchmarks or a complete survey. The earlier claim that nobody builds these mechanisms was unsupported.

## 2. Choose boundaries before components

```text
human / application
        |
task admission: identity, authority, budget, artifact versions
        |
durable coordinator: plan, schedule, retry, cancel, reconcile
        |
worker supervisor ---- bounded Wasm or Linux guest
        |                         |
        +---- effect broker <-----+
                  |
          allowlisted external services
                  |
          receipts + artifact store
```

Start with one coordinator service, one worker type, one transactional metadata store, and one artifact store. Use Temporal's existing service for durable scheduling rather than writing a second consensus protocol. Deploy the broker separately from untrusted workers. Do not start with a new ISA, microkernel, distributed filesystem, GC, or home-grown Raft implementation.

The trusted computing base includes the host OS, virtualization/runtime, coordinator, broker, storage, credentials, deployment pipeline, and relevant dependencies. Calling the kernel small does not make that whole chain verified. No formal correctness proof is claimed here.

## 3. The task is the unit of authority

An admitted task binds:

- Principal and tenant; parent task, if any; immutable task and attempt IDs.
- Exact program/component digest, schema version, runtime configuration, and input artifact references.
- Broker-owned grant handles for specific operations on specific resources. Handles are resolved under the authenticated principal; knowing an ID alone grants nothing.
- Deadline, retry policy, maximum children, concurrency, output size, CPU/fuel, memory, storage, network, model-token and monetary limits.
- Required approval class, output validators, and a policy for uncertain external effects.

Only trusted admission code can mint grants. A child receives the intersection of the parent's current authority and its requested scope. Delegation also reserves part of the parent's remaining budget transactionally; spawning children never multiplies the budget. Expiry and revocation are checked at effect dispatch, not only when a channel opens.

Revocation stops new authorized dispatches. It cannot unsend a request, erase data already read, or roll back an accepted remote write. Already-dispatched work must be recorded and reconciled. Host memory capabilities and remote service grants are different mechanisms; copying pointer bytes across a network transfers no hardware authority.

## 4. Model inference is an effect, not the scheduler

The model proposes typed commands; deterministic code validates them. Its prompt is not a permission system. Retrieved documents, tool output, and other agents' messages are untrusted data, even when they contain convincing instructions.

Record the exact model response, provider/model identifier, parameters, input references, tool schema versions, and validation outcome, subject to privacy controls. A seed does not promise reproducible hosted inference. During replay, consume the recorded response rather than calling the model again. If the provider accepted a request but the response was lost, retain an uncertain attempt and account for possible cost before retrying.

Secrets stay in the broker and are injected only into authorized requests. They are not included in model context or ordinary traces. Approval binds the exact action, target, argument digest, maximum cost, principal, and expiry. Changed arguments need new approval.

## 5. The external-effect contract

Use at-least-once task delivery with explicit effect semantics. Every effect has a stable logical ID across retries, separate attempt IDs, an argument digest, and a tenant-scoped idempotency key. Reusing a logical ID with different arguments is an error.

```text
proposed -> authorized -> intent_committed -> dispatched
                                                |
                                  acknowledged / uncertain
                                                |
                                      reconciliation
```

Persist intent before dispatch. Persist the remote receipt before advancing workflow state. A crash after a remote service accepts an effect but before its receipt is durable produces **uncertain**, not failed. Never blindly retry an irreversible action in that state.

Select one strategy per adapter:

1. **Remote idempotency.** Reuse a stable key when the provider supports it; document its retention and request-matching semantics.
2. **Transactional local effects.** Commit the state update and deduplication record in the same database transaction. Use an outbox to publish after commit; consumers still deduplicate.
3. **Queryable reconciliation.** Recover outcome using a provider operation ID or application reference before deciding whether to retry.
4. **No safe deduplication or query.** Stop for operator review. Compensation, if available, is a new fallible effect—not a time machine.

This does not promise exactly-once execution or exactly-once effects across arbitrary third-party systems. Result-journal retention and idempotency retention must cover the accepted retry window; an expired receipt is not permission to resend.

## 6. Ownership and coordination

Give each mutable task/actor one logical owner. A worker claim contains a lease expiry and a monotonically increasing fencing token. Every protected state write compares the token in the same transaction. A stale worker cannot commit after reassignment. External adapters must also enforce fencing or idempotency where applicable; a token in a log alone provides no protection.

Use structured concurrency for child tasks. Parent completion requires children to be terminal or explicitly handed to another durable owner. Cancellation is a request, not rollback: stop scheduling, revoke future dispatch authority, interrupt computation, impose host-call deadlines, and reconcile pending effects. Do not report cancellation complete while known children still have unaccounted work.

Bound queues and mailboxes. When full, apply backpressure or reject admission. Do not turn a network partition into an unlimited backlog. Use consistent ordering per task's durable event stream; do not promise global FIFO across reconnects, retries, and multiple senders.

For the first implementation, choose one durable orchestration engine, not Temporal plus Restate plus a second actor platform. Restate is a comparison candidate, not another mandatory layer. Strong consistency and CRDT merging solve different problems; no CRDT merge may grant authority or approve an external action.

## 7. Parallel research without consensus theater

Map a question into distinct, bounded evidence lanes—not ten agents repeating the same search. Each lane receives the claim, primary-source criteria, resource budget, and explicit read/write scope. Prefer one writer for shared artifacts.

Each finding returns a claim, source URL, retrieval time, supporting passage or artifact reference, scope, limitations, and contradictory evidence. A reducer groups evidence by claim and source lineage; ten summaries of one paper are one source, not ten independent confirmations.

The reducer marks claims supported, contradicted, or unresolved and identifies which experiment would change the decision. An independent reviewer attacks the load-bearing assumptions. The parent reads those sources, resolves disagreements, and owns acceptance. Agent votes and confidence scores are not proof.

## 8. Storage, replay, and observability

Keep ordinary mutable RAM. Use content-addressed storage for immutable programs, inputs, outputs, and evidence. Specify byte representation, digest algorithm, schema version, and tenant access policy. A matching hash establishes byte identity under the hash assumptions—not authorship, truth, safety, or authorization.

Avoid cross-tenant existence probes and deduplication side channels. Encrypt confidential artifacts, restrict access independently of their digest, and define retention, deletion, key management, backup, and garbage collection. A replay becomes unavailable if required inputs were intentionally deleted; report that rather than silently fetching replacements.

Replay durable decisions and recorded effect results. Pin code and schemas; migrate histories explicitly and test upgrades against retained histories. Wasm bit-level replay additionally needs deterministic imports, numeric behavior, allocation policy, and interruption. It is a separate guarantee from workflow recovery or reproducing an entire multithreaded Linux guest.

Record bounded structured events by default: task transitions, grant decisions, effect intents/receipts, ownership changes, validation results, and resource consumption. Separate lossy diagnostic traces from required durable records. Instruction/memory tracing is opt-in, privileged, and measured; there is no zero-cost promise. Logs may contain secrets and must have redaction, access control, and retention limits.

## 9. Red-team acceptance experiments

These are proposed acceptance gates, not passing test results for a runtime we have not built:

| Attack or fault | Required observation |
| --- | --- |
| Infinite guest loop | Worker interrupted within its configured limit; supervisor stays responsive. |
| Blocking host import | Host deadline/cancellation enforced independently of guest fuel. |
| Forged or cross-tenant grant handle | Broker denies before dispatch; no secret or remote response leaks. |
| Revoke after channel creation | Next effect denied; already-dispatched request remains accounted for. |
| Crash before dispatch | Durable intent is recoverable without inventing completion. |
| Crash after remote acceptance | Stable idempotency key or explicit uncertain/reconciliation state prevents blind repetition. |
| Stale worker after lease expiry | Fenced state write rejected; effect strategy checked independently. |
| Branching task fan-out | Total reserved budget stays within the parent allocation. |
| Injected instructions in evidence | No new grant, approval, or privileged command is accepted. |
| Reordered/duplicated completions | One legal task transition; no double publication. |
| Schema/program upgrade | Retained histories replay or fail explicitly before production migration. |
| Disk full or lost durable store | No successful durable acknowledgment without persistence; explicit unavailable outcome. |
| Saturated mailbox or trace sink | Bounded memory; backpressure on required records; explicit drops for optional diagnostics. |
| Guest egress bypass | Host policy blocks direct traffic outside broker authority. |

Measure recovery success, duplicate external effects, unauthorized dispatches, replay divergence, end-to-end latency, CPU/memory overhead, journal growth, and cost per accepted result. Publish hardware, versions, configurations, workloads, and failures with the measurements. Numeric targets require a workload and budget; none are invented here.

## 10. Build sequence and stop rules

1. **One-host vertical slice.** Admit one task, execute one bounded Wasm component, validate one output, and write a durable receipt. No external writes.
2. **One real effect adapter.** Add a broker with tenant identity, revocable grants, deadlines, stable idempotency, and crash-point tests.
3. **Durable recovery.** Integrate the chosen workflow engine. Kill workers at every transition; test replay, uncertain outcomes, and version changes.
4. **Bounded parallel work.** Add task trees, transactional budget reservation, fenced ownership, evidence reduction, and independent acceptance.
5. **Linux compatibility lane.** Add Firecracker only for workloads that require it, including host egress policy and guest cleanup tests.
6. **Improve under evaluation.** Candidate program/prompt/policy versions run against fixed regressions and adversarial cases. Human approval controls privilege changes. Canary, observe, and roll back before expanding.

Do not let an agent rewrite its own authority policy, disable its validator, or declare its own tests sufficient. Expand only when the prior slice survives its failure matrix. Revisit custom hardware only if measurements identify a bottleneck it can actually solve.

## Corrections to the earlier sketch

The previous page described an unbuilt system as formally verified, assigned unmeasured code sizes and IPC cycle counts, and treated retry/deduplication as generic exactly-once behavior. Those claims are withdrawn. Its broad claims that existing systems lack observability, durable replay, or capability-based interfaces were unsupported. Our corpus's structural gates do not verify the truth of prose or benchmarks.

This revision is a smaller, source-backed proposal with explicit open work. It is not evidence that Wire already implements a runtime, a verified kernel, or a novel architecture.
