# Preview release decisions for owner review

No identity or license change has been applied. No npm package or Marketplace publisher has been created, reserved, transferred, or published.

## Current metadata

| Surface | Current value | Review |
| --- | --- | --- |
| npm package / VS Code extension slug | `fast-lane-app-server-poc` | Development placeholder; replace only after owner approval |
| VS Code display name | `Vesper` | Marketplace already has a `Vesper` extension; choose a distinct display name |
| Marketplace publisher | `local-experiment` | Placeholder; owner must provide an ID they control |
| CLI executable | `vesper` | Keep unchanged for compatibility |
| VS Code command ID | `fastLane.openPanel` | Keep unchanged to preserve command activation |
| VS Code webview ID | `fastLanePanel` | Keep unchanged to preserve panel behavior |
| Version | `0.1.0` | Current local preview version; no registry release |
| License metadata | absent | Owner decision required; no `LICENSE` file exists and `vsce` warns |

## Candidate identities

The following candidates returned no exact npm registry entry or Marketplace search result when checked on 2026-10-28. That is not a reservation or proof of availability. Recheck both registries after approval and immediately before any publication attempt.

1. `vesper-coding-agent` / **Vesper Coding Agent** (recommended)
2. `vesper-dev-preview` / **Vesper Developer Preview**

The existing npm names `vesper` and `vesper-cli` were occupied at check time. Marketplace display names and extension names must be unique. The final extension ID will be `<owner-controlled-publisher>.<approved-slug>`.

## Owner decisions

- Approved npm package and VS Code extension slug:
- Approved Marketplace display name:
- Marketplace publisher ID controlled by the owner:
- Approved license identifier and corresponding license text/file:
- Approval date / owner:

Do not publish, reserve, transfer, or create the Marketplace publisher as part of this review. A name search is not an ownership claim.

## Migration impact

If the slug changes, remove the local global CLI install using `npm uninstall --global fast-lane-app-server-poc`, then install the new package or checkout. The `vesper` executable, `VESPER_HOME`, and project data remain unchanged. If the extension slug or publisher changes, uninstall `local-experiment.fast-lane-app-server-poc` and install the new VSIX; the command ID stays `fastLane.openPanel`. The detailed steps are in `INSTALL.md`.

## Current distribution status

Artifacts built before these owner decisions are internal review candidates only. The repository does not declare a license. Do not send the current package to external testers until the owner approves the identity and license and the artifacts are rebuilt from those approved values.
