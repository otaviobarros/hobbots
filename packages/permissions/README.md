# packages/permissions

The policy engine of [ADR 014](../../docs/decisions/014-tool-policy-and-enforcement.md): Allow, Ask or Deny for a normalized operation on a concrete resource (PE-002). The operations, the preset table and the per-hob policy shape live in `@hobbots/domain` (`policy.ts`), so every package reads the same table.

- `PolicyEngine.decide(context, request)` canonicalizes every path and folder, then decides. It never fails: a path it cannot resolve, such as a symlink loop, is denied.
- `evaluate(context, scope, request)` is the pure decision on already canonical paths.
- The answer is the narrowest of the preset, the hob's overrides and every restriction added by the thread, Quest, task or delegation, so nothing can widen it (AG-004, PE-004). A request carries only the operation and its resource, never the model's account of it.
- Each `PolicyVerdict` names the decision, the operation decided (outside-folders for a target outside the hob's folders), a reason code and message, the canonical targets, whether the rule is enforced or only checked, whether an approval is once only, and the policy version: the rules version plus a digest of every policy input, so an approval can be bound to the exact policy it was given under.

Canonical paths follow the kernel: components are resolved one by one, so `link/..` climbs from the link's target; a dangling symlink resolves to its target; a path that does not exist yet resolves through its nearest existing parent; comparison follows the case sensitivity of the volume, probed on disk (`~/Code` and `~/code` are one folder on a case-insensitive macOS volume). Hosts are normalized as a URL parser would, and loopback, link-local and cloud metadata addresses are denied, including when a public name resolves to one.

The engine decides; it does not enforce. The runtime's policy hook and the OS sandbox that apply its answers belong to the Claude Code adapter (#131). Approvals and their lifetimes come with #133.
