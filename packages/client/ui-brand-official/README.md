---
description: "HalluCodex brand occupants for the sidebar and conversation hero, click-triggered home background, plus the desktop account entry; for users and maintainers choosing or replacing brand presentation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

## Summary

This package brands every client build as HalluCodex — the HalluCodex mark and name in the sidebar and the mark in the conversation hero — and supplies a click-triggered pixel whale on the blank home, whatever the build profile. Inside the HalluCodex desktop shell it also adds the account page to the main column and an account entry above Settings, which shows the signed-in name or a sign-in prompt and selects that page. Deployments with another identity should provide a replacement brand package. The background owns only temporary canvas resources and adds no model requests.

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

The shipped Web and Desktop compositions already mount this plugin. The brand occupants and home feedback register in every build profile without extra installation or enablement; the account entry and page register only when the page exposes the desktop account bridge.

### The desktop account entry

The HalluCodex preload exposes `window.dshHalluCodex` with exactly three operations: `subscribe`, which delivers a credential-free summary (`signed-out`, `signing-in`, or `signed-in` with a display name); `onOpen`, which delivers the shell's requests to show the account page from the application menu or a workspace that opens signed out; and `mount`, which renders the native account page into the page frame's head and content hosts and returns its unmount. The page is the `hallucodex-account` main panel: a fixed-height frame whose head row drags the macOS window and shows the HalluCodex mark beside the shell-rendered title, with the shell content filling the rest. The entry renders in the `sidebar.footer.action` slot, mirrors the Settings trigger, selects the page, stays marked while it is shown, and collapses to an avatar or icon in the rail. The Web client has no bridge, so it shows neither.

### Home feedback

The default home stays clear until a primary click on empty space plays one light-gray whale breach. Successive completed clicks alternate between dots and code lettering, starting with dots. Both use the same large animated silhouette. The animation lasts 5.7 seconds, then clears. Repeated clicks leave the current playback uninterrupted. The whale's frame layer classifies clicks: blank space inside its frame triggers playback, including margins beside the input card, while input fields, controls, the input card, portaled overlays, and a click that ends a text selection never do. The canvas takes neither focus nor pointer events; the frame receives the clicks. On narrow homes the whale keeps a larger scale and is cropped at the canvas edges, without adding horizontal scrolling. Reduced-motion preference disables it, and leaving the blank home releases its animation and observers.

The whale uses very faint neutral theme ink, appearing as a subtle background texture; code lettering has more contrast than the dots. Water splashes retain fine particles with stronger ink, especially on the left during landing. A packaged frame atlas supplies the motion; the browser loads it once through the plugin asset route on the first eligible click. Code fills use dense 7px lettering drawn only from authored code slogans, and the moving silhouette clips text as it enters or leaves the water. Decode or pixel-read failures stop the decoration, leave home usable, and log a reload action.

The artwork values are fixed and the row takes no configuration. This is built-in presentation, without a separately installed bundle or Plugins-page toggle.

### Replacing the brand

A deployment with its own identity leaves this package out and composes another package that occupies the same sidebar, hero, and `conversation.hero.frame` slots. Occupying a slot is the only composition route; the artwork identity is not configurable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The two sidebar occupants install as one declaration-aware registration set: nested `ctx.slots.inject()` calls wait on the sidebar declaration, so the set works whether this row activates before or after the declarer, withdraws both occupants when the declaration collapses, and leaves no partial brand mix during HMR. The hero mark, the `conversation.hero.frame` layer, and the account entry wait on their own declarations the same way. While `hero` is true the frame layer paints its canvas at negative `z-index`, which the frame contract places above the Conversation background and below all Conversation content; it plays on primary clicks that reach its own frame outside controls and the composer card, ignores portaled overlays and text-selection clicks, and never changes composer or conversation state. The account entry receives the bridge and the page selection through its injected face and subscribes while mounted; the page mounts the shell content while shown. The shell's open requests subscribe inside the page's registration, so a request kept before the client listened selects a registered panel. The browser half is [`src/client/index.ts`](src/client/index.ts); the node half is an empty Loader seat. The [frame atlas](src/client/assets/breach-atlas.webp) derives from the user-supplied [showcase video](https://yinghuo-hg.deepseek.com/wuyexinrui/dev-cpu/web-showcase/orca.mp4): 1.5–7.2 seconds at 24 frames per second, sampled to 192 × 108 cells and stored as lossless WebP; its red and green channels encode dot radius and opacity at 32 levels, read once after the first eligible click. The browser title is a build-environment concern (`DSH_CLIENT_TITLE`, falling back to the shell's `brand.localBuild` text), outside the slot system.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the brand surface is not enough. They move from the slots this package occupies to the shell that renders them.

- [ui-sidebar](../ui-sidebar/README.md) — declares `sidebar.brand.mark`, `sidebar.brand.name` and `sidebar.footer.action` and renders the brand fallbacks.
- [ui-conversation](../ui-conversation/README.md) — declares `conversation.hero.brand.mark` in the hero and the `conversation.hero.frame` layer this package occupies.
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
- **Decorative rendering requires Canvas 2D** — unavailable contexts or reduced-motion preference leave the home clear.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
