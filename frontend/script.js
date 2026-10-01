const API_URL = "/api";
localStorage.removeItem("studentToken");
localStorage.removeItem("adminToken");

function csrfToken() {
    const value = document.cookie.split("; ").find((entry) => entry.startsWith("csrf_token="));
    return value ? decodeURIComponent(value.slice("csrf_token=".length)) : "";
}

async function readResponse(response) {
    let data;
    try {
        data = await response.json();
    } catch (error) {
        throw new Error("The server returned an invalid response");
    }
    if (!response.ok) {
        const requestError = new Error(data.message || "Request failed");
        requestError.status = response.status;
        throw requestError;
    }
    return data;
}

async function sessionFetch(url, options = {}, allowRefresh = true) {
    const headers = { ...(options.headers || {}) };
    if (!["GET", "HEAD", "OPTIONS"].includes(String(options.method || "GET").toUpperCase())) {
        const token = csrfToken();
        if (token) headers["X-CSRF-Token"] = token;
    }
    const response = await fetch(`${API_URL}${url}`, { ...options, credentials: "same-origin", headers });
    if (response.status === 401 && allowRefresh && csrfToken()) {
        const token = csrfToken();
        const refresh = await fetch(`${API_URL}/auth/refresh`, {
            method: "POST",
            credentials: "same-origin",
            headers: token ? { "X-CSRF-Token": token } : {}
        });
        if (refresh.ok) return sessionFetch(url, options, false);
    }
    return readResponse(response);
}

async function studentFetch(url, options = {}) {
    try {
        return await sessionFetch(url, options);
    } catch (error) {
        if (error.status === 401) {
            localStorage.removeItem("student");
            window.location.href = "login.html";
        }
        throw error;
    }
}

const registerForm = document.getElementById("registerForm");
if (registerForm) {
    registerForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const password = document.getElementById("password").value;
        if (password !== document.getElementById("confirmPassword").value) {
            alert("Passwords do not match!");
            return;
        }

        try {
            const response = await fetch(`${API_URL}/students/register`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json", ...(csrfToken() ? { "X-CSRF-Token": csrfToken() } : {}) },
                body: JSON.stringify({
                    student_id: document.getElementById("student_id").value.trim(),
                    name: document.getElementById("name").value.trim(),
                    email: document.getElementById("email").value.trim(),
                    department: document.getElementById("department").value.trim(),
                    semester: document.getElementById("semester").value,
                    phone: document.getElementById("phone").value.trim(),
                    password
                })
            });
            await readResponse(response);
            alert("Student registered successfully!");
            window.location.href = "login.html";
        } catch (error) {
            alert(error.message || "Registration failed");
        }
    });
}

const loginForm = document.getElementById("loginForm");
if (loginForm) {
    loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
            const response = await fetch(`${API_URL}/students/login`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json", ...(csrfToken() ? { "X-CSRF-Token": csrfToken() } : {}) },
                body: JSON.stringify({
                    email: document.getElementById("loginEmail").value.trim(),
                    password: document.getElementById("loginPassword").value
                })
            });
            const data = await readResponse(response);
            localStorage.setItem("student", JSON.stringify(data.student));
            alert("Login successful!");
            window.location.href = "dashboard.html";
        } catch (error) {
            alert(error.message || "Login failed");
        }
    });
}

const logoutButton = document.getElementById("logoutButton");
if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
        try { await sessionFetch("/auth/logout", { method: "POST" }); } catch (error) { /* local logout still succeeds */ }
        localStorage.removeItem("student");
        window.location.href = "login.html";
    });
}

const adminLoginForm = document.getElementById("adminLoginForm");
if (adminLoginForm) {
    adminLoginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = document.getElementById("adminLoginMessage");
        message.textContent = "";
        try {
            const response = await fetch(`${API_URL}/admin/login`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json", ...(csrfToken() ? { "X-CSRF-Token": csrfToken() } : {}) },
                body: JSON.stringify({
                    email: document.getElementById("adminEmail").value.trim(),
                    password: document.getElementById("adminPassword").value
                })
            });
            const data = await readResponse(response);
            localStorage.setItem("adminEmail", data.admin.email);
            window.location.href = "admin.html";
        } catch (error) {
            message.textContent = error.message;
            message.className = "form-message error-message";
        }
    });
}

