import { BadRequestException, Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
// @ts-expect-error f'ing ts does not let you import types from esm
import type { Configuration, ServerMetadata } from 'openid-client';
// @ts-expect-error we have the experimental flag enabled so we can import esm packages
import client from 'openid-client';
import { getConfig } from 'src/config';
import { OAuthAuthorizeDto, OAuthCallbackDto } from 'src/dtos/oauth.dto';
import { IDatabaseRepository } from 'src/interfaces/database.interface';

type StateItem = { value: string; expiresAt: number };
const stateMap = new Map<string, StateItem>();

@Injectable()
export class OAuthService {
  private logger: Logger = new Logger(OAuthService.name);
  private config: Configuration;

  constructor(@Inject(IDatabaseRepository) private database: IDatabaseRepository) {
    const { github } = getConfig();
    const server: ServerMetadata = {
      issuer: 'https://github.com',
      authorization_endpoint: 'https://github.com/login/oauth/authorize',
      token_endpoint: 'https://github.com/login/oauth/access_token',
      userinfo_endpoint: 'https://api.github.com/user',
    };

    this.config = new client.Configuration(server, github.clientId, github.clientSecret);
  }

  authorize(dto: OAuthAuthorizeDto) {
    const state = client.randomState();
    stateMap.set(state, { value: state, expiresAt: Date.now() + 5 * 60 * 1000 });
    return {
      url: client.buildAuthorizationUrl(this.config, {
        state,
        scope: 'openid profile email',
        redirect_uri: dto.redirectUri,
      }),
    };
  }

  async callback({ url }: OAuthCallbackDto) {
    try {
      const currentUrl = new URL(url);
      const state = currentUrl.searchParams.get('state');

      if (!state || !stateMap.has(state)) {
        throw new BadRequestException('Invalid state parameter');
      }

      const stateItem = stateMap.get(state);
      if (!stateItem || stateItem.expiresAt < Date.now()) {
        throw new BadRequestException('Invalid state parameter');
      }

      const tokens = await client.authorizationCodeGrant(this.config, currentUrl, {
        expectedState: stateItem.value,
      });
      const profile = await client.fetchUserInfo(this.config, tokens.access_token, tokens.claims()?.sub || '');
      const login = profile.login as string;
      const avatarUrl = profile.avatar_Url as string;

      if (!login || !avatarUrl) {
        throw new Error('Could not fetch user info');
      }

      const licenses = await this.database.getSponsorLicenses(login);

      return {
        username: login,
        imageUrl: avatarUrl,
        licenses,
      };
    } catch (error: Error | AggregateError | unknown) {
      this.logger.error(error, (error as Error)?.stack, (error as AggregateError)?.errors);
      throw new InternalServerErrorException('An error occurred while processing the request');
    }
  }
}
