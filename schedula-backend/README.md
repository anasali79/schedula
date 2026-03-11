# Schedula Backend Documentation

Welcome to the **Schedula Backend** repository! Schedula is a comprehensive booking and scheduling application for doctors and patients. This backend provides a robust REST API for managing users, doctor/patient profiles, and complex scheduling functionalities using the **STREAM** and **WAVE** availability systems.

---

## 🚀 Tech Stack

- **Framework**: [NestJS](https://nestjs.com/) (Node.js)
- **Database**: PostgreSQL
- **ORM**: [Prisma](https://www.prisma.io/)
- **Authentication**: JWT (JSON Web Tokens), Passport, Google OAuth
- **Language**: TypeScript

---

## 🛠️ Setup & Installation

1. **Install dependencies**:
```bash
cd schedula-backend
npm install
```

2. **Environment Variables**:
Create a `.env` file in the root directory and add your environment variables (Database URL, JWT Secrets, Google Client ID/Secret, etc.).

3. **Database Migration**:
```bash
npx prisma generate
npx prisma db push
```

4. **Start the server**:
```bash
# Development mode
npm run start:dev

# Production mode
npm run build
npm run start:prod
```

Server runs on `http://localhost:3000` by default.

---

## 📚 API Reference

### 🔐 Authentication (`/auth`)

#### 1. Signup (Local Registration)
- **POST** `/auth/signup`
- **Body**:
  ```json
  {
    "email": "user@example.com",
    "password": "Password123!"
  }
  ```

#### 2. Signin
- **POST** `/auth/signin`
- **Body**:
  ```json
  {
    "email": "user@example.com",
    "password": "Password123!"
  }
  ```

#### 3. Onboard Patient/Doctor
- **POST** `/auth/onboard/patient` | `/auth/onboard/doctor`
- **Body**: `{ "firstName": "John", "lastName": "Doe" }`

---

### 👨‍⚕️ Doctor Availability (`/api/v1/doctors`)

#### 1. Get Doctor Availability (Public/Patient)
- **GET** `/api/v1/doctors/:doctorId/availability`
- **Query**: `?targetDate=2026-03-16` (Optional)
- **Features**: Includes `formattedDate`, localized day names, and full slot mappings with accurate dates.

#### 2. Set Availability (Doctor)
- **PUT** `/api/v1/doctors/availability` (Weekly)
- **PUT** `/api/v1/doctors/availability/:day` (Daily)
- **PUT** `/api/v1/doctors/custom-availability/:date` (Single Date Override)

---

### 📋 Appointment Management (`/api/v1/appointments`)

#### 1. Book Appointment
- **POST** `/api/v1/appointments/book`
- **Body**:
  ```json
  {
    "slotId": "uuid",
    "appointmentDate": "2026-03-16",
    "notes": "Consultation"
  }
  ```
- **New Feature**: **Dynamic Reporting Time** for WAVE scheduling. 
  - *Formula*: `SlotStartTime + (Token-1) * (SlotDuration / MaxAppt)`.
  - Patients get a specific time (e.g., 9:03 AM) instead of just the slot start time.

#### 2. My Appointment History (Dashboard)
- **GET** `/api/v1/appointments/me`
- **Response Structure**:
  ```json
  {
    "summary": {
      "total": 10,
      "upcoming": 2,
      "rescheduled": 1,
      "completed": 5,
      "cancelled": 2
    },
    "history": {
      "upcoming": [...],
      "rescheduled": [...],
      "completed": [...],
      "cancelled": [...]
    }
  }
  ```

#### 3. Cancel Appointment (Both Sides)
- **PATCH** `/api/v1/appointments/:id/cancel`
- **Access**: Both Patients and Doctors can cancel.
- **Action**: Updates status and sends email notifications to both parties.

#### 4. Reschedule Appointment (Both Sides)
- **PATCH** `/api/v1/appointments/:id/reschedule`
- **Access**: Both Patients and Doctors.
- **Body**:
  ```json
  {
    "slotId": "new-slot-uuid",
    "appointmentDate": "2026-03-23"
  }
  ```
- **Action**: Moves appointment to a new slot, updates token, calculates new reporting time, and sends confirmation emails.

#### 5. Update Status (Doctor Only)
- **PATCH** `/api/v1/appointments/:id/status`
- **Body**: `{ "status": "COMPLETED" }`

---

### 📧 Email Notifications
Automated emails are sent for:
- ✅ Appointment Confirmation (with Token & Reporting Time)
- 🔄 Appointment Rescheduling (showing Old vs New time)
- ❌ Appointment Cancellation (notifying who cancelled)

---

### 💡 Scheduling Logic (WAVE)
- **Token System**: Every booking gets a token (1, 2, 3...) based on booking order.
- **Time Distribution**: Slot duration is divided among `maxAppt` to give each patient a dedicated reporting time.
- **Past Date Guard**: Cannot book, reschedule, or set availability for past dates.
