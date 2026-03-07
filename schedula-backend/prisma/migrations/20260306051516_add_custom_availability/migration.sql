-- AlterTable
ALTER TABLE "Availability" ADD COLUMN     "date" TIMESTAMP(3),
ALTER COLUMN "dayOfWeek" DROP NOT NULL;
