import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class OnboardPatientDto {
    @IsString()
    @IsNotEmpty()
    firstName!: string;

    @IsString()
    @IsOptional()
    lastName?: string;
}
