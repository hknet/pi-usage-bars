# Provider support research

This document records providers considered for usage-bar support. Recheck blocked findings when a provider publishes a new quota, balance, or billing API.

## Qwen Token Plan

**Status:** Blocked — no account-usage surface found as of 2026-08-13.

Pi 0.84.1 supports these provider IDs:

- `qwen-token-plan`
- `qwen-token-plan-individual`
- `qwen-token-plan-cn`

The Individual provider shares the international inference endpoint and `QWEN_TOKEN_PLAN_API_KEY` with the existing international provider, but exposes a narrower model catalog.

Research found no documented API-key-authenticated endpoint that reports consumed or remaining quota, percentages, or reset times. Independent probing of eight likely usage/quota paths on `token-plan.ap-southeast-1.maas.aliyuncs.com` returned `404`, and successful inference responses did not include quota or rate-limit headers. Qwen's client can recognize an exhausted-quota error, but that provides no usage percentage or reset timestamp.

Do not estimate account-wide quota from requests observed by this extension: other clients and sessions would make that value incomplete and misleading.

**Recheck when:** Alibaba Model Studio documents a Token Plan usage endpoint, adds quota headers to inference responses, or exposes a key-authenticated portal API.

## Baseten

**Status:** Supported as of 2026-08-28.

Pi's `baseten` provider resolves `BASETEN_API_KEY`. Baseten documents `GET https://api.baseten.co/v1/billing/usage_summary`, authenticated with `Authorization: Bearer $BASETEN_API_KEY`, with required UTC `start_date` and `end_date` parameters (maximum range: 31 days). The response reports `credits_used` for dedicated serving, training, and Model APIs. The extension queries the current UTC calendar month and reports the aggregate Credits used; it intentionally does not manufacture a remaining balance or quota percentage.

**Recheck when:** Baseten publishes a first-party balance, budget, or quota API that permits a more complete account indicator.

## Vercel AI Gateway

**Status:** Supported as of 2026-09-24.

Pi's `vercel-ai-gateway` provider resolves `AI_GATEWAY_API_KEY`. Vercel documents `GET https://ai-gateway.vercel.sh/v1/credits`, authenticated with the same API key as a bearer token. The response reports the team's remaining AI Gateway Credits balance and total lifetime spend in USD.

**Recheck when:** Vercel adds defined-period spend or budget fields that provide more actionable detail than lifetime spend.

## Fireworks

**Status:** Supported as of 2026-09-24.

Fireworks documents bearer-key-authenticated account discovery through `GET https://api.fireworks.ai/v1/accounts` and account-wide rated costs through `GET /v1/accounts/{account_id}/billing/summary`. Fireworks states that any key on the target account can use the API. A live redacted test with an ordinary user API key resolved through Pi's `fireworks` provider returned HTTP 200 for account discovery, billing summary, quotas, and the self-scoped usage-cost query. It exposed one accessible account; no credential, account identifier, or raw response was retained.

The extension reports rated spend for the current UTC calendar month from the billing summary. It does not use the `monthly-spend-usd` quota as a budget percentage because validation observed a `9,999,999` default that appears to mean effectively unlimited rather than an actionable budget. Exactly one accessible account is selected automatically. When a key can access multiple accounts, `PI_FIREWORKS_ACCOUNT_ID` must match one of the discovered account IDs; the extension does not guess or aggregate accounts.

**Recheck when:** Fireworks documents an account credit balance or a reliable distinction between explicit spend budgets and effectively unlimited quota values.

## xAI

**Status:** Supported as of 2026-09-24.

xAI documents its billing APIs at `https://management-api.x.ai`, authenticated with a Management Key that is deliberately separate from the normal inference API key or subscription OAuth credential used by Pi's `xai` provider. The extension registers the model-less `pi-usage-bars-xai-management` provider so `/login` can prompt for and store a read-only Management Key through Pi's credential system. `XAI_MANAGEMENT_KEY` remains an optional environment fallback.

