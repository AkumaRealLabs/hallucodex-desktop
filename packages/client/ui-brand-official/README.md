---
description: "HalluCodex brand occupants for the sidebar and conversation hero, plus the desktop account entry; for users and maintainers choosing or replacing brand presentation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

## Summary

This package brands every client build as HalluCodex: the HalluCodex mark and name in the sidebar and the mark in the conversation hero, whatever the build profile. Inside the HalluCodex desktop shell it also adds an account entry above Settings, which shows the signed-in name or a sign-in prompt and opens the desktop account dialog. Deployments with another identity should provide a replacement brand package. It keeps no runtime state of its own and does not affect model requests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in the browser roster. The brand occupants register in every build profile; the account entry registers only when the page exposes the desktop account bridge.

### The desktop account entry

The HalluCodex preload exposes `window.dshHalluCodex` with exactly two operations: `subscribe`, which delivers a credential-free summary (`signed-out`, `signing-in`, or `signed-in` with a display name), and `open`, which opens the native account dialog. The entry renders in the `sidebar.footer.action` slot, mirrors the Settings trigger, and collapses to an avatar or icon in the rail. The Web client has no bridge, so it shows no entry.

### Replacing the brand

A deployment with its own identity leaves this package out and composes another package that occupies the same sidebar and hero slots. Occupying a slot is the only composition route; there is no brand configuration surface here.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The two sidebar occupants install as one declaration-aware registration set: nested `ctx.slots.inject()` calls wait on the sidebar declaration, so the set works whether this row activates before or after the declarer, withdraws both occupants when the declaration collapses, and leaves no partial brand mix during HMR. The hero mark and the account entry wait on their own declarations the same way. The account entry receives the bridge through its injected face and subscribes while mounted. The browser half is [`src/client/index.ts`](src/client/index.ts); the node half is an empty Loader seat. The browser title is a build-environment concern (`DSH_CLIENT_TITLE`, falling back to the shell's `brand.localBuild` text), outside the slot system.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the brand surface is not enough. They move from the slots this package occupies to the shell that renders them.

- [ui-sidebar](../ui-sidebar/README.md) — declares `sidebar.brand.mark`, `sidebar.brand.name` and `sidebar.footer.action` and renders the brand fallbacks.
- [ui-conversation](../ui-conversation/README.md) — declares `conversation.hero.brand.mark` in the hero.
- [Desktop app](../../../apps/desktop/hallucodex/README.md) — the account dialog and the preload bridge behind the account entry.
- [Web client architecture](../../../docs/subsystems/web-client.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how brand presentation is supplied. They are current package constraints, not a brand-design comparison or a task backlog.

- **One occupant set** — alternative presentation belongs in another Cordis package occupying the same slots.
- **The mark is a placeholder** — the drawn HalluCodex mark stands in until official artwork replaces `HALLUCODEX_MARK_PATH` and the desktop icons.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
