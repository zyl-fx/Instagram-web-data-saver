# Changelog

All notable changes to this project are documented here.

## [1.0.1] - 2026-10-26

### Fixed
- The quality menu could grow to dozens of entries because Instagram serves many odd sizes (1188p, 970p, 888p ...). Sizes are now grouped into standard tiers (1080p, 720p, 540p, 480p, 360p, 240p), and tiers saved by version 1.0.0 are cleaned up automatically.
- The widget panel could run off the bottom of the screen. It now fits the window, and only the quality list scrolls, so the Auto-load switch is always reachable.

## [1.0.0] - 2026-10-18

First public release.

### Added
- Video quality switcher: Auto, Best, Worst, and resolution caps built from the resolutions Instagram actually serves.
- Auto-load videos switch. When off, videos wait behind a **Load video** button (feed, Reels, Stories).
- **Load N held videos** button as a fallback for videos that are waiting.
- Hover widget in the top-right corner. Settings are kept between sessions and synced across tabs.
- Debug logging with `localStorage.setItem('igds:debug', '1')`.
