# Changelog

## Unreleased

### Fixed

- Resolve kimi-coding OAuth credentials that Pi exposes only as a Bearer `Authorization` header (no `apiKey`), so the Kimi For Coding usage indicator no longer reports "auth resolution failed (configured authentication did not resolve a token)".

### Documentation

- Recorded Qwen Token Plan and Baseten usage-API research, including the conditions for revisiting provider support.

## [0.4.2] - 2026-08-13

### Fixed

- Added support for credit-based ZAI plan tiers that report `CREDIT_LIMIT` quota windows. Thanks to [@chrislucca](https://github.com/chrislucca) for the contribution in [#1](https://github.com/hknet/pi-usage-bars/pull/1).

### Changed

- Updated the development and test baseline to Pi SDK 0.84.1 while retaining runtime compatibility with Pi 0.81.1 and newer.

### Security

- Updated the Pi SDK development dependency chain to use `undici` 8.9.0, resolving the advisories affecting earlier 8.x releases.

## [0.4.1] - 2026-07-31

### Fixed

- Classify Codex quota windows by `limit_window_seconds` instead of assuming `primary_window` is always the session limit. Codex accounts that expose only a seven-day primary window now show it as Weekly and no longer display a fabricated `Session 0%` lane.

### Changed

- Updated the development and test baseline to Pi SDK 0.83.0 while retaining runtime compatibility with Pi 0.81.1 and newer.

## [0.4.0] - 2026-07-22

### Added

- Added Kimi For Coding quota support through Pi's `kimi-coding` credential and the first-party five-hour/weekly usage endpoint.
- Added separate MiniMax Global and China Coding/Token Plan support, including the current token-plan endpoint and legacy coding-plan fallback.
- Added provider-specific quota labels and support for MiniMax responses that expose an interval quota without a weekly quota.
- Added neutral MiniMax purchased-Credits balance rendering when a key-authenticated first-party response exposes a balance.
- Added OpenRouter account balance and daily/weekly/monthly key spend using the first-party Credits and Key APIs.
- Added OpenRouter per-key limit bars only when the key has a real configured credit limit.
- Added DeepSeek total, topped-up, and granted balance support through the official key-authenticated balance API.
- Added separate Moonshot/Kimi API Global and China available, cash, and voucher balance support.
- Added a typed financial-metrics roadmap for further balance/spend providers.
- Added provider parsing, regional routing, endpoint fallback, financial rendering, authentication lifecycle, and smoke tests.
- Added CI, reproducible installs, production auditing, and a maintainer release guide.

### Changed

- Treat MiniMax status `2062` as a neutral “No active Token Plan” account state rather than an API error; the cookie-only console balance endpoint remains out of scope.
- Expanded endpoint configuration documentation for Kimi, MiniMax, OpenRouter, DeepSeek, and Moonshot.
- Changed npm publishing to an explicit manual workflow so source tags cannot accidentally republish an already released version.
- Bumped the package version to 0.4.0.

## [0.3.0] - 2026-07-22

### Breaking changes

- Renamed the npm package to `@hk_net/pi-usage-bars`; install it with `pi install npm:@hk_net/pi-usage-bars`.
- Updated the minimum supported Pi release to 0.81.1.
- Removed Google Gemini CLI and Google Antigravity usage support, matching their removal from Pi 0.71.0.
- Refactored core usage orchestration to accept resolved provider tokens instead of reading or refreshing Pi credentials directly.

### Added

- Added ZAI Coding Plan (China) provider and quota endpoint support.
- Added abort-aware polling and provider requests.
- Added strict TypeScript checking, a current-Pi smoke test, pinned development dependencies, and reproducible npm installs.
- Added Pi package gallery image metadata and documented endpoint/security behavior.

### Changed

- Authentication now goes through `ctx.modelRegistry.getProviderAuth()`, allowing Pi to safely resolve and refresh credentials with its canonical locked credential store.
- Renamed Z.AI to the current Pi labels, ZAI Coding Plan (Global) and ZAI Coding Plan (China).
- Limited polling and custom `/usage` UI to interactive TUI mode.
- Made startup and model-change polling non-blocking and added complete session shutdown cleanup.
- Updated the selector to use typed TUI APIs, explicit render requests, abortable loading, and theme-safe invalidation.

### Fixed

- Fixed OAuth refresh failures on Pi 0.81.1 caused by the removed runtime `getOAuthApiKey` export.
- Fixed potential credential races and permission changes caused by direct `auth.json` writes.
- Fixed in-flight polling and selector requests surviving session shutdown or dialog disposal.

## [0.2.3] - 2026-06-10

### Fixed

- **`DynamicBorder` is not defined** — added missing import of `DynamicBorder` from `@earendil-works/pi-coding-agent`. This fixes the `DynamicBorder is not defined` error when calling `/usage`.

### Changed

- Updated repository URLs from `ajarellanod` to `hknet` in `package.json` and `README.md`.
- Updated README image URLs to point to the `hknet` repository.
- Updated LICENSE copyright to `ajarellanod (secondary: hknet)`.

### Removed

- Removed stale tgz build artifacts and `package-lock.json` from the repository.
- Removed `NOTE.md` compliance report (development artifact).

## [0.2.2] - 2026-06-10

### Fixed

- **Keybinding violation in `UsageSelectorComponent`** — replaced `getKeybindings()` with the `keybindings` parameter injected by `ctx.ui.custom()`. Per the Pi extension docs, custom components must use the injected `KeybindingsManager` directly rather than calling `getKeybindings()` or `setKeybindings()`. This fixes a compliance issue that could cause unexpected behavior under custom keybinding configurations.
