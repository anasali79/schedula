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

export class WaveSlotDto {
    @IsString()
    @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
        message: 'startTime must be in HH:mm format',
    })
    startTime!: string;

    @IsString()
    @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
        message: 'endTime must be in HH:mm format',
    })
    endTime!: string;

    @IsInt()
    @Min(0)
    maxAppt!: number;
}

export class GenerateWaveSlotsDto {
    @IsString()
    @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
        message: 'startTime must be in HH:mm format',
    })
    startTime!: string;

    @IsString()
    @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
        message: 'endTime must be in HH:mm format',
    })
    endTime!: string;

    @IsInt()
    @Min(1)
    slotDuration!: number;

    @IsOptional()
    @IsInt()
    @Min(0)
    totalMaxAppt?: number;
}

export class UpdateWaveSlotsDto {
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => WaveSlotDto)
    slots!: WaveSlotDto[];
}

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

    @IsOptional()
    @IsInt()
    @Min(0)
    maxAppt?: number; // Total capacity for the block

    @IsOptional()
    @IsString()
    session?: string;

    @IsOptional()
    @IsInt()
    @Min(1)
    slotDuration?: number; // Only for WAVE

    @IsOptional()
    @IsInt()
    @Min(1)
    streamInterval?: number; // Only for STREAM

    @IsOptional()
    @IsInt()
    @Min(1)
    streamBatchSize?: number; // Only for STREAM

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => WaveSlotDto)
    slots?: WaveSlotDto[];
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

// Body for POST /api/v1/doctors/custom-availability/:date
// { "availabilities": [...] }
export class SetCustomAvailabilityDto {
    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => AvailabilityConfigDto)
    availabilities!: AvailabilityConfigDto[];
}


