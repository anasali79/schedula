import { IsOptional, IsString, MinLength } from 'class-validator';

export class OnboardDoctorDto {
    @IsString()
    @MinLength(2)
    firstName!: string;

    @IsOptional()
    @IsString()
    lastName?: string;
}
