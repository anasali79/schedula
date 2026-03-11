-- AlterTable
ALTER TABLE "Availability" ADD COLUMN     "waveInterval" INTEGER,
ADD COLUMN     "waveSize" INTEGER,
ALTER COLUMN "maxAppt" SET DEFAULT 0;
