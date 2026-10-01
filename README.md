# Student Attendance System

A small college attendance app using a static HTML/CSS/JavaScript frontend, Express REST API, bcrypt password hashing, JWT authentication, and MySQL with an SQLite development fallback. Student and admin flows remain available, with a teacher portal and class enrollment workflow.

## Project Structure

```text
Student-Attendance-System/
|-- backend/
|   |-- .env.example
|   |-- database/database.sql
|   |-- server.js
|   |-- test/api.test.js
|   `-- package.json
|-- docs/
|   |-- API.md
|   |-- AUTHENTICATION.md
|   |-- DATABASE-SCHEMA.md
|   |-- ER-DIAGRAM.md
|   `-- TESTING.md
|-- frontend/
|   |-- admin-login.html
|   |-- admin.html
|   |-- dashboard.html
|   |-- index.html
|   |-- login.html
|   |-- teacher-login.html
|   |-- teacher.html
|   |-- teacher.js
|   |-- script.js
|   `-- style.css
`-- package.json
```

## Install and Run

From this project directory:

```powershell
npm run install:backend
npm start
```

The app serves the frontend and API at `http://localhost:5000`. Copy `backend/.env.example` to `backend/.env` to configure MySQL/JWT/admin credentials. In development, if MySQL is unavailable, the server uses `backend/database/student_attendance.db` (SQLite). Production mode requires MySQL and fails closed if it is unavailable. Startup creates/migrates identity, session, class, enrollment, student, and attendance tables and links existing student password hashes to user accounts.

For a fresh MySQL database, run `SOURCE backend/database/database.sql;`. The API can also create the database when the configured MySQL account has permission.

## Accounts and Roles

- Public registration creates a Student account.
- Admin signs in at `frontend/admin-login.html`; defaults are `admin@example.com` / `admin123` for local development only. Change these before production.
- Admin creates Teacher accounts, classes, and enrollments in the **Classes and roster** section.
- Teachers sign in at `frontend/teacher-login.html`, see assigned class rosters, mark attendance, view daily history, and change their password.
- Admin manages records; Teachers manage attendance for assigned classes and enrolled students; Students see only their own profile and attendance.

Browser sessions use HttpOnly access/refresh cookies, CSRF validation, refresh rotation, and server-side revocation. External API clients may use the returned access JWT as `Authorization: Bearer <JWT>`. See [authentication documentation](docs/AUTHENTICATION.md) for production setup and proxy notes.

## Test

```powershell
npm --prefix backend test
```

Tests run against a temporary SQLite database, including sessions, enrollments, and role authorization. Manual browser and MySQL checks are listed separately in [testing documentation](docs/TESTING.md).

## Documentation

- [ER diagram](docs/ER-DIAGRAM.md)
- [Relational schema and constraints](docs/DATABASE-SCHEMA.md)
- [REST API requests, responses, and status codes](docs/API.md)
- [Authentication and authorization flow](docs/AUTHENTICATION.md)
- [Automated results and manual checklist](docs/TESTING.md)

Next-stage candidates: add attendance export/report filters, a shared rate-limit store for multi-instance deployments, and automated MySQL migration tests.
