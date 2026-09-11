# Student Attendance System

## Run the backend

```powershell
cd backend
npm install
node server.js
```

The server uses MySQL when it is available and otherwise falls back to
`backend/database/student_attendance.db` (SQLite). Configure MySQL with
`DB_HOST`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`.

## Admin access

Open `frontend/admin-login.html`. The built-in admin account is configured
with environment variables:

* `ADMIN_EMAIL` (default: `admin@example.com`)
* `ADMIN_PASSWORD` (default: `admin123`)

Set both values in the environment before starting the server in production.
After logging in, the admin token is kept in browser local storage and is
required by the admin student and attendance endpoints.
