# Perch development

For native chat UI work, start with [.agents/skills/react-native/SKILL.md](.agents/skills/react-native/SKILL.md). Use [.agents/skills/assistant-ui/SKILL.md](.agents/skills/assistant-ui/SKILL.md) to find the focused guide for another assistant-ui concern.

Check examples against the versions in `package.json` and the installed native package exports. The upstream skills also cover newer web APIs and optional integrations; select the React Native equivalents for this app.

For runtime or harness changes, read [docs/DESIGN.md](docs/DESIGN.md) and [src/session/README.md](src/session/README.md). Perch projects host-owned state through its existing external-store runtime and harness adapters.

For artifact rendering or export changes, read [docs/ARTIFACTS.md](docs/ARTIFACTS.md). Its native rendering and HTML isolation boundaries apply when adapting the Markdown or generative UI guides.

For development tools, skill provenance, and device workflows, read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Observed verification and remaining device checks are recorded in [docs/VERIFICATION.md](docs/VERIFICATION.md).
