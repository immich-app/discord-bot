import { Body, Controller, Headers, Injectable, Param, Post, Req, Res } from '@nestjs/common';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { Request, Response } from 'express';
import { GithubStatusComponent, GithubStatusIncident, StripeBase } from 'src/dtos/webhook.dto';
import { FourthwallOrderCreateWebhook, FourthwallOrderUpdateWebhook } from 'src/interfaces/fourthwall.interface';
import { WebhookService } from 'src/services/webhook.service';

@Injectable()
@Controller('webhooks')
export class WebhookController {
  constructor(private service: WebhookService) {}

  @Post('github/:slug')
  async onGithub(
    @Headers('x-github-delivery') id: EmitterWebhookEvent['id'],
    @Headers('x-github-event') name: EmitterWebhookEvent['name'],
    @Body() payload: EmitterWebhookEvent['payload'],
    @Param('slug') slug: string,
  ) {
    await this.service.onGithub({ id, name, payload } as EmitterWebhookEvent, slug);
  }

  @Post('github-status/:slug')
  async onGithubStatus(@Body() dto: GithubStatusIncident | GithubStatusComponent, @Param('slug') slug: string) {
    await this.service.onGithubStatus(dto, slug);
  }

  @Post('stripe-payments/:slug')
  async onStripePayment(@Body() dto: StripeBase, @Param('slug') slug: string) {
    await this.service.onStripePayment(dto, slug);
  }

  @Post('polar-payments/immich-client/:slug')
  async onPolarImmichClientPayment(@Req() request: Request, @Res() response: Response, @Param('slug') slug: string) {
    await this.service.onPolarPayment(request, response, slug, 'immich-client');
  }

  @Post('polar-payments/immich-server/:slug')
  async onPolarImmichServerPayment(@Req() request: Request, @Res() response: Response, @Param('slug') slug: string) {
    await this.service.onPolarPayment(request, response, slug, 'immich-server');
  }

  @Post('fourthwall-order/:slug')
  async onFourthwallOrder(
    @Body() dto: FourthwallOrderCreateWebhook | FourthwallOrderUpdateWebhook,
    @Param('slug') slug: string,
  ) {
    await this.service.onFourthwallOrder(dto, slug);
  }
}
