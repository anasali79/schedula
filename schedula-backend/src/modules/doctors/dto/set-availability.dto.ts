import {
    IsArray,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Min,
    ValidateNested,
    ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ScheduleType } from '@prisma/client';

export class AvailabilityConfigDto {
    @IsEnum(ScheduleType)
    scheduleType!: ScheduleType;

    @IsString()
    @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
        message: 'consultingStartTime must be in HH:mm format (e.g. 13:00 for 1 PM)',
    })
    consultingStartTime!: string;

    @IsString()
    @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
        message: 'consultingEndTime must be in HH:mm format (e.g. 14:00 for 2 PM)',
    })
    consultingEndTime!: string;

    @IsInt()
    @Min(1)
    maxAppt!: number;

    @IsOptional()
    @IsString()
    session?: string;

    @IsOptional()
    @IsInt()
    @Min(1)
    slotDuration?: number;
}


// Body for PUT /api/v1/doctors/availability/monday
// { "availabilities": [{ "scheduleType": "STREAM", "consultingStartTime": "13:00", "consultingEndTime": "14:00", "maxAppt": 30 }] }
export class SetDaySlotsDto {
    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => AvailabilityConfigDto)
    availabilities!: AvailabilityConfigDto[];
}

// Used inside SetWeekAvailabilityDto
export class DayScheduleDto {
    @IsString()
    day!: string;

    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => AvailabilityConfigDto)
    availabilities!: AvailabilityConfigDto[];
}

// Body for PUT /api/v1/doctors/availability
// { "schedule": [{ "day": "monday", "availabilities": [...] }, { "day": "wednesday", "availabilities": [...] }] }
export class SetWeekAvailabilityDto {
    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => DayScheduleDto)
    schedule!: DayScheduleDto[];
}
