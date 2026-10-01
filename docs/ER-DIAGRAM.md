# Entity Relationship Diagram

```mermaid
erDiagram
    USERS ||--o| STUDENTS : "has student profile"
    USERS ||--o{ CLASSES : teaches
    USERS ||--o{ AUTH_SESSIONS : authenticates
    STUDENTS ||--o{ ENROLLMENTS : joins
    CLASSES ||--o{ ENROLLMENTS : includes
    STUDENTS ||--o{ ATTENDANCE : receives
    CLASSES o|--o{ ATTENDANCE : records

    USERS {
        int id PK
        varchar name
        varchar email UK
        varchar password_hash
        enum role
        timestamp created_at
    }
    AUTH_SESSIONS {
        char session_id PK
        int user_id FK
        datetime expires_at
        timestamp created_at
    }
    STUDENTS {
        int id PK
        int user_id FK_UK
        varchar student_id UK
        varchar name
        varchar email UK
        varchar department
        int semester
        varchar phone
        varchar password_legacy
        timestamp created_at
    }
    CLASSES {
        int id PK
        varchar class_name
        varchar subject
        varchar department
        int semester
        int teacher_user_id FK
        varchar teacher_name_legacy
        timestamp created_at
    }
    ENROLLMENTS {
        int id PK
        int student_id FK
        int class_id FK
        timestamp enrolled_at
    }
    ATTENDANCE {
        int id PK
        int student_id FK
        int class_id FK
        date attendance_date
        time attendance_time
        varchar period
        enum status
        text notes
        timestamp created_at
    }
```

`users` stores the canonical login, bcrypt hash, and role. Each student profile is linked to one user account. `enrollments` joins students to classes and has a unique student/class pair. A teacher can be assigned to many classes; class attendance belongs to one student and optionally one class so historic records without a class remain valid. Attendance is unique per student/class/date, and its time/period slot is also unique. `auth_sessions` stores revocable, expiring login sessions. Deleting a student removes enrollments and attendance; deleting a class removes its enrollments and clears its optional attendance link; deleting a teacher leaves classes unassigned.
