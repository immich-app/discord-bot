import { IsNotEmpty, IsString } from 'class-validator';

export class OAuthAuthorizeDto {
  @IsNotEmpty()
  @IsString()
  redirectUri!: string;
}

export class OAuthCallbackDto {
  @IsNotEmpty()
  @IsString()
  url!: string;
}
