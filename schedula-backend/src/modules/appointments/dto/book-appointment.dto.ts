import {
    IsNotEmpty,
    IsOptional,
    IsString,
    IsDateString,
    IsUUID,
} from 'class-validator';

export class BookAppointmentDto {
    @IsUUID()
    @IsNotEmpty()
    slotId!: string;

    @IsDateString()
    @IsNotEmpty()
    appointmentDate!: string; // The date in YYYY-MM-DD format

    @IsString()
    @IsOptional()
    notes?: string;
}
