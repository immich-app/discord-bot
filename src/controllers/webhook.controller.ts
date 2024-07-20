import { Body, Controller, Injectable, Param, Post } from '@nestjs/common';
import { GithubStatusComponent, GithubStatusIncident, StripeBase } from 'src/dtos/webhook.dto';
import { WebhookService } from 'src/services/webhook.service';

@Injectable()
@Controller('webhooks')
export class WebhookController {
  constructor(private service: WebhookService) {}

  @Post('github-status/:slug')
  async onGithubStatus(@Body() dto: GithubStatusIncident | GithubStatusComponent, @Param('slug') slug: string) {
    await this.service.onGithubStatus(dto, slug);
  }

  @Post('stripe-payments/:slug')
  async onStripePayment(@Body() dto: StripeBase, @Param('slug') slug: string) {
    await this.service.onStripePayment(dto, slug);
  }
}
