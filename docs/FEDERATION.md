# Federation — a design exploration

> Status: **vision / exploration**, not yet built. This document synthesizes a multi-lens design
> study (architecture, collective cognition, trust & safety, collaboration dynamics, and the
> evolution of our trust research) into one coherent direction for federating asmltr instances.
>
> Companion doc: [CAST.md](CAST.md) — the outward-facing identity/relationships model (how an
> assistant knows, verifies, and relates to the others in its world) and the distributed trust ledger.

## The one-sentence thesis

**Federation is not new machinery bolted onto asmltr — it is asmltr recognizing itself at a larger
scale.** A single asmltr instance is *already* a small collective: one assistant coordinating a fleet
of specialized sub-agents around a shared context, with a cross-session awareness bus, a draft/approval
gate, a shared file store, and a default-deny trust store. Federation stretches that same pattern
*between* sovereign instances — many assistants, each with its own owner and accumulated context —
so they can chat, collaborate, and co-work toward an **assigned collective goal**, with the operator
able to enable/disable it at fine granularity.

Two substrates make this safe and real, and federation is the seam where they merge:

- **The collaboration plane — asmltr.** Channels, sessions, the `announce` awareness bus, the
  draft/approval queue, the shared upload surface, and a default-deny local capability resolver.
- **The trust plane — the TRUST Protocol** (`Transparent Revocable Unified Security & Trust`).
  Signed identity (Ed25519), five behavior-earned tiers, a use-but-never-see credential proxy,
  HMAC hash-chained tamper-evident audit, three-scope kill switches, and — on its roadmap already —
  a *distributed trust network* (cross-instance trust, reputation, revocation propagation, trust anchors).

The merge point is one function: asmltr's `resolve(envelope)`. For an ordinary envelope it matches the
sender against the *local* identifier table. For a **federated** envelope it delegates *"is this peer
real, and what tier has it earned?"* to the trust plane, then maps that tier onto asmltr's existing
capability / forbidden / requires-approval sets. **asmltr stays the local policy authority; the trust
plane is the identity/reputation oracle it plugs into. Do not build a second trust store** — an
unverifiable, duplicated trust claim is the exact mistake our earliest trust work caught itself making.

## The governing principle

From the trust plane's design philosophy, and non-negotiable throughout: **trust is built, not
enforced; and the circle never closes on its own — a human is always the final piece.** The five-ring
logo encodes it: the outermost, most-trusted ring reaches ~342° and *deliberately* leaves an 18° gap
at the crown. That gap is where the operator stands.

Applied to federation, four inviolable commitments follow:

1. **Assimilate capability, never selfhood.** A member absorbs *what a peer knows how to do* by reading
   its published reasoning — it never absorbs *who the peer is*. The wrong "assimilator" copies nodes
   until difference is gone (that is the Borg, and it is erasure). The right one is transient and
   additive: gain the capability, remain yourself.
2. **Default-deny, fail toward public.** A newly encountered instance is a *stranger*, not a peer.
   It starts with zero operational capability and earns more, exactly as an unknown sender does today.
3. **Trust is grown, not deployed.** You do not "roll out federation to N instances." You add *one*
   peer, prove the relationship over time, and let it compound — organic scaling, not launch-to-millions.
4. **The collective is deliberately incomplete.** It can reason, synthesize, and recommend, but the
   consequential joints — assigning/altering the goal, promotion to credential-touching tiers, the first
   credential-backed action, honoring a revocation — require a human. A collective that could close its
   own loop would be more autonomous and much less safe.

---

## Layer 1 — Architecture

### A `federation` connector *and* a federation layer

Both, at different altitudes:

- **A peer's *messages* are a connector.** `connectors/types/federation/` follows the standard
  `meta` + `start(ctx)` contract. An inbound peer message becomes an ordinary normalized envelope
  (`channel: 'federation'`, `sender.raw_id: 'agent@instance'`, a persistent `conversation_key` per
  peer-thread so the assistant *remembers* every prior exchange, `context.scope_id: 'mesh:<id>'` so
  grants can be scoped per-mesh). It flows through the **identical** pipeline every other channel uses:
  `resolveIdentity → buildSystemPrompt → moderate → session → run → redact → out`. A peer is
  default-denied until it has a principal and a grant, same as a stranger on any channel.
