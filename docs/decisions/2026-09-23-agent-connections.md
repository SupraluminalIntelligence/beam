# Agent accounts, machines, and shared workspace execution

Status: accepted product decision. Implementation status is tracked in [the implementation plan](../agent-connections-plan.md).

## Decision

An agent, provider account, authenticated connection, execution machine, and shared resource are distinct identities. The current machine's connection is the default. Settings can choose a global preference per harness; a personal chat override takes precedence. No silent fallback to another account or machine. Provider credentials stay in the provider's local profile, never in Convex or the browser.

| Concept | Example | Meaning |
| --- | --- | --- |
| Agent identity | Apex's Codex | Whose agent is acting |
| Provider account | Apex's Work Codex | Which subscription or API billing is used |
| Connection | Work Codex on Mac Studio | An authenticated profile available on a machine |
| Execution machine | Apex's Mac Studio | Where the agent runs |
| Shared resource | Noah's website folder | Files/services accessible independently of agent location |

## Selection matrix

| Situation | Account used | Machine used | Behavior |
| --- | --- | --- | --- |
| No preferences | Local default for the harness | Current machine | Show resolved identity before send |
| Multiple local accounts | Designated local default or explicit selection | Current machine | Ask for a default when ambiguous |
| Global preferred account available locally | Preferred account | Current machine | Show resolved connection |
| Global preferred account only remote | Preferred account | Designated remote host | Explicit remote label before dispatch |
| Preferred account on multiple remote hosts | Preferred account | Saved preferred host | Require host choice when ambiguous |
| Chat account override | Override wins over global/local | Prefer a verified local connection; otherwise selected host | Persistent override per person/chat/harness |
| Offline or signed-out selection | No substitution | None | Reconnect or choose another connection |
| Same chat opened on another laptop without override | New laptop's default | New laptop | Applies to new runs |
| Existing run elsewhere | Original account | Original host | Opening chat never moves a run |
| Preferences change during run | Original account | Original host | Changes affect next run |

## Multiple subscriptions and shared workspaces

| Situation | Behavior |
| --- | --- |
| Multiple accounts on one machine | Named independently authenticated profiles |
| Same account on several machines | Group only with a verified provider identity; never email alone |
| Same email with different organizations/billing | Distinct connections unless identity is verified |
| Noah's agent reads/edits Apex's shared folder | Noah's provider connection; operations on Apex's resource host |
| Apex's agent accesses Noah's preview | Apex's provider connection; Noah hosts the preview |
| Explicit use of Noah's provider connection | Account owner opt-in plus requester selection |
| Instruction to existing run | Original connection regardless of instruction author |
| Simultaneous agents | Independent identity, account, host, activity, stop controls |
| Account changes underneath session | Detect and surface mismatch; never invent historical attribution |

## Workspace sharing policy

Folders deliberately introduced to a shared workspace are automatically available to its trusted members and agents by default. An optional approval setting can require explicit grants. Unrelated chats and incidental reads of system files do not expand sharing. Resources remain distributed across owners' machines, not one common live folder or automatically mirrored checkouts. Commands confined to contributed projects are part of access; project dependency installation and machine-wide installation are separate options. Operations outside contributed resources require extending permission. A working directory is not a sandbox: containment must be enforced before claiming folder-only command access.

Shared previews need authenticated workspace access, revocation, host availability, and clear ownership. No public port exposure by default. Provider connection sharing is separate from folder/service sharing.

## Identity and presentation

Use editable machine names (Work MacBook Pro, Personal MacBook Pro, Mac Studio, Windows Desktop). Show `Apex's Codex · Work account · Mac Studio`, and separately `Accessing Website on Noah's Work MacBook`. Preserve Beam's tokens, compact monochrome controls, thin rules, existing type scale, accessible labels and status colors. Freeze connection ID, account metadata, host name, requester and model on each run. Historical runs lacking metadata stay unattributed.

## Provider verification

- Codex documents CODEX_HOME and provider-managed credential storage: https://learn.chatgpt.com/docs/auth and https://learn.chatgpt.com/docs/config-file/config-advanced.
- Claude documents CLAUDE_CONFIG_DIR for separate configuration profiles: https://code.claude.com/docs/en/env-vars.
- Use per-process profile configuration, not global environment mutation, credential copying or login/logout swapping. API-key connections lacking provider identity remain distinct. Account grouping requires positive provider identity evidence.
