# Contributing

Thanks for helping improve Instagram Web Data Saver. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an [issue](https://github.com/zyl-fx/Instagram-web-data-saver/issues) and include:

- Your browser and version
- Your userscript manager and version (Tampermonkey, Violentmonkey, ...)
- Where it happened (feed, Reels, Stories, a profile) and what you expected
- The **Seen:** line from the widget
- Debug output: run `localStorage.setItem('igds:debug', '1')` in the console, reload, repeat the problem, and paste the `[IGDS]` lines

## Suggesting a feature

Open an issue describing the problem you want solved before writing code, so we can agree on the approach.

## Pull requests

1. Fork the repository and create a branch.
2. Make your change in `Instagram-Web-Data-Saver.user.js`.
3. Test it on instagram.com in at least Chrome or Firefox: feed, Reels and Stories, with Auto-load both on and off.
4. Update `CHANGELOG.md` and bump `@version` in the script header.
5. Open a pull request that explains what changed and why.

## Ground rules

- Keep it a single file with no dependencies.
- The script must not make network requests of its own or collect any data.
- With quality set to **Auto** and **Auto-load videos** on, the script must not change how Instagram behaves.
- Prefer small, readable changes over clever ones.
