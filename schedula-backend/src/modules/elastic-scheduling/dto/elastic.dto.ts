import { IsString, IsInt, IsOptional, Matches, Min } from 'class-validator';

export class ExpandSessionDto {
  @IsString()
  availabilityId!: string;

  @IsString()
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'newStartTime must be in HH:mm format',
  })
  newStartTime?: string;

  @IsString()
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'newEndTime must be in HH:mm format',
  })
  newEndTime?: string;

  @IsInt()
  @IsOptional()
  @Min(1)
  newMaxPerSlot?: number;
}

export class ShrinkSessionDto {
  @IsString()
  availabilityId!: string;

  @IsString()
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'newStartTime must be in HH:mm format',
  })
  newStartTime?: string;

  @IsString()
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'newEndTime must be in HH:mm format',
  })
  newEndTime?: string;
}
