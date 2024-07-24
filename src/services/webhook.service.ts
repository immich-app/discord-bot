import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Colors, EmbedBuilder } from 'discord.js';
import { getConfig } from 'src/config';
import { GithubStatusComponent, GithubStatusIncident, PaymentIntent, StripeBase } from 'src/dtos/webhook.dto';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import { withErrorLogging } from 'src/util';

const isIncidentUpdate = (dto: GithubStatusComponent | GithubStatusIncident): dto is GithubStatusIncident => {
  return !!(dto as GithubStatusIncident).incident;
};

const isPaymentEvent = (payload: StripeBase): payload is StripeBase<PaymentIntent> =>
  payload.data.object.object === 'payment_intent';

const isImmichProduct = (payload: StripeBase<PaymentIntent>) =>
  ['immich-server', 'immich-client'].includes(payload.data.object.description);

@Injectable()
export class WebhookService {
  private logger = new Logger(WebhookService.name);

  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
  ) {}

  async onGithubStatus(dto: GithubStatusIncident | GithubStatusComponent, slug: string) {
    const { slugs } = getConfig();
    if (!slugs.githubWebhook || slug !== slugs.githubWebhook) {
      throw new UnauthorizedException();
    }

    this.logger.debug(dto);

    if (isIncidentUpdate(dto)) {
      const embed = new EmbedBuilder({
        title: dto.page.status_description,
        author: { name: 'GitHub Status', url: 'https://githubstatus.com' },
        url: dto.incident.shortlink,
        fields: [{ name: dto.incident.name, value: dto.incident.incident_updates[0].body.replaceAll('<br />', '\n') }],
      });

      if (dto.incident.status === 'resolved') {
        embed.setColor('Green');
      } else {
        switch (dto.incident.impact) {
          case 'minor':
            embed.setColor('Orange');
            break;
          case 'major':
            embed.setColor('Red');
            break;
          default:
            embed.setColor('Grey');
        }
      }

      await this.discord.sendMessage(DiscordChannel.GithubStatus, { embeds: [embed] });
    }
  }

  onStripePayment(dto: StripeBase, slug: string) {
    const { slugs } = getConfig();
    if (!slugs.stripeWebhook || slug !== slugs.stripeWebhook) {
      throw new UnauthorizedException();
    }

    if (isPaymentEvent(dto) && isImmichProduct(dto)) {
      void this.handleStripePayment(dto);
    }
  }

  private async handleStripePayment(event: StripeBase<PaymentIntent>) {
    const { id, description, amount, created, currency, status, livemode } = event.data.object;

    await withErrorLogging({
      method: () =>
        this.database.createPayment({
          event_id: event.id,
          id,
          amount,
          currency,
          status,
          description,
          created,
          livemode,
          data: JSON.stringify(event),
        }),
      message: 'Failed to insert payment into database',
      fallbackValue: undefined,
      discord: this.discord,
      logger: this.logger,
    });

    if (status !== 'succeeded') {
      return;
    }

    const { server, client } = await withErrorLogging({
      method: () => this.database.getTotalLicenseCount(),
      message: 'Failed to insert payment into database',
      fallbackValue: { server: 0, client: 0 },
      discord: this.discord,
      logger: this.logger,
    });

    const licenseType = description.split('-')[1];
    await this.discord.sendMessage(DiscordChannel.Stripe, {
      embeds: [
        new EmbedBuilder()
          .setTitle(`${livemode ? '' : 'TEST PAYMENT - '}Immich ${licenseType} license purchased`)
          .setURL(`https://dashboard.stripe.com/${livemode ? '' : 'test/'}payments/${id}`)
          .setAuthor({ name: 'Stripe Payments', url: 'https://stripe.com' })
          .setDescription(`Price: ${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`)
          .setColor(livemode ? Colors.Green : Colors.Yellow)
          .setFields([
            {
              name: 'Server licenses',
              value: `$${(server * 99.99).toFixed(2)} - ${server} licenses`,
              inline: true,
            },
            {
              name: 'Client licenses',
              value: `$${(client * 24.99).toFixed(2)} - ${client} licenses`,
              inline: true,
            },
          ]),
      ],
    });
  }
}
