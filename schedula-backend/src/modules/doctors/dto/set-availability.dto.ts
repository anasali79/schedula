import {
    IsArray,
    IsInt,
    IsString,
    Matches,
    Max,
    Min,
    ValidateNested,
    ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class TimeSlotDto {
    @IsString()
    @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
        message: 'startTime must be in HH:mm format (e.g. 13:00 for 1 PM)',
    })
    startTime!: string;

    @IsString()
    @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
        message: 'endTime must be in HH:mm format (e.g. 14:00 for 2 PM)',
    })
    endTime!: string;
}

// Body for PUT /api/v1/doctors/availability/monday
// { "slots": [{ "startTime": "13:00", "endTime": "14:00" }] }
export class SetDaySlotsDto {
    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => TimeSlotDto)
    slots!: TimeSlotDto[];
}

// Used inside SetWeekAvailabilityDto
export class DayScheduleDto {
    @IsString()
    day!: string;

    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => TimeSlotDto)
    slots!: TimeSlotDto[];
}

// Body for PUT /api/v1/doctors/availability
// { "schedule": [{ "day": "monday", "slots": [...] }, { "day": "wednesday", "slots": [...] }] }
export class SetWeekAvailabilityDto {
    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => DayScheduleDto)
    schedule!: DayScheduleDto[];
}
