# Security

## Reporting a vulnerability

Please report privately through GitHub's
[security advisories](https://github.com/nook-space/gadgetCLI/security/advisories/new)
rather than a public issue. Include what you did, what happened, and what you expected.

## What this tool handles

- **Session tokens.** `gadget login` stores a per-instance session token in
  `~/.config/gadget/config.json` (directory `0700`, file `0600`). Clear it with
  `gadget logout`. The upstream instance has no token-revocation API today, so clearing it
  locally stops this machine from using the session but does not invalidate it server-side.
- **Passwords.** Hashed client-side with argon2id before they leave the process; the
  instance never receives a password. A password is never written to disk.
- **Cloudflare Access.** Tokens come from `cloudflared` per command and are never stored;
  an Access profile keeps no secret at all.
- **Third-party credentials.** None. Connections to GitHub, Slack and the like are created
  and held by the instance; the CLI can request them but never sees or stores them.

## Untrusted input

`gadget new --from <url>` downloads a blueprint archive from any instance, unauthenticated
by design. Archives are treated as hostile: size and metadata caps, a decompression bound,
UTF-8 and path validation on every file name, refusal of names containing control
characters, and no writes through symlinks. Report anything that gets past that.
