# Security policy

## Scope

A Lyre model is untrusted input: containers are shared between users and loaded by many
independent runtimes. Section 16 of the [specification](./spec/lyre.md) defines the normative
resource and container-safety ceilings, and the reference implementation in this repository is
expected to enforce them. The following are security bugs, not ordinary defects:

- A model that makes a reference package crash, hang, or allocate without bound instead of being
  rejected before the corresponding work (§16 model and operational ceilings).
- A container path, ZIP entry, or symlink that reads or writes outside the container root, or
  that bypasses the entry-count, path-length, or inflation bounds.
- A PNG or JSON document that bypasses the pre-inflation structural checks of §3.2 and §2.
- The browser testbed's development server serving files outside the directories it is
  documented to serve.
- A specification rule whose literal implementation is unsafe, even if the reference
  implementation happens to avoid the problem.

Ordinary rendering differences, validator false positives, and conformance-tolerance questions are
regular issues.

## Reporting

Report suspected vulnerabilities privately through GitHub's private vulnerability reporting for
this repository (the **Security** tab, then **Report a vulnerability**). Do not open a public
issue or pull request for an exploitable problem.

Include a minimal reproducing container (an unpacked `*.lyre/` directory or a `.lyre` archive)
and the command or API call that triggers the behavior. Reports are acknowledged as soon as they
are read and fixed in the next patch release of the affected packages; a fix that changes
normative behavior is also recorded in the specification.

## Supported versions

Only the most recent published version of each `@refrain-lyre` package and the current
specification version receive fixes.
