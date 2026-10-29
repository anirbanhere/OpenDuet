# Next PRD slice: independent model and speech roles

29 October 2026. Continuing the human-requested active PRD goal on `codex/provider-role-contracts`, based on the shipped appointment console plus handoff. Hourly thread continuation is configured in the app; check fresh account usage on a resumed run and continue from current state rather than starting over. Never redeem reset credits or buy credits without separate explicit authorization.

## First vertical increment

Define and validate separate reasoning, conversation, optional extraction, STT and TTS configurations. Preserve the existing browser-selected chat model, free/paid/provider guardrails and native Meta lookup. Configuring a speech role is not permission to upload audio or claim live speech support. No production profile or private database changes in this increment.

Create provider-neutral transcript/audio/result contracts and injectable synthetic speech adapters. Synthetic adapters must explicitly identify fixture lookup/generated test audio; they are not ASR or natural speech. Unknown fixtures/languages and unconfigured live providers fail with useful diagnostics. Support en-IN/hi-IN/ta-IN fixtures first; ml-IN/kn-IN remain requested evaluation targets.

Acceptance tests prove that changing STT leaves model/TTS roles unchanged, changing TTS leaves STT/tool semantics unchanged, role configurations are immutable snapshots for callers, unsupported combinations fail clearly, and diagnostics never include credentials or raw private audio. Use injected transports and synthetic state only. Do not add a public upload endpoint or send household context to providers merely to test contracts.

Expose or exercise the contract through a small keyless evaluation/check path, with honest capability diagnostics. Do not expose unused selectors as working voice features. Durable role pinning on general model-led tasks and consented real-provider speech evaluation are the next integration increments, not claims satisfied by interface definitions alone.

## Follow-on order

1. Contracts/configuration, mock adapters, diagnostics and independent-swap tests.
2. Integrate role snapshots with the bounded planning/task path and preserve restart/no-replay behavior.
3. Design owner-scoped consent/retention/media lifecycle before enabling real audio input.
4. Add explicitly configured speech provider adapters after official-doc verification and evaluate consented launch-language samples. No new provider credential is requested until a concrete adapter is ready.

Keep the existing public demo usable, preserve v5 data and quotas, publish small unmerged PRs, and update HANDOFF before stopping or context transitions. Shared contributor assignments remain unassigned; do not take over another developer's checkout or message other tasks without the human's authorization.

## Current increment checklist

- [x] Independent immutable role configuration and actual bounded reasoning/conversation routing.
- [x] Session-protected diagnostic route and original-model duplicate recovery.
- [x] Synthetic STT/TTS contracts, independent swaps, consent/input/output/deadline guards.
- [x] Actual keyless CLI evaluation and explicit operator-script type checking.
- [x] Final scoped Linux CI, packed-service audit/smoke and unmerged draft PR11; public deployment unchanged.
- [ ] Follow-on: durable general-task role pins, structured planning, owner-scoped media and genuine speech adapters/evaluation.
