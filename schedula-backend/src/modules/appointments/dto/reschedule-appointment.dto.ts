import {
    IsNotEmpty,
    IsUUID,
    IsDateString,
} from 'class-validator';

export class RescheduleAppointmentDto {
    @IsUUID()
    @IsNotEmpty()
    slotId!: string;

    @IsDateString()
    @IsNotEmpty()
    appointmentDate!: string; // The NEW date in YYYY-MM-DD format
}
