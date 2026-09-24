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

**Status:** Candidate — documented API is suitable, but multi-account behavior needs validation.

Fireworks documents bearer-key-authenticated account discovery through `GET https://api.fireworks.ai/v1/accounts` and rated costs through `GET /v1/accounts/{account_id}/billing/summary`. This can support current-period spend using Pi's resolved `FIREWORKS_API_KEY`, but implementation should first validate ordinary inference-key permissions and define how multiple accessible accounts are selected or aggregated.

## Meta Muse

**Status:** Blocked — no documented account-usage API found as of 2026-09-24.

Pi 0.86.1 added the `meta` provider with Meta Muse subscription OAuth and `META_API_KEY` authentication. No documented first-party endpoint was found for remaining subscription quota, reset timing, account balance, or spend. Do not infer quota from local requests or use undocumented console endpoints.

## Acceptance criteria for a new provider

A provider is suitable when a documented first-party API or response header supplies at least one meaningful account-level value:

- quota consumed or remaining, ideally with a reset time;
- account balance or credits; or
- spend for a defined billing period.

Authentication must work through Pi's provider credential API. The extension must not import browser cookies, scrape console pages, estimate account-wide usage from local traffic, or send credentials to third-party services.
