import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateBrowserSessionDto {
  @ApiProperty({ description: '邮箱或用户名' })
  @IsString()
  @MinLength(1)
  @MaxLength(254)
  login: string;
  @ApiProperty({ description: '账号密码' })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password: string;
  @ApiPropertyOptional({ description: '记住此设备，最长七天', default: false })
  @IsOptional()
  @IsBoolean()
  remember?: boolean;
}
