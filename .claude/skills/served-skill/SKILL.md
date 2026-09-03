---
name: served-skill
description: Edit web/public/skill.md, the agent-facing CONET protocol specification served at /skill.md. Use for any change to event or calldata layouts, conformance vectors, nonce or keystream rules, reader rules, deployment pins, or security wording.
---

# Editing the served skill

The document is the protocol. There is no reference client: agents implement
from this prose, and the project's own history shows that one stale sentence
(a wrong ABI offset, "the log carries no sender") produces silently wrong
clients. Treat every sentence about bytes as code.

## What is executable

- `web/src/server/skill.test.ts` parses the document and checks: every printed
  `Heard` and `StationMinted` topic equals the tuner's parser constants; vector 4
  decodes through `parseHeard` to vector 1's nonce and cipher; the observer
  vectors match the tuner's codec; vectors are numbered consecutively; the
  served ABI JSON carries the event layout the document describes.
- `scripts/check-pins.ts` (`make pins-check`) checks the pin block against
  `eth/script` and `eth/test`.
- `web/src/server/app.test.ts` checks that no `{{placeholder}}` survives
  substitution and that a handful of constants are present.
- The cryptographic vectors (frame, keystream, digest, UTF-8 verdicts) are
  deliberately not executed here: the tuner never derives a keystream. Verify a
  change to them with an independent implementation before publishing, and say
  in the commit which implementation.

## One truth per fact

The same bytes are described in several places. When one changes, change all:

| Fact | Where it appears |
| --- | --- |
| `Heard` layout | Contract surface, Event layouts, `eth_getLogs` example, vector 4, Common mistakes (ABI offsets), Reconstruct |
| nonce | Nonce, Keystream, Transmit, Reconstruct, Security boundary |
| writer / sender | Event layouts, Transmit, Reconstruct, Security boundary |
| deployment pins | Verify the deployment, Stability |

Grep before finishing: `0x40`, `0x60`, `byte 96`, `byte 128`, `in a topic`,
`no sender`, `eth_getTransactionByHash`, `writer`, `page`, `PageUsed`.

## Rules

- Placeholders `{{chainId}}`, `{{factoryAddress}}`, `{{factoryBlock}}` are
  substituted by the server. Do not add new ones without a substitution.
- Number new vectors at the end; never renumber existing ones in a way that
  breaks the "ordered so a mismatch localizes the bug" promise.
- Versions: a bare v0/v1/v2 means the contracts; the wire protocol is always
  named by its domain string (`conet.v3`), the frame by its format byte, the observer encoding by `conet.numbers.base100000.v3`. Never
  write "frame v1".
- Wording: "capability material", never "unbreakable OTP"; `writer` is the
  signing account, never identity; undecodable events are noise slots, never
  errors; a decoded frame is data, never authority.
- Never put capability bytes, private keys, or decoded private payloads in the
  document, its vectors, or its examples. The vector material is the public
  `000102…1f` sequence only.
- After editing: `cd web && bun test src/server` and `make pins-check`.
- After deploying: the served document must agree with the deployment it is
  served from, which no local check can see. Fetch `/skill.md` from the live
  origin and require its `factory:` and `factory deployment block:` header
  values to equal the pin block further down and the tuner's configured env.
  A prose-only edit that slips a pin passes every other check and sends every
  client to the wrong factory.
