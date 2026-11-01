# Contributing to dsh-homepage

Contributions are welcome from people and from agents alike: issues and pull requests opened
by either are reviewed the same way.

## What to send where

- **Open a pull request directly** for UI polish, bug fixes and support for more systems.
  Small, focused changes are the easiest to accept.
- **Open an issue first** for a change to the framework or its interfaces, or for a new
  built-in card. Those touch the contract every other card depends on, so the design is
  agreed before code is written — a pull request that skips that step may not be merged.

## How this repository is shaped

- **One file per card.** A card lives in `lib/cards/<id>.js` and registers itself; dropping
  the file in is the whole step, and the build picks it up.
- **The client half is generated.** `lib/client.js` is built from `lib/framework.part.js`
  plus `lib/cards/*` by `npm run build`. Never edit it by hand, and `npm run check:build`
  fails when it is stale.
- **Everything is bilingual.** `README.md` and `README.zh.md` describe the same thing, and a
  card's `dict({ zh, en })` halves must carry the identical key set.
- **The card interface is documented.** `docs/card-api.md` is the contract other plugins code
  against; a field, control or endpoint change updates it in the same pull request.
- **Host and client are validated together.** `test/validate-manifest.mjs` compares every
  `remoteInvocation` declaration with the client's call sites, so an endpoint has to land on
  both sides at once.
- **Sources stay clean by machine.** `node scripts/_check-hygiene.mjs` rejects a UTF-8 BOM
  and mojibake markers; the tree is LF, two-space indent, no tabs.

## Before you open the pull request

- `npm test` and `npm run check:build` pass.
- New behavior has tests.
- The diff stays focused; an unrelated refactor belongs in its own pull request.

## License

By contributing you agree that your contribution is licensed under the MIT license in
[LICENSE](LICENSE).
