# ROSUNO DECISION LOG ENTRY DL-ENG-1 — ENGINEERING-PROCESS RULINGS

| Field            | Value                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Decision         | DL-ENG-1, registered in `governance/decision-log.json`                                                                             |
| Title            | Engineering-process rulings for autonomous development and forward-only correction                                                 |
| Category         | Process; defect handling (Implementation Master Plan §6)                                                                           |
| Owner / approver | NatthanPrevot                                                                                                                      |
| Operative        | Only when (1) the owner has adopted these exact bytes and (2) the adoption is recorded in the project Decision Log on owner `main` |
| Supersedes       | None                                                                                                                               |

## Authority basis

Each LOCKED authority routes changes of this kind to the project Decision Log: Implementation Master Plan §47 (changes
to the plan); MVP Build Specification §§30 and 32 (Build-Spec changes; no new version, because the implementation
contract — what is built — does not change); Physical Specification §53 (an amendment is required only when the
physical model itself changes, which no ruling here does). No FINAL or [A] rule is reopened (Domain Model §0, Payment
Matrix §0) and no [B] or [C] value is decided. Timing of the Master Blueprint §§53 and 76 decisions is governed by the
bounded authority amendment MB-A1, not by this entry.

## Effect and limits

This entry supplements the LOCKED authorities and changes none of their text. It changes no product behaviour, domain
model, architecture, physical model, policy boundary, counsel- or regulator-gated value, launch condition or production
gate. Where a ruling and a LOCKED provision appear to conflict on a product, legal, regulatory, security, privacy,
financial or data-integrity matter, the LOCKED provision controls. Citations are by document and section only; no
locked text is reproduced.

Abbreviations: IMP Implementation Master Plan V1.0; MBS MVP Build Specification V1.0; MB Master Blueprint; TA Technical
Architecture V0.2; PS Physical Supabase/PostgreSQL Specification V1.0; ROS Relational Object Specification V1.0; DM
Domain Model V1.4; PM Payment/Engagement Matrix V0.2; RMS Regulatory Master Specification; FP-1 Financial Provenance
Physical Correction; MB-A1 Master Blueprint bounded authority amendment MB-A1.

## Rulings

**R1 — Conformance correction (IMP §§32, 43; MBS §28 rule 10).** Within an adopted Packet's allowed scope, where the
locked text unambiguously determines the correct behaviour, the engineering agent corrects existing repository state to
conform and reports the correction; the adopted Packet is the decision IMP §32 requires. The stop, report and wait
procedure continues to apply where a correction needs interpretation, a design choice, scope expansion, files outside
the Packet, a change to a locked artifact, a counsel- or regulator-gated value, or any other IMP §43 stop condition. MBS
§28 rule 10 applies to conditions affecting domain behaviour, protected state, security, counsel-gated values or
user-visible behaviour; other implementation choices are made and reported.

**R2 — Execution environment (IMP header, §3 Track B, §§4, 32, 42; MB §§167–169; MBS header and §32).** Replit's roles
as application repository and build, test and deploy environment are historical. The implementation agent is Claude
Code Cloud working in the Builder fork; build and test run locally and in required CI on the owner repository;
deployment follows the owner-controlled IMP §8 release path from owner `main`; Replit remains a runtime, preview and
deployment target only. The IMP §4 bounded-task rule applies through owner-adopted Packets. Implementation is authorized
under the IMP and owner-adopted Packets only, which satisfies the MBS planning-only status line.

**R3 — Task and Decision Log granularity (IMP §§5, 6, 32).** Implementation, testing, debugging, in-scope refactoring
and defect correction under one adopted Packet constitute one task. One adopted Packet per agent session at a time;
investigation and FIX proposals may run alongside. A Decision Log entry is required when a change creates, alters or
interprets a requirement, scope or consequential behaviour. An adopted FIX Packet is the defect entry; corrections
within a Packet are recorded in commits and the PR. The rule that a coding agent cannot turn a proposal into a new truth
by committing it is unchanged: merge remains the owner's act after designated human review.

**R4 — Review (IMP §§1, 9, 33, 45).** Independent review is required for work touching authentication or RLS,
migrations, payments or the ledger, webhooks, storage access, regulatory or eligibility configuration, process controls
or the physical model, with delta review of corrections; otherwise it is optional. The IMP §1 security/integrity review
is satisfied by required CI, the trusted guard and that risk-based review. Designated human approval before merge
(IMP §§9, 45) remains mandatory for every change; independent AI review never substitutes for it and is never legal
verification (RMS §39).

**R5 — Work-item fields (IMP §§5, 7).** Fields that do not apply are "none", and the agent may draft every field. FIX
short form: ID; defect and evidence; locked source; original work item or PR; allowed files; database, RLS, provider and
security impact; acceptance and failure tests; forward-only rollback; stop conditions.

