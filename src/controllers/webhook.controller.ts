import { Body, Controller, Injectable, Param, Post } from '@nestjs/common';
import { WebhookEvent } from '@octokit/webhooks-types';
import { GithubStatusComponent, GithubStatusIncident, StripeBase } from 'src/dtos/webhook.dto';
import { FourthwallOrderCreateWebhook, FourthwallOrderUpdateWebhook } from 'src/interfaces/fourthwall.interface';
import { WebhookService } from 'src/services/webhook.service';

@Injectable()
@Controller('webhooks')
export class WebhookController {
  constructor(private service: WebhookService) {}

  @Post('github/:slug')
  async onGithub(@Body() dto: WebhookEvent, @Param('slug') slug: string) {
    await this.service.onGithub(dto, slug);
  }

  @Post('github-status/:slug')
  async onGithubStatus(@Body() dto: GithubStatusIncident | GithubStatusComponent, @Param('slug') slug: string) {
    await this.service.onGithubStatus(dto, slug);
  }

  @Post('stripe-payments/:slug')
  async onStripePayment(@Body() dto: StripeBase, @Param('slug') slug: string) {
    await this.service.onStripePayment(dto, slug);
  }

  @Post('fourthwall-order/:slug')
  async onFourthwallOrder(
    @Body() dto: FourthwallOrderCreateWebhook | FourthwallOrderUpdateWebhook,
    @Param('slug') slug: string,
  ) {
    await this.service.onFourthwallOrder(dto, slug);
  }
}
