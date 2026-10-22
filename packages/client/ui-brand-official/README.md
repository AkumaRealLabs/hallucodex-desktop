---
description: "HalluCodex brand occupants for the sidebar and conversation hero, plus the desktop account entry; for users and maintainers choosing or replacing brand presentation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

## Summary

This package brands every client build as HalluCodex: the HalluCodex mark and name in the sidebar and the mark in the conversation hero, whatever the build profile. Inside the HalluCodex desktop shell it also adds the account page to the main column and an account entry above Settings, which shows the signed-in name or a sign-in prompt and selects that page. Deployments with another identity should provide a replacement brand package. It keeps no runtime state of its own and does not affect model requests.

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

Mount this plugin in the browser roster. The brand occupants register in every build profile; the account entry and page register only when the page exposes the desktop account bridge.

### The desktop account entry

The HalluCodex preload exposes `window.dshHalluCodex` with exactly three operations: `subscribe`, which delivers a credential-free summary (`signed-out`, `signing-in`, or `signed-in` with a display name); `onOpen`, which delivers the shell's requests to show the account page from the application menu or a workspace that opens signed out; and `mount`, which renders the native account page into the page frame's head and content hosts and returns its unmount. The page is the `hallucodex-account` main panel: a fixed-height frame whose head row drags the macOS window and shows the HalluCodex mark beside the shell-rendered title, with the shell content filling the rest. The entry renders in the `sidebar.footer.action` slot, mirrors the Settings trigger, selects the page, stays marked while it is shown, and collapses to an avatar or icon in the rail. The Web client has no bridge, so it shows neither.

### Replacing the brand

A deployment with its own identity leaves this package out and composes another package that occupies the same sidebar and hero slots. Occupying a slot is the only composition route; there is no brand configuration surface here.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The two sidebar occupants install as one declaration-aware registration set: nested `ctx.slots.inject()` calls wait on the sidebar declaration, so the set works whether this row activates before or after the declarer, withdraws both occupants when the declaration collapses, and leaves no partial brand mix during HMR. The hero mark and the account entry wait on their own declarations the same way. The account entry receives the bridge and the page selection through its injected face and subscribes while mounted; the page mounts the shell content while shown. The shell's open requests subscribe inside the page's registration, so a request kept before the client listened selects a registered panel. The browser half is [`src/client/index.ts`](src/client/index.ts); the node half is an empty Loader seat. The browser title is a build-environment concern (`DSH_CLIENT_TITLE`, falling back to the shell's `brand.localBuild` text), outside the slot system.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the brand surface is not enough. They move from the slots this package occupies to the shell that renders them.

- [ui-sidebar](../ui-sidebar/README.md) — declares `sidebar.brand.mark`, `sidebar.brand.name` and `sidebar.footer.action` and renders the brand fallbacks.
- [ui-conversation](../ui-conversation/README.md) — declares `conversation.hero.brand.mark` in the hero.
- [Desktop app](../../../apps/desktop/hallucodex/README.md) — the account page and the preload bridge behind the account entry.
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
- **The mark ignores the theme** — the sidebar and hero show the full-color logo artwork (`HALLUCODEX_MARK_IMAGE`) in light and dark themes alike.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
