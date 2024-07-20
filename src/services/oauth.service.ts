import { BadRequestException, Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { Issuer, generators } from 'openid-client';
import { config } from 'src/config';
import { OAuthAuthorizeDto, OAuthCallbackDto } from 'src/dtos/oauth.dto';
import { IDatabaseRepository } from 'src/interfaces/database.interface';

type GithubProfile = {
  login: string;
  id: string;
  avatar_url: string;
  url: string;
  type: 'User';
  name: string;
  created_at: string;
  updated_at: string;
};

const issuer = new Issuer({
  issuer: 'https://github.com',
  authorization_endpoint: 'https://github.com/login/oauth/authorize',
  token_endpoint: 'https://github.com/login/oauth/access_token',
  userinfo_endpoint: 'https://api.github.com/user',
});

const client = new issuer.Client({
  client_id: config.github.clientId,
  client_secret: config.github.clientSecret,
});

type StateItem = { value: string; expiresAt: number };
const stateMap = new Map<string, StateItem>();

@Injectable()
export class OAuthService {
  private logger: Logger = new Logger(OAuthService.name);

  constructor(@Inject(IDatabaseRepository) private database: IDatabaseRepository) {}

  authorize(dto: OAuthAuthorizeDto) {
    const state = generators.state();
    stateMap.set(state, { value: state, expiresAt: Date.now() + 5 * 60 * 1000 });
    return {
      url: client.authorizationUrl({
        state,
        scope: 'openid profile email',
        redirect_uri: dto.redirectUri,
      }),
    };
  }

  async callback({ url }: OAuthCallbackDto) {
    try {
      const redirectUri = new URL(url).origin + '/claim/callback';
      const params = client.callbackParams(url);

      if (!params.state || !stateMap.has(params.state)) {
        throw new BadRequestException('Invalid state parameter');
      }

      const stateItem = stateMap.get(params.state);
      if (!stateItem || stateItem.expiresAt < Date.now()) {
        throw new BadRequestException('Invalid state parameter');
      }

      const tokens = await client.oauthCallback(redirectUri, params, { state: stateItem.value });
      const profile = await client.userinfo<GithubProfile>(tokens);

      const licenses = await this.database.getSponsorLicenses(profile.login);

      return {
        username: profile.login,
        imageUrl: profile.avatar_url,
        licenses,
      };
    } catch (error: Error | AggregateError | unknown) {
      this.logger.error(error, (error as Error)?.stack, (error as AggregateError)?.errors);
      throw new InternalServerErrorException('An error occurred while processing the request');
    }
  }
}