A live redacted test with a read-only, team-scoped key returned HTTP 200 for key validation, prepaid balance, current invoice preview, and postpaid spending limits. The extension validates `SCOPE_TEAM`, obtains the team ID internally, and reports the prepaid accounting total as a positive available balance plus `coreInvoice.totalWithCorr` as current billing-cycle spend. It never logs the key, team ID, ACL contents, or raw response. Organization-scoped keys are rejected rather than guessing or aggregating teams.

**Recheck when:** xAI adds team discovery for organization-scoped Management Keys or exposes billing through the ordinary inference credential.

## Meta Muse

**Status:** Blocked — no documented account-usage API found as of 2026-09-24.

Pi 0.86.1 added the `meta` provider with Meta Muse subscription OAuth and `META_API_KEY` authentication. No documented first-party endpoint was found for remaining subscription quota, reset timing, account balance, or spend. Do not infer quota from local requests or use undocumented console endpoints.

## Pi 1.3.0 provider audit (2026-10-20)

Comparing the registered `builtinProviders()` lists in [`pi-ai` 0.87.1](https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/providers/all.ts) and [1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/providers/all.ts) found one new provider, `typesafe`, and the Azure provider rename from `azure-openai-responses` to `azure`. The other built-in provider IDs were already present in the 0.87.1 baseline.

### TypeSafe

**Status:** No documented key-authenticated account-usage endpoint found in the reviewed documentation.

Pi documents `typesafe` as a classifier provider. Classifier models do not appear in `/model`; they are called through the classifier API, so they are not the active chat model this extension monitors. That only prevents active-model footer monitoring; the blocker for account usage reporting is separate. TypeSafe's public `POST /v1/systemone` response reports token usage for that individual request and its docs describe per-organization rate limits and per-token pricing, but no key-authenticated account-level quota, balance, or period-spend endpoint is documented. Summing requests seen by Pi would omit activity from other clients and would not represent account usage.

Sources: [Pi classifier models](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/models.md#use-classifier-models), [TypeSafe API](https://docs.typesafe.ai/api/system-one), [TypeSafe model pricing and limits](https://docs.typesafe.ai/models).

### Xiaomi MiMo Token Plan

**Status:** Blocked — no documented key-authenticated account-usage endpoint found in the reviewed documentation as of 2026-10-20.

Xiaomi's official documentation describes fixed monthly/annual Token Plan Credits and says current plan usage is available through the Token Plan progress bar/console. Its published API reference lists inference, rate-limit, and model endpoints, but no API-key-authenticated endpoint for remaining/used plan credits or reset time was found. Do not scrape the console or invent usage from requests observed by Pi. Revisit if Xiaomi publishes an authorized account-usage API.

Sources: [Xiaomi Token Plan pricing and quota](https://mimo.mi.com/docs/en-US/price/token-plan), [Xiaomi Token Plan usage FAQ](https://mimo.mi.com/static/docs/quick-start/faq/token-plan/Usage&Quota.md), [Token Plan console](https://platform.xiaomimimo.com/token-plan), [published API reference](https://mimo.mi.com/llms.txt), [Pi provider authentication](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/providers.md).

### GitHub Copilot metrics

**Status:** Not suitable for per-user usage bars through Pi's normal Copilot credential.

GitHub's documented Copilot usage-metrics API returns organization or enterprise reports. The policy must be enabled for the enterprise, and access requires the relevant enterprise/org reporting permissions; the API is not a personal subscription balance or remaining-quota endpoint. Pi resolves a user's Copilot sign-in/token, which does not establish those administrator permissions or an organization context. Supporting enterprise reports would need a separate, explicitly configured admin credential and scope, and would still not provide a user's current personal quota.

Source: [GitHub Copilot usage metrics API](https://docs.github.com/en/rest/copilot/copilot-usage-metrics).

## Acceptance criteria for a new provider

A provider is suitable when a documented first-party API or response header supplies at least one meaningful account-level value:

- quota consumed or remaining, ideally with a reset time;
- account balance or credits; or
- spend for a defined billing period.

Authentication must work through Pi's provider credential API. The extension must not import browser cookies, scrape console pages, estimate account-wide usage from local traffic, or send credentials to third-party services.
