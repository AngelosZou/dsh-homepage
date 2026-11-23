# Changelog

## [0.1.11] — 2026-11-23

### Fixed
- Adapt to DSH 0.2.3.

## [0.1.10] — 2026-11-23

### Added
- The home-page header checks the npm release of the plugin once a day and turns
  into a new-version pill when the published copy has moved ahead.

## [0.1.9] — 2026-11-19

### Fixed
- Workspace delete work as expected.

## [0.1.8] — 2026-11-14

### Added
- Left sidebar carries the DSH-native actions in the shipped order.

### Fixed
- Renaming a session from the sidebar reaches the session again.

## [0.1.7] — 2026-11-10

### Changed
- The DSH core card performs better.

## [0.1.6] — 2026-11-06

### Changed
- DSH core card work for desktop app.

## [0.1.5] — 2026-11-06

### Changed
- The plugin performs no background work.
- Device readings work like a performance panel.
- A hidden card is disabled.

## [0.1.4] — 2026-11-05

### Changed
- The plugin-audit session is now capability-limited.
- The host fetches audit source from an allowlist into a content-addressed snapshot.
- No verdict installs a plugin automatically.
- The plugin-audit card no longer offers separate review/install modes.

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
