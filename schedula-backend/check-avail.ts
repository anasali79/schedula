
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const id = '6ef598ab-2a73-4474-9f3f-4d8e906b520a';
  const avail = await prisma.availability.findUnique({ where: { id } });
  console.log('Availability:', JSON.stringify(avail, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
