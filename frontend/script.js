const API_URL = "http://localhost:5000/api";

async function readResponse(response) {
    let data;
    try {
        data = await response.json();
    } catch (error) {
        throw new Error("The server returned an invalid response");
    }
    if (!response.ok) {
        throw new Error(data.message || "Request failed");
    }
    return data;
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
                headers: { "Content-Type": "application/json" },
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
                headers: { "Content-Type": "application/json" },
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
    logoutButton.addEventListener("click", () => {
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
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: document.getElementById("adminEmail").value.trim(),
                    password: document.getElementById("adminPassword").value
                })
            });
            const data = await readResponse(response);
            localStorage.setItem("adminToken", data.token);
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
    const adminToken = localStorage.getItem("adminToken");
    if (!adminToken) {
        window.location.href = "admin-login.html";
    } else {
        let selectedStudent = null;
        const adminError = document.getElementById("adminError");
        const adminSectionLinks = Array.from(document.querySelectorAll(".admin-shell [href^='#']"));
        const adminSections = {
            students: Array.from(document.querySelectorAll(".admin-overview-section")),
            attendance: [document.getElementById("attendance")],
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
            const response = await fetch(`${API_URL}${url}`, {
                ...options,
                headers: { ...(options.headers || {}), Authorization: `Bearer ${localStorage.getItem("adminToken")}` }
            });
            if (response.status === 401) {
                localStorage.removeItem("adminToken");
                window.location.href = "admin-login.html";
                throw new Error("Admin session expired");
            }
            return readResponse(response);
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
        }

        document.getElementById("studentSearchForm").addEventListener("submit", (event) => {
            event.preventDefault();
            loadStudents().catch((error) => { adminError.textContent = error.message; });
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
            try { await adminFetch("/admin/logout", { method: "POST" }); } catch (error) { /* local logout still succeeds */ }
            localStorage.removeItem("adminToken");
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
                    localStorage.removeItem("adminToken");
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
                const response = await fetch(`${API_URL}/students/${student.id}/attendance`);
                const data = await readResponse(response);
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
                const response = await fetch(`${API_URL}/students/${student.id}/profile`, {
                    method: "PUT", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: profileName.value, phone: profilePhone.value, department: profileDepartment.value, semester: profileSemester.value })
                });
                const data = await readResponse(response);
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
                const response = await fetch(`${API_URL}/students/${student.id}/password`, {
                    method: "PUT", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ currentPassword: document.getElementById("currentPassword").value, newPassword })
                });
                const data = await readResponse(response);
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
