
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  try {
    const appointments = await prisma.appointment.findMany({
      include: { slot: true }
    });
    console.log('--- Appointments ---');
    appointments.forEach((a: any) => {
      console.log(`ID: ${a.id}, Date: ${a.appointmentDate.toISOString()}, SlotId: ${a.slotId}, Status: ${a.status}`);
    });

    const slots = await prisma.availabilitySlot.findMany({
        include: { availability: true }
    });
    console.log('\n--- Slots ---');
    slots.forEach((s: any) => {
      console.log(`ID: ${s.id}, Start: ${s.startTime}, Max: ${s.maxAppt}, AvailID: ${s.availabilityId}, AvailDate: ${s.availability.date ? s.availability.date.toISOString() : 'TEMPLATE'}`);
    });

    const avails = await prisma.availability.findMany();
    console.log('\n--- Availabilities ---');
    avails.forEach((av: any) => {
        console.log(`ID: ${av.id}, Date: ${av.date ? av.date.toISOString() : 'TEMPLATE'}, Type: ${av.scheduleType}`);
    });

  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
