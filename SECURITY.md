# Security policy

## How this app handles your data

This game has no backend and no server component. It runs entirely in
your browser:

- **No telemetry.** The app makes no analytics or tracking calls. The
  only network requests it makes are to the AI provider you configure
  (see below) and the font CDN used by the page.
- **API keys (BYOK).** AI seats use your own provider API keys. A key is
  stored only in your browser: in the `aaa.byok.<provider>` localStorage
  slot if you choose "remember" for that seat, otherwise in page memory
  for the session only. Keys are sent directly from your browser to the
  provider you picked (Anthropic, OpenAI, or Meta). They are never sent
  anywhere else and never logged.
- **Clearing keys.** Clear the site's data in your browser settings, or
  use the seat error card in an AI game to replace or remove a key.
- **Game saves** are JSON files you export and import yourself. Nothing
  is uploaded.

## Reporting a vulnerability

Please report security issues through GitHub's private vulnerability
reporting for this repository (Security tab, "Report a vulnerability")
if it is enabled. Otherwise, open a regular issue describing the general
problem without exploit details, and the maintainer will follow up.

Please do not post working exploits, real API keys, or other users' data
in public issues.