const adminDashboard = document.querySelector(".admin-shell");
if (adminDashboard) {
    if (!localStorage.getItem("adminEmail")) {
        window.location.href = "admin-login.html";
    } else {
        let selectedStudent = null;
        const adminError = document.getElementById("adminError");
        const adminSectionLinks = Array.from(document.querySelectorAll(".admin-shell [href^='#']"));
        const adminSections = {
            students: Array.from(document.querySelectorAll(".admin-overview-section")),
            attendance: [document.getElementById("attendance")],
            management: [document.getElementById("management")],
            security: [document.getElementById("security")]
        };
        function showAdminSection(sectionName, updateHistory = true) {
            const visible = new Set(adminSections[sectionName] || adminSections.students);
            Object.values(adminSections).flat().forEach((section) => {
                section.classList.toggle("dashboard-section-hidden", !visible.has(section));
            });
            adminSectionLinks.forEach((link) => {
                link.classList.toggle("active", link.getAttribute("href") === `#${sectionName}`);
            });
            if (updateHistory) window.history.replaceState(null, "", `#${sectionName}`);
        }
        adminSectionLinks.forEach((link) => link.addEventListener("click", (event) => {
            event.preventDefault();
            showAdminSection(link.getAttribute("href").slice(1));
        }));
        window.addEventListener("hashchange", () => {
            showAdminSection(window.location.hash.replace("#", ""), false);
        });
        showAdminSection(window.location.hash.replace("#", "") || "students", false);
        document.getElementById("adminNewEmail").value = localStorage.getItem("adminEmail") || "";
        const adminFetch = async (url, options = {}) => {
            try {
                return await sessionFetch(url, options);
            } catch (error) {
                if (error.status === 401) {
                    localStorage.removeItem("adminEmail");
                    window.location.href = "admin-login.html";
                    throw new Error("Admin session expired");
                }
                throw error;
            }
        };
        const escapeHtml = (value) => String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        const formatDate = (value) => value
            ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })
            : "—";

        function renderDetails(data) {
            selectedStudent = data.student;
            document.getElementById("attendanceStudent").value = String(data.student.id);
            document.getElementById("adminDetailTitle").textContent = data.student.name;
            document.getElementById("adminAttendanceTitle").textContent = `${data.student.name}'s attendance`;
            document.getElementById("adminSelectedName").textContent = data.student.name;
            document.getElementById("adminPresentCount").textContent = data.summary.present;
            document.getElementById("adminRate").textContent = `${data.summary.percentage}%`;
            document.getElementById("adminStudentDetails").innerHTML = `
                <div>Student ID<strong>${escapeHtml(data.student.student_id)}</strong></div>
                <div>Email<strong>${escapeHtml(data.student.email)}</strong></div>
                <div>Department<strong>${escapeHtml(data.student.department)}</strong></div>
                <div>Semester<strong>${escapeHtml(data.student.semester)}</strong></div>
                <div>Phone<strong>${escapeHtml(data.student.phone)}</strong></div>`;
            document.getElementById("adminAttendanceTable").innerHTML = data.records.length
                ? data.records.map((record) => `<tr>
                    <td>${formatDate(record.attendance_date)}</td>
                    <td>${escapeHtml(String(record.attendance_time || "").slice(0, 5))}</td>
                    <td>${escapeHtml(record.period)}</td>
                    <td><span class="status ${record.status.toLowerCase()}">${escapeHtml(record.status)}</span></td>
                    <td>${escapeHtml(record.notes || "—")}</td>
                </tr>`).join("")
                : '<tr><td colspan="5" class="empty-state">No attendance records yet.</td></tr>';
            document.querySelector("#attendanceForm button[type=submit]").disabled = false;
        }

        async function loadStudent(id) {
            try {
                renderDetails(await adminFetch(`/admin/students/${encodeURIComponent(id)}`));
            } catch (error) {
                adminError.textContent = error.message;
            }
        }

        function populateAttendanceStudents(students) {
            const picker = document.getElementById("attendanceStudent");
            picker.innerHTML = '<option value="">Select a student</option>' +
                students.map((student) =>
                    `<option value="${escapeHtml(student.id)}">${escapeHtml(student.student_id)} — ${escapeHtml(student.name)} (${escapeHtml(student.email)})</option>`
                ).join("");
            if (selectedStudent) picker.value = String(selectedStudent.id);
        }

        async function loadClasses() {
            const data = await adminFetch("/classes");
            const enrollmentClassSelect = document.getElementById("enrollmentClassSelect");
            const previousEnrollmentClass = enrollmentClassSelect.value;
            const options = data.classes.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.class_name)} - ${escapeHtml(item.subject)}</option>`).join("");
            document.getElementById("attendanceClass").innerHTML = '<option value="">Select a class</option>' + options;
            enrollmentClassSelect.innerHTML = '<option value="">Select a class</option>' + options;
            if (data.classes.some((item) => String(item.id) === previousEnrollmentClass)) {
                enrollmentClassSelect.value = previousEnrollmentClass;
                await loadEnrollmentRoster();
            }
        }

        async function loadStudents() {
            const search = encodeURIComponent(document.getElementById("studentSearch").value.trim());
            const data = await adminFetch(`/admin/students?search=${search}`);
            document.getElementById("adminStudentCount").textContent = data.total;
            document.getElementById("adminStudentBadge").textContent = `${data.total} student${data.total === 1 ? "" : "s"}`;
            document.getElementById("adminStudentTable").innerHTML = data.students.length
                ? data.students.map((student) => `<tr data-student-id="${escapeHtml(student.id)}">
                    <td>${escapeHtml(student.student_id)}</td>
                    <td>${escapeHtml(student.name)}</td>
                    <td>${escapeHtml(student.email)}</td>
                    <td>${escapeHtml(student.department)}</td>
                    <td><button class="button select-student" data-student-id="${escapeHtml(student.id)}" type="button">View</button></td>
                </tr>`).join("")
                : '<tr><td colspan="5" class="empty-state">No students found.</td></tr>';
            populateAttendanceStudents(data.students);
            document.getElementById("enrollmentStudentSelect").innerHTML = '<option value="">Select a student</option>' +
                data.students.map((student) => `<option value="${escapeHtml(student.id)}">${escapeHtml(student.student_id)} - ${escapeHtml(student.name)}</option>`).join("");
        }

        async function loadTeachers() {
            const data = await adminFetch("/teachers");
            document.getElementById("adminTeacherTable").innerHTML = data.teachers.length
                ? data.teachers.map((teacher) => `<tr><td>${escapeHtml(teacher.name)}</td><td>${escapeHtml(teacher.email)}</td></tr>`).join("")
                : '<tr><td colspan="2" class="empty-state">No teacher accounts yet.</td></tr>';
            document.getElementById("classTeacherSelect").innerHTML = '<option value="">Unassigned</option>' +
                data.teachers.map((teacher) => `<option value="${escapeHtml(teacher.id)}">${escapeHtml(teacher.name)} - ${escapeHtml(teacher.email)}</option>`).join("");
        }

        async function loadEnrollmentRoster() {
            const classId = document.getElementById("enrollmentClassSelect").value;
            const roster = document.getElementById("adminEnrollmentRoster");
            if (!classId) {
                roster.innerHTML = '<tr><td colspan="4" class="empty-state">Select a class to view its roster.</td></tr>';
                return;
            }
            const data = await adminFetch(`/classes/${encodeURIComponent(classId)}/enrollments`);
            roster.innerHTML = data.students.length
                ? data.students.map((student) => `<tr><td>${escapeHtml(student.student_id)}</td><td>${escapeHtml(student.name)}</td><td>${escapeHtml(student.department)}</td><td><button class="button remove-enrollment" data-student-id="${escapeHtml(student.id)}" type="button">Remove</button></td></tr>`).join("")
                : '<tr><td colspan="4" class="empty-state">No students are enrolled in this class.</td></tr>';
        }

        document.getElementById("studentSearchForm").addEventListener("submit", (event) => {
            event.preventDefault();
            loadStudents().catch((error) => { adminError.textContent = error.message; });
        });
        document.getElementById("teacherCreateForm").addEventListener("submit", async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const message = document.getElementById("teacherCreateMessage");
            try {
                const data = await adminFetch("/teachers", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        name: document.getElementById("newTeacherName").value.trim(),
                        email: document.getElementById("newTeacherEmail").value.trim(),
                        password: document.getElementById("newTeacherPassword").value
                    })
                });
                message.textContent = data.message;
                message.className = "form-message success-message";
                form.reset();
                await loadTeachers();
            } catch (error) {
                message.textContent = error.message;
                message.className = "form-message error-message";
            }
        });
        document.getElementById("classCreateForm").addEventListener("submit", async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const message = document.getElementById("classCreateMessage");
            const teacherSelect = document.getElementById("classTeacherSelect");
            try {
                const data = await adminFetch("/classes", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        class_name: document.getElementById("newClassName").value.trim(),
                        subject: document.getElementById("newClassSubject").value.trim(),
                        department: document.getElementById("newClassDepartment").value.trim(),
                        semester: document.getElementById("newClassSemester").value,
                        teacher_name: teacherSelect.value ? teacherSelect.selectedOptions[0].textContent.split(" - ")[0] : "Unassigned",
                        teacher_user_id: teacherSelect.value || null
                    })
                });
                message.textContent = data.message;
                message.className = "form-message success-message";
                form.reset();
                await loadClasses();
            } catch (error) {
                message.textContent = error.message;
                message.className = "form-message error-message";
            }
        });
        document.getElementById("enrollmentClassSelect").addEventListener("change", () => {
            loadEnrollmentRoster().catch((error) => { adminError.textContent = error.message; });
        });
        document.getElementById("enrollmentForm").addEventListener("submit", async (event) => {
            event.preventDefault();
            const message = document.getElementById("enrollmentMessage");
            const classId = document.getElementById("enrollmentClassSelect").value;
            const studentId = document.getElementById("enrollmentStudentSelect").value;
            try {
                const result = await adminFetch(`/classes/${encodeURIComponent(classId)}/enrollments`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ student_id: studentId })
                });
                message.textContent = result.message;
                message.className = "form-message success-message";
                document.getElementById("enrollmentStudentSelect").value = "";
                await loadEnrollmentRoster();
            } catch (error) {
                message.textContent = error.message;
                message.className = "form-message error-message";
            }
        });
        document.getElementById("adminEnrollmentRoster").addEventListener("click", async (event) => {
            const button = event.target.closest(".remove-enrollment");
            if (!button) return;
            const classId = document.getElementById("enrollmentClassSelect").value;
            try {
                await adminFetch(`/classes/${encodeURIComponent(classId)}/enrollments/${encodeURIComponent(button.dataset.studentId)}`, { method: "DELETE" });
                await loadEnrollmentRoster();
            } catch (error) {
                document.getElementById("enrollmentMessage").textContent = error.message;
                document.getElementById("enrollmentMessage").className = "form-message error-message";
            }
        });
        document.getElementById("adminStudentTable").addEventListener("click", (event) => {
            const button = event.target.closest(".select-student");
            if (button) loadStudent(button.dataset.studentId);
        });
        document.getElementById("attendanceStudent").addEventListener("change", (event) => {
            const studentId = event.target.value;
            if (studentId) {
                loadStudent(studentId);
            } else {
                selectedStudent = null;
                document.getElementById("adminAttendanceTitle").textContent = "Select a student first";
                document.querySelector("#attendanceForm button[type=submit]").disabled = true;
                document.getElementById("adminAttendanceTable").innerHTML = '<tr><td colspan="5" class="empty-state">Select a student to load records.</td></tr>';
            }
        });
        document.getElementById("adminLogoutButton").addEventListener("click", async () => {
            try { await adminFetch("/auth/logout", { method: "POST" }); } catch (error) { /* local logout still succeeds */ }
            localStorage.removeItem("adminEmail");
            window.location.href = "admin-login.html";
        });
        document.getElementById("adminAccountForm").addEventListener("submit", async (event) => {
            event.preventDefault();
            const message = document.getElementById("adminAccountMessage");
            const newPassword = document.getElementById("adminNewPassword").value;
            if (newPassword !== document.getElementById("adminConfirmPassword").value) {
                message.textContent = "New passwords do not match.";
                message.className = "form-message error-message";
                return;
            }
            try {
                const data = await adminFetch("/admin/account", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        currentPassword: document.getElementById("adminCurrentPassword").value,
                        email: document.getElementById("adminNewEmail").value.trim(),
                        newPassword
                    })
                });
                const newEmail = document.getElementById("adminNewEmail").value.trim();
                message.textContent = data.message;
                message.className = "form-message success-message";
                document.getElementById("adminAccountForm").reset();
                setTimeout(() => {
                    sessionFetch("/auth/logout", { method: "POST" }).catch(() => {});
                    localStorage.setItem("adminEmail", newEmail);
                    window.location.href = "admin-login.html";
                }, 900);
            } catch (error) {
                message.textContent = error.message;
                message.className = "form-message error-message";
            }
        });
        document.getElementById("attendanceForm").addEventListener("submit", async (event) => {
            event.preventDefault();
            const message = document.getElementById("attendanceMessage");
            if (!selectedStudent) {
                message.textContent = "Select a student first.";
                return;
            }
            try {
                const response = await adminFetch(`/admin/students/${encodeURIComponent(selectedStudent.id)}/attendance`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        class_id: document.getElementById("attendanceClass").value,
                        date: document.getElementById("attendanceDate").value,
                        time: document.getElementById("attendanceTime").value,
                        period: document.getElementById("attendancePeriod").value.trim(),
                        status: document.getElementById("attendanceStatus").value,
                        notes: document.getElementById("attendanceNotes").value.trim()
                    })
                });
                message.textContent = response.message;
                message.className = "form-message success-message";
                renderDetails(await adminFetch(`/admin/students/${encodeURIComponent(selectedStudent.id)}`));
            } catch (error) {
                message.textContent = error.message;
                message.className = "form-message error-message";
            }
        });

        const now = new Date();
        document.getElementById("attendanceDate").value = now.toISOString().slice(0, 10);
        document.getElementById("attendanceTime").value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        document.getElementById("attendanceForm").querySelector("button[type=submit]").disabled = true;
        loadStudents().catch((error) => { adminError.textContent = error.message; });
        loadClasses().catch((error) => { adminError.textContent = error.message; });
        loadTeachers().catch((error) => { adminError.textContent = error.message; });
    }
}

const dashboard = document.querySelector(".dashboard-shell:not(.admin-shell)");
if (dashboard) {
    let student;
    try {
    student = JSON.parse(localStorage.getItem("student") || "null");
    } catch (error) {
    localStorage.removeItem("student");
    student = null;
    }
    if (!student) {
        window.location.href = "login.html";
    } else {
        const sectionLinks = Array.from(document.querySelectorAll("[data-section]"));
        const sections = {
            overview: [document.getElementById("overview"), document.getElementById("attendance")],
            attendance: [document.getElementById("attendance")],
            profile: [document.getElementById("profile")],
            security: [document.getElementById("security")]
        };
        const contentGrid = document.querySelector(".content-grid");
        function showSection(sectionName, updateHistory = true) {
            const visible = new Set(sections[sectionName] || sections.overview);
            document.querySelectorAll(".dashboard-section").forEach((section) => {
                section.classList.toggle("dashboard-section-hidden", !visible.has(section));
            });
            contentGrid.classList.toggle("single-panel", sectionName !== "overview");
            sectionLinks.forEach((link) => link.classList.toggle("active", link.dataset.section === sectionName));
            if (updateHistory) window.history.replaceState(null, "", `#${sectionName}`);
        }
        sectionLinks.forEach((link) => link.addEventListener("click", (event) => {
            event.preventDefault();
            showSection(link.dataset.section);
        }));
        showSection(window.location.hash.replace("#", "") || "overview", false);

        const welcomeMessage = document.getElementById("welcomeMessage");
        const studentAvatar = document.getElementById("studentAvatar");
        const profileName = document.getElementById("profileName");
        const profilePhone = document.getElementById("profilePhone");
        const profileDepartment = document.getElementById("profileDepartment");
        const profileSemester = document.getElementById("profileSemester");
        const escapeHtml = (value) => String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        const refreshIdentity = () => {
            welcomeMessage.textContent = `Welcome back, ${student.name.split(" ")[0]}!`;
            studentAvatar.textContent = student.name.charAt(0).toUpperCase();
        };
        refreshIdentity();
        profileName.value = student.name;
        profilePhone.value = student.phone;
        profileDepartment.value = student.department;
        profileSemester.value = student.semester;

        async function loadAttendance() {
            try {
                const data = await studentFetch(`/students/${student.id}/attendance`);
                document.getElementById("attendancePercentage").textContent = `${data.summary.percentage}%`;
                document.getElementById("presentDays").textContent = data.summary.present;
                document.getElementById("absentDays").textContent = data.summary.absent;
                document.getElementById("totalDays").textContent = data.summary.total;
                document.getElementById("attendanceProgress").style.width = `${data.summary.percentage}%`;
                document.getElementById("attendanceBadge").textContent = data.summary.total ? `${data.summary.percentage}% overall` : "No records";
                document.getElementById("attendanceAdvice").textContent = data.summary.total
                    ? data.summary.percentage >= 75 ? "Great work! You are meeting the recommended attendance target." : "Your attendance is below 75%. Try to attend upcoming classes regularly."
                    : "Attendance records have not been added yet.";
                document.getElementById("attendanceTable").innerHTML = data.records.length
                    ? data.records.map((record) => `<tr><td>${escapeHtml(new Date(`${record.attendance_date}T00:00:00`).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }))}</td><td>${escapeHtml(String(record.attendance_time || "").slice(0, 5) || "—")}</td><td>${escapeHtml(record.period || "General")}</td><td><span class="status ${record.status === "Present" ? "present" : "absent"}">${escapeHtml(record.status)}</span></td></tr>`).join("")
                    : '<tr><td colspan="4" class="empty-state">No attendance records yet.</td></tr>';
            } catch (error) {
                document.getElementById("dashboardError").textContent = error.message;
            }
        }

        document.getElementById("profileForm").addEventListener("submit", async (event) => {
            event.preventDefault();
            const message = document.getElementById("profileMessage");
            try {
                const data = await studentFetch(`/students/${student.id}/profile`, {
                    method: "PUT", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: profileName.value, phone: profilePhone.value, department: profileDepartment.value, semester: profileSemester.value })
                });
                Object.assign(student, data.student);
                localStorage.setItem("student", JSON.stringify(student));
                refreshIdentity();
                message.textContent = "Profile saved successfully.";
                message.className = "form-message success-message";
            } catch (error) {
                message.textContent = error.message;
                message.className = "form-message error-message";
            }
        });

        document.getElementById("passwordForm").addEventListener("submit", async (event) => {
            event.preventDefault();
            const message = document.getElementById("passwordMessage");
            const newPassword = document.getElementById("newPassword").value;
            if (newPassword !== document.getElementById("confirmNewPassword").value) {
                message.textContent = "New passwords do not match.";
                message.className = "form-message error-message";
                return;
            }
            try {
                const data = await studentFetch(`/students/${student.id}/password`, {
                    method: "PUT", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ currentPassword: document.getElementById("currentPassword").value, newPassword })
                });
                message.textContent = data.message;
                message.className = "form-message success-message";
                document.getElementById("passwordForm").reset();
            } catch (error) {
                message.textContent = error.message;
                message.className = "form-message error-message";
            }
        });
        loadAttendance();
    }
}
