---
"@omniforge/mission-control": minor
---

Add an npm update pill in the header next to the Mission Control title. It compares the installed version against the npm registry latest and renders only when behind. Clicking Update offers two modes: update now (stops active work, installs, and restarts) or update when idle (installs and restarts on the next idle transition). A detached updater performs the global install and re-launches the server, with a safe degrade so a failed install never leaves the app dead.
