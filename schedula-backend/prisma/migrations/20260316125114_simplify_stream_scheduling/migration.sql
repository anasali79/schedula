/*
  Warnings:

  - You are about to drop the column `waveInterval` on the `Availability` table. All the data in the column will be lost.
  - You are about to drop the column `waveSize` on the `Availability` table. All the data in the column will be lost.
  - You are about to drop the column `consultationHours` on the `Profile` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('CONFIRMED', 'CANCELLED', 'COMPLETED');

-- AlterTable
ALTER TABLE "Availability" DROP COLUMN "waveInterval",
DROP COLUMN "waveSize";

-- AlterTable
ALTER TABLE "Profile" DROP COLUMN "consultationHours";

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "appointmentDate" TIMESTAMP(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "notes" TEXT,
    "isRescheduled" BOOLEAN NOT NULL DEFAULT false,
    "elasticSlotId" TEXT,
    "originalSlotId" TEXT,
    "checkedInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ElasticSlot" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "availabilityId" TEXT,
    "sessionDate" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "slotDuration" INTEGER NOT NULL,
    "maxPerSlot" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ElasticSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlotAllocation" (
    "id" TEXT NOT NULL,
    "elasticSlotId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlotAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RescheduleQueue" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "notifiedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RescheduleQueue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_patientId_appointmentDate_slotId_key" ON "Appointment"("patientId", "appointmentDate", "slotId");

-- CreateIndex
CREATE INDEX "ElasticSlot_doctorId_sessionDate_idx" ON "ElasticSlot"("doctorId", "sessionDate");

-- CreateIndex
CREATE UNIQUE INDEX "SlotAllocation_appointmentId_key" ON "SlotAllocation"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "RescheduleQueue_appointmentId_key" ON "RescheduleQueue"("appointmentId");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "AvailabilitySlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ElasticSlot" ADD CONSTRAINT "ElasticSlot_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ElasticSlot" ADD CONSTRAINT "ElasticSlot_availabilityId_fkey" FOREIGN KEY ("availabilityId") REFERENCES "Availability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotAllocation" ADD CONSTRAINT "SlotAllocation_elasticSlotId_fkey" FOREIGN KEY ("elasticSlotId") REFERENCES "ElasticSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotAllocation" ADD CONSTRAINT "SlotAllocation_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RescheduleQueue" ADD CONSTRAINT "RescheduleQueue_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
