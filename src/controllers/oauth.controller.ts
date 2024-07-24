import { Body, Controller, Injectable, Post } from '@nestjs/common';
import { OAuthAuthorizeDto, OAuthCallbackDto } from 'src/dtos/oauth.dto';
import { OAuthService } from 'src/services/oauth.service';

@Injectable()
@Controller('oauth')
export class OAuthController {
  constructor(private service: OAuthService) {}

  @Post('authorize')
  authorize(@Body() dto: OAuthAuthorizeDto) {
    return this.service.authorize(dto);
  }

  @Post('callback')
  callback(@Body() dto: OAuthCallbackDto) {
    return this.service.callback(dto);
  }
}
