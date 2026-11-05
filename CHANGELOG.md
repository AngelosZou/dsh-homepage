# Changelog

## Unrelease

### Changed
- The plugin-audit session is now capability-limited.
- The host fetches audit source from an allowlist into a content-addressed snapshot.
- No verdict installs a plugin automatically.

## [0.1.3] — 2026-11-05

### Changed
- The audit card can customize the prompt and choose model now.

## [0.1.2] — 2026-11-03

### Changed
- In workspace picker UI, the path typed into the field is the folder that gets registered.

### Fixed
- A workspace added from a category's own add control is filed into
  that category.
- A category ordered by recency sorts a workspace without sessions by its creation instant instead of leaving it at the bottom.

## [0.1.1] — 2026-11-02

### Fixed
- Left sidebar use DSH workspace display logic.
- Fix CRLF and BOM related npm test in new environment.

### Added
- Device card display information in Linux and macOS.
