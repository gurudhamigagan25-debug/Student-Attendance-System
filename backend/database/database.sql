CREATE DATABASE IF NOT EXISTS student_attendance;

USE student_attendance;

CREATE TABLE IF NOT EXISTS students (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    department VARCHAR(50) NOT NULL,
    semester INT NOT NULL,
    phone VARCHAR(20) NOT NULL,
    password VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    attendance_date DATE NOT NULL,
    attendance_time TIME NOT NULL DEFAULT '00:00:00',
    period VARCHAR(50) NOT NULL DEFAULT 'General',
    status ENUM('Present', 'Absent') NOT NULL,
    notes TEXT NULL,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    UNIQUE KEY attendance_student_slot (student_id, attendance_date, attendance_time, period)
);