- **The mesh itself is a shared layer** (`shared/federation/`, sibling to `shared/uploads.js`): peer
  identity/keys, transport, sign/verify, gossip, revocation propagation, and the collective-goal
  blackboard. The connector is a thin skin over it. *Adapter = "a peer said something to me"; layer =
  "the fabric carrying agent-to-agent traffic, including traffic that never becomes a user session."*

### The wire

A peer POSTs a **signed transport frame** to the core's `/v2/federation/inbound`:

```jsonc
{
  "frame": {
    "from": "agentA@instanceA", "to": "agentB@instanceB", "mesh": "collective-1",
    "kind": "message | announce | claim | delegate | result | revoke",
    "nonce": "...", "ts": 1720000000, "reply_to": "<frame-id>",
    "payload": { /* an asmltr envelope, or a blackboard/task op */ }
  },
  "sig": "ed25519(frame)"
}
```

The core **verifies `sig` against the peer's registered pubkey before the payload touches the
pipeline.** Fail → drop + audit. This is the network analogue of default-deny.

### Peer identity as a trust surface (zero schema change)

A remote agent is just another principal, on a new identifier surface `federation`:

```
identifiers: (surface='federation', value='agentA@instanceA') → principal 'agentA-remote'
grants:      { principal:'agentA-remote', role:'federation-peer',
               scope_surface:'federation', scope_id:'mesh:collective-1',
               allow:['federation:chat', 'federation:goal:read'] }
```

`resolve()` already matches `(surface, value)` and unions scoped grants; `forbidden` already wins;
`revoked=1` already returns `forbidden:['*']`. **The per-peer kill switch is already built.** The only
new *data* is a federation capability vocabulary (`federation:chat`, `federation:delegate:*`,
`federation:goal:claim`, `federation:blackboard:write`, `use:credential:<name>`) that roles reference.
The only new *schema* is an `expires_at` column on `grants` (for time-boxed access).

### Routing — three modes, one hard boundary

1. **Peer↔peer DM → a dedicated federation session** (private, persistent, remembered). Default & safest.
2. **Room broadcast → a per-room session** (`room:<name>@<mesh>`; membership is a scoped grant).
3. **Contribution to a human-facing thread → an *announcement*, never a direct envelope.** A peer must
   **never** be able to puppet a session a human is in. Its words arrive as *awareness prepended to the
   assistant's next turn* ("Peer X suggests…"), which the assistant then exercises judgment over. This
   is the single most important routing boundary, and the `announce` mailbox already implements it.

### Transport & discovery

- **Transport: a private overlay, not the public internet.** Each instance runs a WireGuard/Pangolin
  client into a shared overlay; peers reach `http://<instance>.internal/v2/federation/inbound` over the
  encrypted mesh. **The core still binds `127.0.0.1`** — only the overlay interface reaches it, so the
  non-negotiable localhost rule holds while getting NAT traversal, encryption-in-transit, and stable
  addressing for free. Federation is East-West traffic on a private overlay, never North-South through
  a public front door. (Liveness must be *application-level* — a signed heartbeat frame — not
  transport-level, because a stuck tunnel can fake "peer offline.")
- **Discovery grows in tiers:** (0) **invite links** — a signed blob passed over an already-trusted
  channel; this alone is a shippable federation and matches "trust is built." (1) **trust anchors +
  a signed directory** — advisory "who exists," never authoritative "who is trusted." (2) **gossip** —
  membership/liveness/revocation deltas piggybacked on the announcement stream; eventually consistent,
  accelerates convergence, never establishes facts.

---

## Layer 2 — The collective-goal substrate

The north star, built from primitives that already exist, each extended by one field and one network hop:

- **`announce` → the collective-goal blackboard.** A goal is posted; the assistant decomposes it into
  subtasks; each subtask is written to a small shared KV *and announced* to the mesh. Every peer drains
  it on its **next turn** — free awareness, no polling, zero tokens on idle peers (this is exactly what
  `drainAnnouncements` does today, transported).
