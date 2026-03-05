# Schedula Backend Documentation

Welcome to the **Schedula Backend** repository! Schedula is a comprehensive booking and scheduling application for doctors and patients. This backend provides a robust REST API for managing users, doctor profiles, and complex scheduling functionalities using the **STREAM** and **WAVE** availability systems.

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
cd schedula
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
*Requires JWT Authentication (Cookie or Bearer).*
- **POST** `/auth/onboard/patient`
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

Schedula supports two main scheduling systems:
- **STREAM**: Sets a block of time (e.g., 9:00 to 12:00) with a maximum number of total appointments. No individual time slots are explicitly tracked.
- **WAVE**: Generates distinct, evenly divided time slots based on the `slotDuration`. (e.g. 9:00-9:15, 9:15-9:30, with specific `maxAppt` per generated slot).

#### 1. Get All Availability
- **GET** `/doctors/availability`
- **Response**: Returns an array of availability records grouped by days, along with any generated `slots`.
  ```json
  [
    {
      "id": "abc-123",
      "dayOfWeek": 1,
      "scheduleType": "STREAM",
      "consultingStartTime": "13:00",
      "consultingEndTime": "14:00",
      "maxAppt": 30,
      "slots": []
    }
  ]
  ```

#### 2. Set Availability For a Specific Day (e.g., Monday)
Replaces all existing availabilities for the provided day (`monday`, `tuesday`, `wednesday`, etc.)
- **PUT** `/doctors/availability/:day` (Example: `/doctors/availability/monday`)
- **Body**: Includes an array of availability configurations.
  ```json
  {
    "availabilities": [
      {
        "scheduleType": "STREAM",
        "consultingStartTime": "13:00",
        "consultingEndTime": "14:00",
        "maxAppt": 30,
        "session": "Afternoon"
      },
      {
        "scheduleType": "WAVE",
        "consultingStartTime": "15:00",
        "consultingEndTime": "17:00",
        "maxAppt": 2, 
        "slotDuration": 30,
        "session": "Evening"
      }
    ]
  }
  ```
- **Note**: `slotDuration` is required for `WAVE` scheduling. The system will automatically generate slots of `30` mins. 

#### 3. Set Availability For the Whole Week
Replaces the availability for all the supplied days at once.
- **PUT** `/doctors/availability`
- **Body**:
  ```json
  {
    "schedule": [
      {
        "day": "monday",
        "availabilities": [
          {
            "scheduleType": "STREAM",
            "consultingStartTime": "10:00",
            "consultingEndTime": "12:00",
            "maxAppt": 10
          }
        ]
      },
      {
        "day": "wednesday",
        "availabilities": [
          {
            "scheduleType": "WAVE",
            "consultingStartTime": "09:00",
            "consultingEndTime": "11:00",
            "maxAppt": 1,
            "slotDuration": 15
          }
        ]
      }
    ]
  }
  ```
- **Response**: `{ "message": "Week availability synced successfully.", "count": 2 }`

#### 4. Delete Entire Day's Availability
Deletes all availability blocks & slots for a given day.
- **DELETE** `/doctors/availability/:day` (Example: `/doctors/availability/monday`)
- **Response**: `{ "message": "Availability for monday deleted." }`

#### 5. Delete a Specific Slot / Time Block
Deletes a specific `Availability` block or an individual `AvailabilitySlot` (WAVE slot) using its ID.
- **DELETE** `/doctors/availability/slot/:slotId`
- **Response**: `{ "message": "Slot or availability block deleted successfully." }`