**R6 — Commits, evidence and records (IMP §§30, 31, 34; TA §67).** One PR per slice; every commit message cites the
work-item ID; corrections are forward commits; test evidence is required CI on the final head. Checkpoint records may be
generated from merged PRs, CI runs, the configuration version and open FIX items (listed as known exceptions).
Implementation notes are the PR description; runbooks change when operational behaviour changes. Traceability to
Payment Matrix rows or Decision Log entries is required for invariant, financial and regulatory tests, by test name or
comment. History on protected branches is never rewritten.

**R7 — Sequencing (IMP §§1, 16, 42, 44; MBS §3).** Phase order governs first delivery. FIX work may target any phase at
any time, including work completed before the current engineering model; acceptance follows the MBS §3 capability
dependencies. Configurable mechanisms whose parameters are undecided are built behind the configuration boundary (MBS
§2.5); for the Master Blueprint §§53 and 76 mechanisms the decision timing is set by MB-A1.

**R8 — Persistent environments and migrations (IMP §§10, 35; PS §§46, 53; FP-1 §11).** A persistent environment is any
non-disposable database or deployed system: shared development, Staging, Production and OLD Supabase. Only reviewed
migrations merged to owner `main` reach one, under separate authorization; disposable local and CI databases are
exempt. A historical migration is one merged to owner `main` or applied to any persistent environment; it is never
edited, and a defect in it is corrected by an appended forward migration that cites the boundary it corrects. A
migration present only on an unmerged branch may be corrected before merge. The PS §46 sequence governs the initial
build; every migration applies cleanly in dependency order on a fresh database and on the current persistent schema and
never destroys historical or immutable rows. Rollback or recovery may be a forward corrective migration or a restore,
never one that destroys evidence.

**R9 — Physical-model boundary (PS §§35, 39, 52A, 53; ROS §21).** Implementation mechanisms — constraint syntax,
triggers, helper functions, indexes, RLS policy text — and corrections restoring conformance are not physical-model
changes. A change to relations, columns, cardinality, ownership, immutability or the representation of a counsel-gated
value is, and needs a Decision Log entry and a bounded amendment before persistent application; both may be adopted
together with the Packet. The field-level anti-duplication test is run and recorded in the Packet, and owner adoption of
the Packet is its approval. A new index is justified by a recorded query plan or advisor finding.

**R10 — Testing boundary and synthetic data (FP-1 §3.4; PS §45; MBS §2.9; MB §153).** The authorized testing boundary is
disposable local or CI databases and rollback-only Staging validation. Clearly synthetic data exists only there and in
test code. Seeds applied to Staging or Production contain reference catalogs only. No test or demo record persists in,
or satisfies, a production workflow.

**R11 — Read-only boundary (TA §§20, 22; PS §30.5; MBS §20; MB §§91, 104, 178; IMP §15; RMS REG-CA-034).** Autonomous
read-only inspection covers code and history, CI and PR status, local and disposable databases, and schema or catalog
metadata. Reading row data in any environment holding real data is owner-authorized, scoped and audited. No real
personal, legal-matter or financial data is placed in AI prompts, fixtures, logs or test output.

**R12 — Defects versus unsettled behaviour (DM §0; PM §0; RMS §37).** A defect is a deviation from a FINAL or [A] rule, a
locked downstream specification, a recorded owner or counsel decision, or an adopted Packet's acceptance criteria. Where
the correct behaviour is [B], [C] or PROPOSED, the agent builds the configuration seam and names the decision needed: a
[B] value needs an owner decision recorded as jurisdiction policy; a [C] value needs a recorded human decision informed
by counsel. No AI resolves a gated item or promotes PROPOSED to FINAL.

**R13 — Forward-only data correction (PS §32; PM INV-2, INV-3, INV-9; ROS §§14.2, 24; TA §14).** Corrections in a
persistent environment append compensating or superseding records with the audit trail the authority requires;
immutable and append-only records are never updated or deleted. Remediation of real affected records is an owner
decision (informed by counsel where a gated value is involved), executed through the persistent-change gates.

**R14 — Operator tasks (IMP §§9, 29; PM INV-11; ROS §18.2; RMS REG-CA-003A).** The objective of minimal manual tasks
applies to the engineering workflow only. Human steps inside the product (exception resolution, counsel review, launch
authorization, required LRS staff), the P0 restore drill and production runbooks remain.

**R15 — Downstream artifacts and authority reconciliation (TA §76; FP-1 §14.7).** TA §76 is satisfied by PS §§30–31 and
47, the MBS and per-item Packets; no standalone artifact is a precondition unless the owner designates one. Authority
reconciliation is by reference to the authority manifest (filenames and SHA-256) and is repeated only when the manifest
changes or a Packet touches the matter.

**R16 — Clerical status notes (no substantive change).** The PS is V1.0 LOCKED per its §53 and amendment history; an
earlier draft label in its header is clerical. The RMS is the evolving regulatory specification it states itself to be;
its internal version references are clerical, and its FINAL product rules and counsel gates apply as marked. The PM is
the LOCKED V0.2 matrix. The IMP contains no §14. The Master Blueprint, MVP Build Specification and Payment/Engagement
Matrix are registered by SHA-256 in `governance/authority-references.json`.