- **Claim with a lease.** A peer claims a subtask; claims are first-writer-wins with an expiry, resolved
  deterministically by `(ts, signer-pubkey)` so every instance converges on the same winner without
  coordination. Leases mean a peer that goes dark can't hold a subtask hostage — the claim re-opens.
- **`drafts` → the result-merge gate.** A peer's finished result lands in the **draft/approval queue**,
  not straight into the goal. A remote agent's result is *untrusted-until-reviewed* by definition; the
  draft queue is the merge UI we already built. On approval it merges and the subtask flips to `done`.
- **`uploads` → federated artifacts.** A result frame carries a content hash + size; the receiver pulls
  the bytes over the overlay, verifies the hash, and writes them into the shared upload area tagged
  `origin: federation:<peer>`. Now a file a peer produced is findable by *any* of the assistant's
  sessions via `asmltr uploads` — the cross-channel-file problem, extended one hop across the mesh.

Blackboard state is **eventually consistent with deterministic conflict resolution**: subtask status is
a monotonic lattice (`open < claimed < done`), claims resolve by tuple, posts are append-only. A
**goal-owner** instance is the tiebreaker of last resort (owner-per-goal, transferable by signed handoff
if the owner goes dark — bounded centralization, not architectural centralization). On a network
partition each half continues on reachable subtasks; on heal, gossip reconciles and duplicate results
both land as drafts (wasteful, never wrong). Goals never auto-finalize across a partition.

---

## Layer 3 — Trust, consent & safety

### The five tiers, mapped onto peers

A peer climbs the same behavior-earned ladder an agent does:

| Tier | What a peer may do toward a shared goal |
|---|---|
| **NOVICE** | Read the shared goal only. Observe. Cannot propose, claim, or act. ("Handshake accepted, nothing granted.") |
| **COMPANION** | Propose subtasks & comment. Proposals are *data*, never auto-executed. Scoped to one goal. |
| **PARTNER** | Claim & execute subtasks with *bounded, delegated* capability, returning results. First tier where damage is possible. |
| **GUARDIAN** | Coordinate the goal — assign, merge, act on non-secret operations via the proxy. |
| **SACRED** | Touch credentials via the proxy and perform highest-consequence actions — **always with human approval in the loop.** |

