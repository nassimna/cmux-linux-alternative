# Governance

## Roles

- Maintainers set release policy, merge reviewed changes, and steward security response.
- Reviewers provide technical review in areas where they have demonstrated experience.
- Contributors participate through issues, discussions, RFCs, code, design, testing, and docs.

The repository owner acts as the initial maintainer until named maintainers are published. New
maintainers are added by consensus of existing maintainers based on sustained, constructive work.

## Decisions

Routine changes are accepted through pull-request review. Protocol, persistence,
security-boundary, plugin, and major UI architecture changes require an RFC. Durable technical
decisions are recorded under `docs/decisions/`.

Maintainers seek consensus. If consensus cannot be reached, a maintainer documents the alternatives,
trade-offs, and final decision. Security response may be private until coordinated disclosure.

## Releases

Releases require passing protected CI, an reviewed changelog, reproducible artifacts, checksums, and
maintainer approval. Semantic versioning becomes binding at version 1.0.

## Changes to governance

Governance changes require a public pull request and approval from two maintainers once the project
has at least two maintainers.
