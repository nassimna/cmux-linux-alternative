# Project action configuration foundation

`agent-workspace-config` owns the persisted policy and strict untrusted-manifest parser for
`actions-v1`. This is a configuration foundation only: it does not discover manifests, register
actions, grant trust, or execute processes.

## Application-owned policy

The existing `config.json` schema remains version 2 and gains a defaulted `actions` section:

```json
{
  "schemaVersion": 2,
  "actions": {
    "approvedExecutables": ["cargo", "node"],
    "trustedProjects": [
      {
        "canonicalRoot": "/home/example/project",
        "manifestSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "trustedAtUnixMs": 1721600000000
      }
    ]
  }
}
```

This is additive without a schema-version bump because a schema-v2 reader predating `actions`
captures unknown top-level objects and writes them back unchanged. The selected field names also
pass that reader's extension-key screen: none contains `token`, `secret`, or `command`. A retained
compatibility test deserializes, validates, rewrites, and rereads this exact shape through a modeled
legacy reader.

Only application-owned, trusted UI may add executable approvals or trust records. A trust record
binds one filesystem-canonical project root to the lowercase SHA-256 of the exact manifest bytes and
the grant timestamp. The section accepts at most 64 unique portable executable names and 256 unique
project roots. Project files have no field that can add either kind of approval.

## Strict manifest v1

Untrusted JSON must be passed to `ProjectActionManifest::parse_json`; direct deserialization is not
the validation boundary. A minimal manifest is:

```json
{
  "schemaVersion": 1,
  "actions": [
    {
      "id": "project.example.build",
      "title": "Build project",
      "executable": { "kind": "projectRelativePath", "path": "scripts/build" },
      "args": ["--release"],
      "workingDirectory": { "kind": "projectRoot" },
      "shortcut": "Primary+Shift+B",
      "environment": ["PATH", "LANG"]
    }
  ]
}
```

The other closed choices are:

- `executable: { "kind": "approvedName", "name": "cargo" }`, requiring an exact match in
  application configuration.
- `workingDirectory: { "kind": "projectRelativePath", "path": "packages/app" }`.

Manifest v1 rejects unknown fields, duplicate IDs, explicit `null`, shell/template/confirmation
fields, path traversal, unapproved bare names, noncanonical shortcuts, duplicate or sensitive
environment names, and controls in user-visible or argv text. It permits at most 64 actions; each
encoded definition is at most 16 KiB; title length is at most 120 Unicode scalars; argv contains at
most 64 literal elements of at most 1,024 scalars each; and environment requests contain at most 32
uppercase portable names. `args` and `environment` may be omitted to mean empty. `shortcut` may be
omitted, but explicit `null` is rejected.

Relative paths use `/`, contain only nonempty segments, and reject absolute roots, `.`, `..`, empty
segments, backslashes, colons, controls, and trailing separators. This is intentionally lexical
validation, not a filesystem authorization decision.

## Required executor integration

Before this foundation can execute anything, the service-owned executor must:

1. locate a manifest beneath an authorized project and hash its exact bytes;
2. filesystem-canonicalize the project root, executable, working directory, and declared file
   arguments immediately before each spawn, rejecting symlink escape and special files;
3. require a current exact `(canonical root, manifest SHA-256)` application trust record;
4. resolve approved bare names through a fixed service policy, never project `PATH` content;
5. build a minimal environment and pass only requested names allowed by the service's value policy;
6. use direct argv spawn with `shell = false`, closed stdin, bounded/redacted output, timeout,
   cancellation, and process-tree containment; and
7. obtain invocation-bound trusted Electron confirmation every time as required by ADR 0009.

Discovery, protocol DTOs, registry conflicts, confirmation state, execution, audit, and desktop/CLI
surfaces intentionally remain open integration seams owned by their respective M4 components.
