import express from 'express';
import { bot } from '../../main.js';
import { Constants } from '../../constants.js';
import { Colors, EmbedBuilder, TextChannel } from 'discord.js';
import { db } from '../../db.js';
import { logError } from '../../util';

const app = express.Router();

type StripeBase<T = unknown> = {
  id: string;
  object: string;
  type: string;
  data: {
    object: {
      id: string;
      object: string;
    } & T;
  };
};

type PaymentIntent = {
  amount: number;
  currency: string;
  created: number;
  description: string;
  status: string;
  receipt_email: string;
  livemode: boolean;
};

const isPaymentEvent = (payload: StripeBase): payload is StripeBase<PaymentIntent> =>
  payload.data.object.object === 'payment_intent';

const isImmichProduct = (payload: StripeBase<PaymentIntent>) =>
  ['immich-server', 'immich-client'].includes(payload.data.object.description);

async function writePaymentToDb(event: StripeBase<PaymentIntent>) {
  const { id, description, amount, currency, status, created, livemode } = event.data.object;

  try {
    await db
      .insertInto('payments')
      .values({
        event_id: event.id,
        id,
        amount,
        currency,
        status,
        description,
        created,
        livemode,
        data: JSON.stringify(event),
      })
      .execute();
  } catch (error) {
    await logError('Failed to insert payment into database', error, bot);
  }
}

async function getTotalLicenseCount() {
  try {
    const result = await db
      .selectFrom('payments')
      .select([(b) => b.fn.count<number>('description').as('product_count'), 'description'])
      .where('livemode', '=', true)
      .where('status', '=', 'succeeded')
      .groupBy('description')
      .execute();

    return {
      server: result.find((r) => r.description === 'immich-server')?.product_count || 0,
      client: result.find((r) => r.description === 'immich-client')?.product_count || 0,
    };
  } catch (error) {
    await logError('Failed to insert payment into database', error, bot);
    return {
      server: 0,
      client: 0,
    };
  }
}

app.post('/stripe-payments/:slug', async (req, res) => {
  if (req.params.slug !== process.env.STRIPE_PAYMENT_SLUG) {
    res.status(401).send();
    return;
  }

  res.status(204).send();

  if (!isPaymentEvent(req.body) || !isImmichProduct(req.body)) {
    return;
  }
  const { id, description, amount, currency, status, livemode } = req.body.data.object;

  void writePaymentToDb(req.body);

  if (status !== 'succeeded') {
    return;
  }

  const { server, client } = await getTotalLicenseCount();

  const licenseType = description.split('-')[1];
  const channel = (await bot.channels.fetch(Constants.Channels.Stripe)) as TextChannel;
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(`${livemode ? '' : 'TEST PAYMENT - '}Immich ${licenseType} license purchased`)
        .setURL(`https://dashboard.stripe.com/${livemode ? '' : 'test/'}payments/${id}`)
        .setAuthor({ name: 'Stripe Payments', url: 'https://stripe.com' })
        .setDescription(`Price: ${(amount / 100).toFixed(2)} ${currency}`)
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
});

export const stripeWebhooks = app;
