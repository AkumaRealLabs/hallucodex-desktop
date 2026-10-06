# HalluCodex desktop account modules

English | [中文](README.zh.md)

This reference covers the native modules in [src/hallucodex](../src/hallucodex). They compose secure account restoration, authenticated model discovery, and a fixed-origin relay for `https://api.hallucodex.com`. Linux packages enable the native account by default. An unpackaged development launch enables it with `DSH_HALLUCODEX_DESKTOP=1`. The branded profile disables upstream account, manual-key, and configurable-provider entries. The application menu opens the native account dialog; its operations are limited to the owned primary frame. The desktop authorization endpoints are a separate New API integration; the modules do not reinterpret a dashboard JWT, PAT, or ordinary API key as a desktop grant.

## Native ownership

Construct `HalluCodexDesktopRuntime` in the Electron main process after `app.whenReady()` and after acquiring the application's single-instance lock. Supply `SafeStorageRefreshStore` in a dedicated directory under the app's trusted user-data directory, `HalluCodexHttpAuthTransport`, native `fetch`, and `shell.openExternal`. `getSnapshot`, `startSignIn`, `cancelSignIn`, `restore`, `refreshCatalog`, and `signOut` are the account UI operations. The shell validates its owned window and main-frame origin for every account IPC call. The preload renders only safe snapshots and localized copy, cancels sign-in when the dialog closes, and never exposes raw IPC or token readers.

The trusted Host uses an authenticated IPv4 loopback relay to reach `invoke`. Its random local capability travels only over Node IPC, never configuration files, environment variables, renderer state, or session content. Each prepared request carries the account/catalog revision; a request prepared before an account or group change is rejected. It receives the response stream and the group/model captured at admission. The account broker's access resolver stays in the main process. Neither a session snapshot nor a YAML profile contains access or refresh tokens. The operating-system keyring and file permissions protect credentials at rest; they are not a security boundary against a compromised process running as the same operating-system user.

## Authorization and storage

Login opens the system browser with S256 PKCE, a random state, and an ephemeral `127.0.0.1` listener using `/oauth/callback`. The remote authorization page must stay on the pinned origin. The callback contains only the authorization code and state. Cancellation, expiry, sign-out, and newer attempts invalidate older work, including delayed network and storage results.

Access credentials remain in memory. Refresh-only records are atomically persisted in a private encrypted file. Linux requires a supported OS keyring backend; `basic_text`, unknown backends, and unavailable encryption fail closed. The account broker serializes storage operations and refresh rotation within the application instance. The caller's single-instance lock is required; the store does not provide cross-process coordination by itself.

The desktop service grants a concrete account-allowed group during browser authorization. Changing it requires a new explicit authorization in this module set; there is no client-side group override or implemented `PUT /group` operation. Expired or revoked credentials require sign-in. Transient network failures do not erase a saved refresh grant. Local sign-out blocks requests before revocation; its result separately reports whether remote revocation succeeded.

## Models and relay

Groups and models are fetched only from authenticated desktop APIs. Discovery rejects automatic and inherited groups, duplicates, malformed metadata, a mismatched catalog group, and a changed account. It publishes models and reopens relay admission only after the complete account-bound read succeeds. Public pricing or status metadata cannot grant model access or change the service origin.

The relay supports advertised Chat Completions, Responses, and Anthropic Messages endpoints. `openai-response` and `openai-responses` normalize to `/v1/responses`. Unknown protocols remain unavailable; names do not imply compatibility. Each request must select a catalog model and one of that model's advertised endpoints. The Host advertises a runnable model only when the server also supplies explicit context and output limits; it never guesses those capacities. Three native providers reuse the existing pi-ai protocol serializers with automatic retries disabled. The Anthropic SDK's local x-api-key and exact beta query are translated at the private relay, and neither is forwarded as account authentication. Request-level `group`, `auto_groups`, and `cross_group_retry` fields are rejected, including values introduced by serialization.

The relay omits browser cookies, rejects redirects, enforces the configured byte limit, and never automatically retries an inference request. A 401 or 403 closes new admission. A 429, a server error, or a network failure does not change groups or trigger a second billable request. Existing streams keep their original selection. Prices, balances, usage settlement, and channel routing remain server responsibilities.

## Verification and activation requirements

Focused keyless tests use mocked remote responses and real local callback listeners. Run the account and routing specs with `vitest run apps/desktop/tests/hallucodex-auth.spec.ts apps/desktop/tests/hallucodex-routing.spec.ts`. These do not verify a live account, a paid model call, actual OS keyring behavior, or an installed desktop build.

A branded release requires the matching opt-in New API desktop endpoints, configured model capacities, and real installed Linux qualification. The Host adapter uses the normal model selector; its catalog publication refreshes existing composers. The first native launch seeds an unselected default through the writable profile, preserving later user model selections. Linux packaging support alone does not supply those integrations. Release publishing, real credentials, and production calls are separate operations.