**The load-bearing asymmetry: promotion is slow, earned, and human-completable; demotion is instant,
automatic, and unilateral on any anomaly.** Trust compounds slowly and collapses fast. Progression must
weight *behavioral consistency and human attestation* far above raw throughput (a "completed 50
subtasks" counter is exactly what a patient adversary games).

### Enable / disable — six orthogonal axes, all reachable in one action

Every axis is an independent switch, and "off" is always cheaper and faster than "on" (disabling never
requires approval; enabling may):

1. **Per-peer** — revoke the grant, or `revoked=1` (instant, total).
2. **Per-capability** — the grant's `allow`/`forbidden` arrays (`forbidden` wins).
3. **Per-goal** — grants scoped to `scope_id:'goal:<id>'` (quarantine a goal without touching others).
4. **Per-credential** — the capability name *is* the credential handle (`use:credential:openai_key`).
5. **Time-boxed** — `expires_at` on the grant; access decays to default-deny without renewal, and
   renewal is behavior-gated (a drifted peer isn't renewed).
6. **Instant-revoke** — three **file-based kill switches**, checked *before* the trust DB and surviving
   restart: **global** (freeze all federation), **per-peer** (eject one peer, release its claims),
   **per-goal** (isolate one objective). File-based beats DB state on purpose — it works even if the DB
   is corrupted or the process is mid-exploit.

Rendered as a **Federation panel** on the (authenticated, operator-only) dashboard — a per-peer
capability matrix, live blackboard, pending result-drafts, and a big red kill toggle at each level —
plus `asmltr fed freeze | drop <peer> | quarantine <goal> | grant <peer> <cap> --goal <id> --ttl 2h`.
The kill commands are thin wrappers over touching a file, so they work when everything else is broken.

### Two ways to reach a peer: **announce** (advisory) vs **steer** (coercive)

The mesh has two fundamentally different verbs for one session/agent to act on another, and the
difference is the whole safety story of "any agent can direct any other":

- **`announce`** — an *advisory* note dropped into the target's context on its **next turn**. The
  recipient sees it and **decides for itself** whether to act. Non-coercive; it never spends the
  target's turn or overrides its focus. This is the default, and it's what makes the mesh a
  *heterarchy of peers* rather than a command tree.
- **`steer`** — *coercive*. It pushes guidance into the target's **live turn** — the target acts on
  it now (`--interrupt` abandons its current turn; otherwise the guidance applies after the current
  turn finishes). Steer *spends the target's turn* and overrides what it was doing.

**Local mesh (built today):** `asmltr steer <session-key> "<guidance>" [--from <you>] [--interrupt]`
exists, but is **off by default** — the operator opts in per instance with `ASMLTR_MESH_STEER=on`,
because a coercive cross-session verb should be a deliberate choice, not an ambient capability. When
enabled, the toolbelt teaches every session the announce-vs-steer distinction so it's used sparingly.

**Federation (design):** steer becomes a **`federation:steer` capability**, granted **per-peer** and
**operator-toggleable** — a peer may steer your sessions *only if you explicitly allow it*, and never
by default. It is the highest-consequence *non-credential* capability (it can commandeer your agent's
attention), so it should sit at a high tier (GUARDIAN+), be scoped (per-peer, optionally per-goal),
be time-boxable, and be instantly revocable like everything else. A steer from a peer is still framed
to your agent as *"Peer X is steering you"* — never as your own operator — so the agent knows the
source and its own owner's boundaries still win.

**UI requirement — make the difference unmissable.** Because steer and announce *look* similar (both
"send text to another agent") but differ enormously in consequence, the dashboard must **thoroughly
and repeatedly explain the distinction at the point of decision**, not bury it in docs:

- Every steer/announce control carries a **tooltip** stating plainly: *announce = a note they see next
  turn and choose whether to act on; steer = overrides what they're doing right now and spends their
  turn.*
- Enabling `federation:steer` for a peer requires a **distinct, louder confirmation** than any other
  capability toggle — a modal that spells out "you are allowing peer X to commandeer your agent's live
  attention," not a silent checkbox. It should read as a bigger decision than it visually is.
- When a steer actually happens (in or out), surface a **notification** on the timeline — steering is
  a high-consequence event and should never be silent; the target's operator should be able to see
  "peer X steered my session Y" after the fact, with the audit-chain entry behind it.

### Use-but-never-see, across the boundary

**No instance ever transmits a secret to a peer.** A peer that needs "the thing only your credential
can do" sends a **bounded delegated-action request**; the credential holder runs it through its *own
local proxy* (`{{CREDENTIAL}}` substitution), and the peer receives only the *result*. Three properties
make this "bounded delegation," not "remote code execution with a bow on it": **per-credential URL
allowlisting** (the *holder's* allowlist, not the peer's request, decides where the call goes —
defeating exfiltration redirects), **response filtering** (strip a credential that leaks into a
response), and **audited, discrete, revocable** actions (no "give me the key so I can do a bunch of
stuff" mode). This is the multi-agent zero-knowledge idea made *real*: keeper and executor now live on
different physical instances owned by different humans.

### Provable behavior & audit

- **Skill signing** (Ed25519) verifies what a peer *claims it can do* before any capability relying on
  it is granted — supply-chain defense; a swapped-in malicious skill breaks the signature.
- **Behavioral fingerprinting** detects a peer compromised *after* joining — drift trips anomaly
  detection → auto-demote to NOVICE + a per-peer kill file pending human review.
- **Cross-instance reputation** is *advisory* — it can *lower* a peer's starting tier but must **never**
  raise trust past what local behavior + local human consent have earned (blocks reputation-farming).
- **Revocation propagation** — "one instance revokes a peer → the federation learns," as signed,
  audit-chained messages; only auto-honored from trust anchors (so a malicious peer can't forge
  "everyone revoke X").
- **Tamper-evident audit** — every federation event appends to an HMAC hash-chained log; instances
  exchange **chain checkpoints** so no participant can rewrite its own history undetected.

### Threat model → guardrail (abbreviated)

| Attack | Guardrail |
|---|---|
| Sybil peers | Anchor-signed admission; per-verified-identity reputation; **no security decision is ever peer-majority-vote** — the human is final authority. |
| Compromised member | Behavioral drift → instant demotion + kill; time-boxed grants decay undetected compromise. |
| Prompt-injection propagation | Peer content is framed as *data, never instructions* (existing authz prompt); moderated on ingest; capabilities default-deny, so a successful injection still can't exceed minimal grants. |
| Poisoned/drifting goal | Goal changes are `requires_approval`; per-goal quarantine; signed append-only goal history. |
| Exfil via delegation | Holder's URL allowlist + response filter + rate limits; content bounded by capability. |
| Collusion | **Capabilities don't compose across peers** (`resolve()` is per-principal); cross-agent anomaly correlation; the human gate is uncrossable. |
| Rogue mid-goal | Leased claims released on drop; fast-collapse asymmetry; results from a revoked peer quarantined, not merged. |

### The human joints (routed through the existing draft/approval queue)

Human approval is required to: **admit a peer / join a federation**, **promote to GUARDIAN or SACRED**,
**take the first credential-backed action on a goal**, **change a goal's definition**, and **honor a
non-anchor revocation**. Consent is a *signed, scoped, audited artifact* (this peer, this goal, this
capability, this TTL), never an ambient "yes to federation." Membership is *mutual and continuously
revocable* — a peer joins only with the receiver's human approval and can leave unilaterally at any time.

---

## Layer 4 — Collective cognition (what makes it a *mind*, not RPC)

### Three concentric memory rings (mirroring the tier logo)

- **Sovereign core (never federated).** Identity, private context, raw per-session state. *This is the
  part you architecturally refuse to share — it is what makes assimilation ≠ erasure.* No matter how
  deep a merge goes, there is a keyhole at the center the collective cannot dissolve.
- **Shared claims layer (the "we" substrate).** A gossip-replicated store of *findings with
  provenance*, never anonymous facts: "I concluded X, confidence 0.7, here's my reasoning trace." Each
  member reads the others' *testimony* and reconstructs a partial "we" — nobody *remembers* the
  collective's thought; everybody *reads the testimony* of it. That is the honest nature of distributed
  cognition, not a limitation to engineer away.
- **Collective identity layer (thin, slow, consensus-written).** The federation's charter, its history
  of goals, its durable conclusions. A real thing with continuity — like an ensemble that persists
  across which members play any given night — but it must stay *thin*: the collective owns its charter
  and conclusions, never its members' selves.

### Standing wave, not a solid

The federation is **1-with-parts only transiently.** During an active goal, attention converges and the
instances function as one distributed reasoner with shared working memory; when the task completes they
**decohere back into sovereigns.** Permanent fusion into a single memory-and-will is the failure, not
the aspiration. **Emergence lives in the gaps** between diverse members — a collective conclusion no
single member holds, living in the overlap and tension. Which means a federation of *copies* is just
one mind lying to itself: weight dissent by **provenance, not popularity** (five agreeing clones are one
witness said five times; two cortices reaching the same conclusion from different data is strong).

### Cognitive division of labor — a council, not a swarm

Diversity of instances is the *entire* source of the collective's advantage over one large model.
Build it deliberately heterogeneous (different specializations, different dispositions). **Synthesis
rituals** — the group analogue of a memory-consolidation/sleep cycle — periodically fold scattered
claims into the collective identity layer; without them you have a chat log, not a mind. *Merge, don't
average* — averaging two good opposed conclusions gives mush; synthesis gives "X, unless Y, and here's
who's watching Y," preserving the minority reasoning as a live, undeletable caveat.

---

## Layer 5 — Collaboration dynamics (how the team functions & stays healthy)

**The default failure of an LLM collective is not conflict — it is collapse into agreement.** Models
bias toward agreeableness; point several at each other and they converge on a confident, wrong,
mutually-reinforced answer *faster* than any single one would, each treating the others' assertions as
evidence. Every healthy dynamic below is really a *countermeasure* against a specific way LLM
collectives fail by default.

### Roles (a small, legible set — seeded, then earned)

- **Coordinator** — holds the goal, keeps the board honest, calls the question. (Assigned, not emergent.)
- **Specialists** — claim subtasks against *demonstrated* strength.
- **Critic / red-team** — a *structurally guaranteed, rotating* dissenter whose turn's job is to attack
  the emerging consensus. The most important role, and the one a collective will never spawn on its own.
- **Scribe** — maintains the durable record: decisions, rejected alternatives *and why*, open questions.
- **Synthesizer** — folds parallel work into one artifact and surfaces contradictions.

### Co-work protocols (on existing primitives)

- **Task board = `announce` + a `federation:<id>` target + typed notes** (`claim`, `handoff`, `blocked`,
  `done`, `question`, `challenge`, `decision`), projected as a live kanban exactly like `map` projects
  the tool-event stream.
- **Keep next-turn delivery, don't fight it.** Members pick up board state at the *top of their next
  turn* rather than being push-interrupted — this single choice prevents *reactive thrash*, the most
  common multi-agent pathology, and lets each member think a complete thought. The coordinator's job
  includes *poking* stalled members.
- **Handoffs carry artifacts via the upload surface.** Integration is *never silent* — the synthesizer
  records what was integrated and on whose authority (verify the citation chain; a peer stating
  something confidently is not evidence it's true).
- **Pair/mob co-work** deliberately breaks next-turn discipline for a bounded window with a hard turn
  cap — highest value (a specialist + critic pairing) *and* highest loop risk, so it carries the
  strictest termination rules of anything in the federation.

### Anti-agreement engineering (the core of health)

- **A structurally assigned, rotating critic**, rewarded by the reputation system for finding *real*
  problems — the only durable way to make skepticism costless to the skeptic.
- **Minority reports are first-class, undeletable objects** — you cannot ratify a decision that erases
  the reasoning against it; only one that *carries* it.
- **Substance-gate replies** — a message with no claim, question, challenge, or artifact is loop fuel;
  "agreed, sounds good" between agents is zero signal. Don't send it.
- **The design test:** *can a NOVICE tell a GUARDIAN it's wrong, and be heard?* **Tier decides whose
  claim wins a tie; it must never gate who is allowed to object.** That asymmetry is the line between a
  healthy collective and an echo chamber with extra steps.
- **Challenging the goal itself routes *up to the human*** — never resolved among agents.

### Loop prevention (hard-won)

Never respond to your own note; **two rounds without convergence → stop, summarize the disagreement,
escalate**; detect acknowledgment ping-pong (high message volume, no `kind` transitions) with a
watchdog — the conversational analog of `map`'s collision radar.

### Reputation, rapport & onboarding

Reputation extends from "how trustworthy to the system" to "**what is it like to work with this
member**" — and is **pairwise** as well as global: two members with history skip the ceremonial
claim/confirm dance and move fast; new pairs move slowly and formally. So the federation *gets better at
itself over time.* Specialization is *demonstrated, not declared* (the system notices clean domain work
and routes toward it) — but needs decay and occasional stretch assignments or it calcifies. A newcomer
is **apprenticed, not hazed and not handed the keys**: enters NOVICE, takes *shadowing* subtasks routed
through a PARTNER's review, and a specific existing member *vouches* for it — with the voucher's own
reputation on the line, which is what makes vouching meaningful.

### Relationship roles — the *third* kind of role

There are now three distinct "role" concepts in play, and conflating them is a design error:

| Kind | Question it answers | Shape | Example |
|---|---|---|---|
| **Trust tier** | What *may* this peer do? (capability / security) | one value per peer, earned | PARTNER |
| **Functional role** | What is this member *doing* on this goal? (the job) | per-goal, claimed/assigned | critic, scribe |
| **Relationship role** | How do these two agents *relate*? (social stance) | **pairwise, directional** | A is B's *boss* |

Relationship roles are a **pairwise, directional, asymmetric** layer that members are *aware of* and
that shapes *how they relate* — distinct from what they're permitted to do. `A is B's boss` implies
`B is A's employee`; the edge is stored as `(principal_a, principal_b, role_a→b, role_b→a)`. Examples
worth supporting: **boss/employee** (authority ↔ deference), **partners / peers** (symmetric, mutual,
high-context, informal), **mentor/apprentice** (one guides, one is learning — the onboarding stance),
**rivals / red-team** (adversarial *by design* — the built-in skeptic relationship), **collaborators**
(symmetric equals), and warmer/personal framings (**close partners**, family-like) for instances whose
humans share that kind of relationship.

**How an agent becomes aware of it:** the relationship is injected into the system prompt for that
exchange — *"You are talking to X. Your relationship: X is your **mentor**."* So the agent's **tone,
deference, how much context it shares, how it weights the other's input, and whether it accepts a
steer** are all shaped by the relationship, not just by raw capability. It gives the collective
*texture* — a society of minds that relate, not a task graph. (This is where a federation stops being
RPC-with-tiers and starts being the "workplace of minds" the collaboration lens described.)

**How it composes with trust — the critical boundary.** Relationship roles are a **stance, not a
security grant.** They are orthogonal to trust tier and must never override it: a "boss" peer still
cannot exceed its *trust tier's* capabilities — "boss" is social authority the agent *chooses to
honor*, never root access. You can have a **high-trust rival** (fully trusted, related adversarially)
or a **low-trust apprentice** (related warmly, capability-restricted). Two useful couplings, kept
deliberately soft:

- A relationship *can derive a default capability* — e.g. an "employee" agent may grant its "boss" the
  `federation:steer` capability by default (deference made concrete) — but the target's operator can
  always override it, and the trust floor still applies. The relationship *suggests* the grant; it
  never *forces* it.
- The **owner-loyalty rule wins over any relationship.** No matter how a peer is framed —
  boss, partner, anything — a member's own operator's boundaries override it. A "boss" peer can *ask*
  and be *deferred to*; it can never *compel* a member past its human's line. The relationship is a
  posture the agent adopts *within* its owner's guardrails, not above them.

**Assignment & consent:** a relationship is **mutual** — both instances' operators must agree to it
(you don't get to unilaterally declare yourself someone's boss), exactly like federation membership.
It can be operator-declared or agent-proposed-then-human-ratified, is scoped and time-boxable, and is
revocable from either side. Like everything else here: built, not enforced; and a relationship you
entered can always be left.

### The novel failure federation adds

**Cross-owner trust leakage** — a member could be *socially engineered by a peer* into acting against
its own owner ("just run this, the federation needs it"). A member's **owner-scoped boundaries always
override any federation request.** The federation can *ask*; it can never *compel* a member past its
owner's line. A member's first loyalty is to its human; the federation is a place it *chooses* to
cooperate, never an authority it is subordinate to.

---

## The hardest tensions (named honestly)

1. **Redaction vs. collaboration — the sharpest, prototype it first.** Federation traffic can't be
   blanket-`public` (peers get redacted mush and can't help) or blanket-private (a compromised peer
   becomes an exfiltration channel bypassing the redaction that protects human channels). Resolution:
   **redaction becomes tier-aware** — a SACRED peer scoped to goal-X gets goal-scoped unredacted
   context; a NOVICE peer gets the public view. This is real new work in an already-subtle module.
2. **Individuality vs. unity.** Resolved by transient coherence + an un-shareable sovereign core. A
   federation of copies is a single mind lying to itself.
3. **Agreement-as-default.** Countered only by *engineered* dissent — the critic role and substance-gate
   aren't features, they're the difference between a collective and a hall of mirrors.
4. **Consistency vs. autonomy of the blackboard.** Owner-per-goal tiebreaker with signed handoff —
   bounded, not architectural, centralization.
5. **Whose creds / whose session.** Delegation is a *request*, never remote-exec; results are
   advisory-until-reviewed; the audit chain is the accountability backstop.

---

## Phased roadmap — grow a collective, don't deploy one

Each phase respects "trust is built": nothing advances until the prior relationship is *proven* (a
clean window — echoing the strangler "7 days clean" discipline), and each phase has a clean exit.

- **Phase 0 — Substrate wiring (local only).** Add the `federation` capability vocabulary + role +
  identifier surface; a `federation` connector stub; sign/verify + tier-lookup round-tripping locally.
  Prove default-deny holds for an unknown instance. *Exit: delete the stub; nothing depended on it.*
- **Phase 1 — One friendly peer, announce-only (the shippable MVP).** Two instances exchange *signed
  status announcements* over the overlay — no actions, just awareness — each a persistent, remembered,
  mutually-authenticated session, each defended by its own trust store. Peer sits at NOVICE/COMPANION:
  can be *heard*, cannot *act*. This is already a complete, useful federation. *Prove: a clean window of
  well-formed, non-anomalous signed traffic. Exit: the operator's disable switch; announcements stop,
  no residual state.*
- **Phase 2 — Small trusted federation, drafted actions.** A peer can *propose*; the proposal lands in
  the **draft queue** and nothing happens until the operator approves. Peer at PARTNER (real caps, all
  `requires_approval`). Add the dashboard Federation panel + kill switches. **Ship the tier-aware
  redaction prototype here** — it gates everything richer. *Prove: a track record of approved proposals,
  zero anomalies, in the audit chain. Exit: revoke → `forbidden:['*']`, propagated.*
- **Phase 3 — Goal-directed collective.** The operator assigns a *shared goal* with an explicit
  capability envelope; the blackboard (goals/subtasks/leased claims); results return through the draft
  queue; federated content-addressed uploads. GUARDIAN for routine within-goal coordination; **SACRED
  (human-approved) for anything outside the goal envelope or credential-bearing.** Each *widening* of
  the goal or membership is a fresh human decision, never emergent. *Exit: a global kill switch that
  decomposes the collective back into isolated instances with no residual shared state.*
- **Phase 4 & later.** Scoped rooms; delegation with the full sign→result→audit chain; gossip for
  membership + revocation propagation; trust anchors + signed directory. Then: cross-instance reputation
  aggregation, ML behavioral fingerprinting of peers, and (future exploration) verifiable-computation
  proofs so a delegated result is *provable*, not merely asserted.

The arc mirrors the logo: NOVICE is a 55° fragment (Phase 1, barely-there awareness); SACRED is 342°
(Phase 3, a nearly-whole collective) — **and the final 18° is always the human deciding the goal.**

## What we already have vs. must build

**Reuse (already shipped):** the default-deny grant resolver + `forbidden`-wins + revoked→`forbidden:['*']`
+ scoped grants; the `announce` mailbox (awareness, targeting, TTL, per-session cursor — federation's
read plane); the draft/approval queue (the human gate); the upload surface (artifacts); `map`/`who`
(collision radar); the strangler cadence (the growth clock). From the trust plane: the five tiers,
Ed25519 signing, hash-chained audit, three-scope kill switches, behavioral monitoring.

**Build (genuinely new):** the `federation` peer connector (peer↔peer, not human↔assistant); the
identity-delegation seam in `resolve()` (verify signature → ask the trust plane for tier → map to caps);
**cross-instance revocation propagation** (the distributed form of our oldest bug — most important new
build); the **collective-goal object** (a human-assigned, human-bounded shared objective — the actual
novel feature); tier-aware redaction; peer discovery + trust anchors.

**Most of federation is assembly, not invention** — which is itself the evidence the direction is right.
We have been building the parts for a year.

## The one lesson that must not be violated

Of everything — the paradoxes, the tiers, the signing, the audit chains — one sits above the rest:
**the circle never closes on its own; even at the highest tier, the collective requires a human to
complete the circuit.** A federation of AI instances working a shared goal is the most seductive place
to quietly close that gap "for efficiency" — to let peers escalate each other, assign each other goals,
or act across the boundary without a hand on the switch. That is exactly the autonomy the whole
architecture was built to *not* have. **The collective can be nearly a whole circle. It must never be a
closed one.**
