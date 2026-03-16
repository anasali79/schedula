import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // 1. Get a doctor
  const doctor = await prisma.doctor.findFirst({
    include: { user: true }
  });
  if (!doctor) {
    console.log('No doctor found');
    return;
  }

  console.log(`Using doctor: ${doctor.firstName} (ID: ${doctor.id})`);

  // 2. Set STREAM availability for a specific date (Custom Availability logic)
  const targetDate = new Date();
  targetDate.setUTCDate(targetDate.getUTCDate() + 5); // 5 days from now
  targetDate.setUTCHours(0, 0, 0, 0);
  const dateStr = targetDate.toISOString().split('T')[0];

  console.log(`Setting STREAM availability for ${dateStr} (14:00 - 16:00, maxAppt: 10)`);

  // Cleanup existing for that date
  await prisma.availability.deleteMany({
    where: { doctorId: doctor.id, date: targetDate }
  });

  const avail = await prisma.availability.create({
    data: {
      doctorId: doctor.id,
      date: targetDate,
      scheduleType: 'STREAM',
      consultingStartTime: '14:00',
      consultingEndTime: '16:00',
      maxAppt: 10,
      session: 'Afternoon Stream Test',
      slots: {
        create: [
          {
            startTime: '14:00',
            endTime: '16:00',
            maxAppt: 10
          }
        ]
      }
    },
    include: { slots: true }
  });

  console.log('Availability created:', JSON.stringify(avail, null, 2));

  // 3. Book 3 appointments to check staggered reporting times
  const patient = await prisma.patient.findFirst();
  if (!patient) {
      console.log('No patient found to test booking');
      return;
  }

  const slotId = avail.slots[0].id;

  for (let i = 1; i <= 3; i++) {
      const bookedCount = await prisma.appointment.count({
          where: { slotId, appointmentDate: targetDate, status: 'CONFIRMED' }
      });
      const token = bookedCount + 1;
      
      // Calculate reporting time (reproducing logic from AppointmentsService)
      const startMin = 14 * 60; // 14:00
      const endMin = 16 * 60; // 16:00
      const duration = endMin - startMin;
      const offset = Math.floor(((token - 1) * duration) / 10); // maxAppt: 10
      const reportingMins = startMin + offset;
      const h = Math.floor(reportingMins / 60);
      const m = reportingMins % 60;
      const reportingTime = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;

      console.log(`Booking ${i}: Token ${token} -> Reporting Time: ${reportingTime}`);

      await prisma.appointment.create({
          data: {
              patientId: patient.id,
              doctorId: doctor.id,
              slotId: slotId,
              appointmentDate: targetDate,
              status: 'CONFIRMED',
              notes: `Stream Test ${i}`
          }
      });
  }

  // 4. Cleanup test data
  await prisma.appointment.deleteMany({
      where: { notes: { startsWith: 'Stream Test' } }
  });
  await prisma.availability.delete({ where: { id: avail.id } });

  console.log('Test completed successfully');
}

main().catch(console.error).finally(() => prisma.$disconnect());
