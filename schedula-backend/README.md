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

Below is the comprehensive list of all API endpoints available in the application.

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
- **Response**: `{ "user": { "id", "email", "provider" }, "tokens": { "accessToken", "refreshToken" } }`

#### 2. Signin
- **POST** `/auth/signin`
- **Body**:
  ```json
  {
    "email": "user@example.com",
    "password": "Password123!"
  }
  ```
- **Response**: `{ "user": { ... }, "tokens": { "accessToken", "refreshToken" } }`

#### 3. Email Verification
- **GET** `/auth/verify-email?token=...`
- **POST** `/auth/verify-email` (Accepts `{ "token": "..." }`)
- **Response**: `{ "message": "Email verified successfully" }`

#### 4. Onboard Patient
*Requires JWT Authentication.*
- **POST** `/auth/onboard/patient`
- **Body**:
  ```json
  {
    "firstName": "Jane",
    "lastName": "Doe"
  }
  ```
- **Response**: `{ "user": { "role": "PATIENT" }, "tokens": { ... } }`

#### 5. Onboard Doctor
*Requires JWT Authentication.*
- **POST** `/auth/onboard/doctor`
- **Body**:
  ```json
  {
    "firstName": "John",
    "lastName": "Doe"
  }
  ```
- **Response**: `{ "user": { "role": "DOCTOR" }, "doctor": { "id", "firstName" }, "tokens": { ... } }`


#### 6. Google OAuth
- **GET** `/auth/google` (Redirects to Google Sign-In)
- **GET** `/auth/google/callback` (Handles Google redirect & sets auth cookies)

#### 7. Delete User
*Requires JWT Authentication.*
- **DELETE** `/auth/delete/user`
- **Response**: `{ "message": "User deleted successfully" }`

---

### 🧥 Patient Management (`/patients`)
*Requires JWT Authentication and `Role = PATIENT`.*

#### 1. Get My Profile
- **GET** `/patients/me`
- **Response**: Returns the user object with associated patient profile.

#### 2. Update Profile
- **PUT** `/patients/profile`
- **Body**:
  ```json
  {
    "firstName": "Jane",
    "lastName": "Doe",
    "phone": "+1234567890",
    "dob": "1995-05-15",
    "gender": "Female",
    "bloodGroup": "O+",
    "address": "123 Main St, City"
  }
  ```

---

### 👨‍⚕️ Doctor Management (`/doctors`)
*Requires JWT Authentication and `Role = DOCTOR`.*

#### 1. Get My Profile
- **GET** `/doctors/me`
- **Response**: Returns the complete user object, associated doctor record, profile, specializations, and availability.

#### 2. Update Profile
- **PUT** `/doctors/profile`
- **Body**:
  ```json
  {
    "bio": "Experienced cardiologist.",
    "experienceYears": 10,
    "consultationFee": 50.00
  }
  ```

#### 3. Add Specialization
- **POST** `/doctors/specialization`
- **Body**:
  ```json
  {
    "name": "Cardiology"
  }
  ```

---

### 📅 Doctor Availability Management

Schedula supports a **Hybrid** scheduling system (Recurring + Custom) with two modes:

- **WAVE**: Generates distinct, fixed-duration slots (e.g., 30 min) where each slot has a specific capacity (`maxAppt`). Ideal for structured appointments.
- **STREAM**: Represents a continuous block of time or larger batches (intervals) where patients are managed in a flow/queue system.

#### 1. Get All Availability
- **GET** `/api/v1/doctors/availability`
- **Response**: Returns recurring weekly schedule AND `customs` (date-specific) entries.

#### 2. Set Weekly Recurring Availability
Replaces all existing availabilities for the provided day (`monday`, `tuesday`, etc.)
- **PUT** `/api/v1/doctors/availability/:day`
- **Example (WAVE)**: 09:00 - 12:00 with 30 min slots (6 slots total, each allowing 5 patients).
  ```json
  {
    "availabilities": [
      {
        "scheduleType": "WAVE",
        "consultingStartTime": "09:00",
        "consultingEndTime": "12:00",
        "slotDuration": 30,
        "maxAppt": 5,
        "session": "Morning Clinic"
      }
    ]
  }
  ```

#### 3. Set Custom Date Availability (Hybrid Sync)
Sets availability for a specific date. **Note**: This will also update the weekly template for that day.
- **POST** `/api/v1/doctors/custom-availability/:date` (Example: `/2026-03-25`)
- **Example (STREAM)**: 09:00 - 12:00 with 60 min batches (Total 3 batches, 15 patients).
  ```json
  {
    "availabilities": [
      {
        "scheduleType": "STREAM",
        "consultingStartTime": "09:00",
        "consultingEndTime": "12:00",
        "streamInterval": 60,
        "streamBatchSize": 5,
        "session": "Morning Stream"
      }
    ]
  }
  ```

#### 4. Delete Availabilities
- **DELETE** `/api/v1/doctors/availability/:day` (Delete recurring day)
- **DELETE** `/api/v1/doctors/custom-availability/:date` (Delete custom date)
- **DELETE** `/api/v1/doctors/availability/slot/:slotId` (Delete single unit/slot)

---

### 💡 Scheduling Rules:
- **WAVE**: Requires `slotDuration` and `maxAppt` (Capacity per slot).
- **STREAM**: Requires `maxAppt` (Capacity per block). Can optionally use `streamInterval` and `streamBatchSize`.
- **Restrictions**: 
    - Cannot set availability for past dates.
    - Cannot set availability for future years (must stay within current year).
    - URL date must be in `YYYY-MM-DD` format.
