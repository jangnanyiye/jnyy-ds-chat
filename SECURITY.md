# Security Policy

## Threat model

DS Chat is a single-user application. It is not designed for multi-tenant use,
untrusted user registration, or exposing the API to third-party clients.

The deployment assumes:

- the server and `/etc/ds-chat.env` are trusted
- the public entry point is HTTPS
- the operator uses a strong, unique access password
- the DeepSeek API key is only available server-side

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability.

Report it privately to the repository maintainer, including:

- affected version / commit
- reproduction steps
- impact assessment
- whether the issue requires an authenticated session

Do not include real API keys, passwords, session cookies, or user conversation
data in reports.

## Deployment checklist

- [ ] `PUBLIC_ORIGIN` exactly matches the public HTTPS origin
- [ ] `COOKIE_SECURE=true` in production
- [ ] `APP_PASSWORD_HASH` generated from a random password of 16+ characters
- [ ] `SESSION_SECRET` is at least 32 random characters
- [ ] `/etc/ds-chat.env` is `640 root:dschat`
- [ ] `DEEPSEEK_API_KEY` is not committed to the repository
- [ ] nginx only exposes 443, application port is bound to `127.0.0.1`
- [ ] `/var/lib/ds-chat` is writable only by the service user
- [ ] backups are stored outside the repository and protected

## Secrets in this repository

This repository must not contain real credentials. The test suite uses
obviously fake values such as `test-key-not-real` and a randomly generated
fixture password; these are not valid for any deployment.

Before publishing a fork or release, scan for:

```bash
grep -RInE 'sk-[A-Za-z0-9_-]{20,}|BEGIN (RSA|OPENSSH|EC|PRIVATE) KEY|APP_PASSWORD_HASH=scrypt|SESSION_SECRET=[0-9a-f]{32,}' .
```
