# Authentication and Authorization

## Login and Session Lifecycle

1. Public registration creates Student accounts only. Admin creates Teacher accounts and assigns teachers to classes; privileged roles cannot be chosen during registration.
2. Student and Admin keep their existing login URLs. Teachers sign in at `teacher-login.html`, which calls `POST /api/auth/login` and rejects non-Teacher roles.
3. Passwords use bcryptjs with 10 rounds. Successful login issues a 15-minute signed access JWT and a 7-day refresh JWT. The refresh and access tokens are in HttpOnly, SameSite=Strict cookies; the JSON access token remains available for external bearer-token API clients.
4. Each token carries a random session ID. `auth_sessions` stores that ID, its owner, and expiry. Auth middleware verifies the JWT and confirms the server-side session is still active before enforcing role/ownership.
5. When an access token expires, browser code posts the HttpOnly refresh cookie to `POST /api/auth/refresh`. The server validates it, deletes the old session, creates a new session, and rotates both tokens. Refresh failure sends the user back to sign in.
6. Cookie-authenticated writes require the readable `csrf_token` cookie copied into `X-CSRF-Token`. The server uses this double-submit check alongside SameSite cookies. Bearer-token clients do not rely on cookies and need no CSRF header.
7. Logout deletes the server-side session and clears cookies. Password changes revoke other active sessions. Old tokens without session IDs remain accepted only until their existing expiry for compatibility.

## Role Guards

| Role | Allowed operations |
|---|---|
| Admin | Manage students, teachers, classes, enrollments, attendance, reports, and admin credentials |
| Teacher | View assigned classes and enrolled students; mark/view attendance for assigned classes; change own password |
| Student | View/update own profile, change own password, and view own attendance |

Middleware returns 401 when authentication/session validation fails and 403 for role, ownership, assignment, or CSRF violations. A teacher can mark attendance only when the class is assigned to them and the student is enrolled. Admin is required to create or change class enrollments.

`users` is the canonical credential/role table. Startup migrates existing student hashes to linked user rows and syncs the configured Admin from `admin_settings`; existing student IDs/routes remain. The legacy student password hash column is retained for migration compatibility and is never returned.

## Production Configuration and Safeguards

Set `NODE_ENV=production`, a random `JWT_SECRET` of at least 32 characters, a non-default `ADMIN_EMAIL`, an admin password of at least 12 characters, and MySQL credentials in `backend/.env`. Production startup rejects known placeholder/default secrets, requires HTTPS, and refuses explicit SQLite mode. It does not fall back to SQLite if MySQL setup fails. Do not commit `.env`.

Helmet sets security headers and a restrictive content security policy (with Google Fonts allowed for the existing stylesheet). Express JSON bodies are limited to 100 KB. Login routes share a 10-attempt-per-15-minute in-memory rate limit. CORS is disabled unless an exact trusted `CORS_ORIGIN` is configured. Cookie `Secure` is enabled in production and `trust proxy` assumes one trusted TLS-terminating proxy.

The browser stores only the role's display profile in `localStorage`; it does not store access or refresh tokens there. The rate limiter is process-local and should use a shared store in multi-instance deployments. Deploy behind HTTPS and review proxy/CORS configuration before going public.
