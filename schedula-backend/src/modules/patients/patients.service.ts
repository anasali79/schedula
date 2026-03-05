import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdatePatientDto } from './dto/update-patient.dto';

@Injectable()
export class PatientsService {
    constructor(private readonly prisma: PrismaService) { }

    async getMyProfile(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                role: true,
                isVerified: true,
                patient: true,
            },
        });

        if (!user || user.role !== 'PATIENT') {
            throw new NotFoundException('Patient profile not found');
        }

        return {
            message: 'Patient profile fetched successfully',
            user,
        };
    }

    async updateProfile(userId: string, dto: UpdatePatientDto) {
        const patientUser = await this.prisma.user.findUnique({
            where: { id: userId },
            include: { patient: true },
        });

        if (!patientUser || patientUser.role !== 'PATIENT') {
            throw new NotFoundException('Patient not found');
        }

        const { ...updateData } = dto;
        let dobDate;

        if (updateData.dob) {
            dobDate = new Date(updateData.dob);
        }

        const updatedPatient = await this.prisma.patient.update({
            where: { userId },
            data: {
                ...updateData,
                ...(dobDate && { dob: dobDate }),
            },
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        role: true,
                    },
                },
            },
        });

        return {
            message: 'Patient profile updated successfully',
            patient: updatedPatient,
        };
    }
}
