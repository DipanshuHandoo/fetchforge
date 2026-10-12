# Security Policy

## Supported versions

Security fixes are released for the latest major version.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting on the repository
(Security tab → "Report a vulnerability"). Include affected versions, a reproduction and the impact.
You can expect an acknowledgement within a few days and a coordinated disclosure once a fix is released.

## Notes for users

- fetchforge does not log request headers, bodies or tokens. Hooks you register receive full request objects; avoid logging `Authorization` values.
- Error objects include the request URL. Do not put secrets in query strings.
- `bearerAuth` only sets a header when none is already present.
