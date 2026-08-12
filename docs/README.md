# Documentation

Documents have distinct roles. Product, architecture, specification, and decision files describe the
current contract. `testing/` records support and acceptance status plus dated evidence. `archive/` is
historical context and is never normative.

## Current product and engineering contracts

- [`../README.md`](../README.md) / [`../README.zh-CN.md`](../README.zh-CN.md): supported product surface, configuration, and entry points.
- [`architecture.md`](architecture.md): current ownership, component boundaries, data flow, and OpenClaw assumptions.
- [`implementation-spec.md`](implementation-spec.md): current behavioral, security, and acceptance requirements.
- [`v1-completion.md`](v1-completion.md): compatibility pointer for the superseded launch checklist.

## Binding decisions

- [`decisions/engineering-decisions.md`](decisions/engineering-decisions.md): stack, storage, Gateway, proxy, image-privacy, versioning, and operations decisions.
- [`decisions/slash-commands.md`](decisions/slash-commands.md): structured command boundary and allowlist.
- [`decisions/panel-memory.md`](decisions/panel-memory.md): memory reading, disposition, reviewed consolidation, and recovery.
- [`decisions/ux-features.md`](decisions/ux-features.md): settings ownership, themes, navigation, avatars, and notifications.

## Operations and quality

- [`operations/deployment-and-backup.md`](operations/deployment-and-backup.md): deployment, proxy, backup, restore, and explicit integration procedures.
- [`coverage.md`](coverage.md): executable Node 22 coverage scope, thresholds, exclusions, and known boundaries.

## Support and acceptance

[`testing/README.md`](testing/README.md) is the current support/acceptance matrix and routes to the
relevant procedure or dated evidence. Individual files under `testing/` do not establish timeless
support on their own.

## Development archive

[`archive/`](archive/) preserves historical reviews, experiments, and project context. These files may
explain how a decision evolved, but current work must not treat them as implementation instructions.
