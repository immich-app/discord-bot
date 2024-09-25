import { Body, Controller, Get, Injectable, Param, Post } from '@nestjs/common';
import { WebhookEvent } from '@octokit/webhooks-types';
import { GithubStatusComponent, GithubStatusIncident, StripeBase } from 'src/dtos/webhook.dto';
import { MetricsService } from 'src/services/metrics.service';
import { WebhookService } from 'src/services/webhook.service';

@Injectable()
@Controller('webhooks')
export class WebhookController {
  constructor(
    private service: WebhookService,
    private metrics: MetricsService,
  ) {}

  @Get('test')
  test() {
    return this.metrics.runStars();
  }

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
}
