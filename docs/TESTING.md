# Testing

## Automated API Results

Run `npm --prefix backend test` from the project root (or `npm test` inside `backend`). Tests use a temporary SQLite database and do not modify the configured developer database.

Latest run: **1 integration test passed, 0 failed**.

| Scenario | Expected | Result |
|---|---|---|
| Migrate legacy SQLite data and retain student login/attendance | Existing account and record remain usable | Passed |
| Invalid/valid/duplicate student registration | 400 / 201 / 409 | Passed |
| Wrong/valid student login and password redaction | 401 / 200; no hash returned | Passed |
| HttpOnly access/refresh cookies and readable CSRF cookie | Correct cookie attributes | Passed |
| Refresh without CSRF token | 403 | Passed |
| Refresh rotation and old-session rejection | New token works; old token gets 401 | Passed |
| Missing token and Student access to staff routes | 401 / 403 | Passed |
| Admin login and Teacher account creation/login | 200 / 201 / 200 | Passed |
| Admin class creation and student enrollment | 201; duplicate enrollment 409 | Passed |
| Teacher roster and assigned-class filtering | Only assigned class/students visible | Passed |
| Attendance for a student not enrolled in the class | 409 | Passed |
| Invalid attendance and duplicate daily record | 400 / 409 | Passed |
| Teacher attendance time, period, and notes round-trip | Returned by attendance history | Passed |
| Teacher password update | Current session remains; other session gets 401 | Passed |
| Teacher marks an unassigned class | 403 | Passed |
| Logout revokes active session | Subsequent protected request gets 401 | Passed |

## Browser Smoke Results

Tested using an isolated SQLite database and local server on an alternate port:

- Registered and signed in a student, then opened the Admin portal.
- Registration succeeded with an existing browser session cookie after the form added its CSRF header.
- Admin created a Teacher account and assigned class, enrolled the student, and saw the roster update.
- Teacher signed in, saw only their class and enrolled student, marked attendance, and saw the Present status in roster/history.
- Desktop viewport: 1280 px wide; page content stayed within the viewport.
- Mobile viewport: 390 px wide; document measured 375 px, with no horizontal overflow.

The final API test separately confirms that teacher-submitted time, period, and notes are stored and returned. The first browser pass exposed and led to fixes for async form reset behavior and attendance metadata being discarded.

## Remaining Validation

- MySQL startup/migration and HTTPS behavior have not been run in this environment.
- Registration negative cases are covered by API tests; browser-native invalid-field styling has not been manually exercised.
- This is an engineering smoke test, not a user study. No real user feedback was collected; request feedback from students, teachers, and administrators before treating usability observations as user research.
- Before deployment, verify trusted proxy/CORS settings, production secret requirements, and HTTPS-only cookies in the target environment.
